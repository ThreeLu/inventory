"""本地的假 GitHub：只实现网页和 tools/import_items.py 用到的几个接口，让自动测试不需要真实令牌。

数据都在内存里：blob（内容）、tree（路径 → blob）、commit（tree + 父提交）、main 分支指向的提交。
和真的一样：更新分支时父提交不是最新的，返回 422。
"""

import base64
import hashlib
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class FakeRepo:
    def __init__(self, files):
        self.lock = threading.Lock()
        self.blobs, self.trees, self.commits = {}, {}, {}
        tree = {path: self.put_blob(data) for path, data in files.items()}
        self.head = self.put_commit(self.put_tree(tree), None, "init")

    @staticmethod
    def sha(kind, data):
        return hashlib.sha1(kind.encode() + b"\0" + data).hexdigest()

    def put_blob(self, data: bytes):
        sha = self.sha("blob", data)
        self.blobs[sha] = data
        return sha

    def put_tree(self, tree):
        sha = self.sha("tree", json.dumps(tree, sort_keys=True).encode())
        self.trees[sha] = dict(tree)
        return sha

    def put_commit(self, tree, parent, message):
        sha = self.sha("commit", f"{tree}{parent}{message}{len(self.commits)}".encode())
        self.commits[sha] = {"tree": tree, "parent": parent, "message": message}
        return sha

    def read(self, path, ref="main"):
        commit = self.head if ref == "main" else ref
        blob = self.trees[self.commits[commit]["tree"]].get(path)
        return None if blob is None else self.blobs[blob]

    # 测试里直接改数据，模拟「另一台设备刚提交过」
    def external_write(self, path, data: bytes, message="外部修改"):
        with self.lock:
            tree = dict(self.trees[self.commits[self.head]["tree"]])
            tree[path] = self.put_blob(data)
            self.head = self.put_commit(self.put_tree(tree), self.head, message)


def make_handler(repo: FakeRepo):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "authorization, content-type, accept, x-github-api-version")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")

        def reply(self, status, body=None, raw=None):
            self.send_response(status)
            self.cors()
            data = raw if raw is not None else json.dumps(body or {}).encode()
            self.send_header("Content-Type", "application/octet-stream" if raw is not None else "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def body(self):
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}")

        def do_OPTIONS(self):
            self.reply(204, raw=b"")

        def do_GET(self):
            path, _, query = self.path.partition("?")
            if not self.headers.get("Authorization"):
                return self.reply(401, {"message": "Bad credentials"})
            if re.search(r"/git/ref/heads/main$", path):
                return self.reply(200, {"object": {"sha": repo.head}})
            m = re.search(r"/git/commits/(\w+)$", path)
            if m:
                c = repo.commits.get(m.group(1))
                return self.reply(200, {"sha": m.group(1), "tree": {"sha": c["tree"]}}) if c else self.reply(404)
            m = re.search(r"/repos/[^/]+/[^/]+/contents/(.+)$", path)
            if m:
                from urllib.parse import unquote, parse_qs
                ref = parse_qs(query).get("ref", ["main"])[0]
                data = repo.read(unquote(m.group(1)), ref)
                return self.reply(404, {"message": "Not Found"}) if data is None else self.reply(200, raw=data)
            self.reply(404, {"message": "Not Found"})

        def do_POST(self):
            b = self.body()
            with repo.lock:
                if self.path.endswith("/git/blobs"):
                    return self.reply(201, {"sha": repo.put_blob(base64.b64decode(b["content"]))})
                if self.path.endswith("/git/trees"):
                    tree = dict(repo.trees[b["base_tree"]])
                    for e in b["tree"]:
                        if e.get("sha", "x") is None:
                            tree.pop(e["path"], None)
                        elif "content" in e:
                            tree[e["path"]] = repo.put_blob(e["content"].encode())
                        else:
                            tree[e["path"]] = e["sha"]
                    return self.reply(201, {"sha": repo.put_tree(tree)})
                if self.path.endswith("/git/commits"):
                    return self.reply(201, {"sha": repo.put_commit(b["tree"], b["parents"][0], b["message"])})
            self.reply(404)

        def do_PATCH(self):
            b = self.body()
            with repo.lock:
                if self.path.endswith("/git/refs/heads/main"):
                    if repo.commits[b["sha"]]["parent"] != repo.head and not b.get("force"):
                        return self.reply(422, {"message": "Update is not a fast forward"})
                    repo.head = b["sha"]
                    return self.reply(200, {"object": {"sha": repo.head}})
            self.reply(404)

    return Handler


def serve(repo: FakeRepo, port: int):
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(repo))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
