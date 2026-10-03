"""按录入清单（manifest.json）批量建档，在 Mac 上由 Claude Code 运行。

照片在本机压缩后，通过 GitHub API 直接写进私有数据仓库，整批作为一次提交（要么全成功，要么都不写）。
本地不留数据仓库的副本。

    python3 tools/import_items.py <清单路径> --dry-run   # 只检查，不写入
    python3 tools/import_items.py <清单路径>             # 实际录入
    python3 tools/import_items.py --options              # 列出现有的位置和标签

令牌：默认用 `gh auth token`（GitHub CLI 已登录的账号），也可以设环境变量 GITHUB_TOKEN。
依赖：Pillow（pip install pillow）；HEIC 照片用 macOS 自带的 sips 先转成 JPG。
"""

import argparse
import base64
import io
import json
import os
import re
import secrets
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageOps

REPO = "ThreeLu/inventory-data"
DATA_FILE = "inventory.json"
ASSET_MAX = 899999
PHOTO_TYPES = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}
TEXT_FIELDS = ["description", "manufacturer", "modelNumber", "serialNumber", "purchaseDate",
               "purchaseFrom", "warrantyExpires", "notes"]
# python.org 版的 Python 在 Mac 上默认找不到系统证书，优先用 certifi 的证书
try:
    import certifi
    _ssl = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _ssl = ssl.create_default_context()
_opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=_ssl))


class ImportError_(Exception):
    pass


# ---------- GitHub API ----------

class GitHub:
    def __init__(self, repo, token):
        self.repo = repo
        self.token = token

    def request(self, method, path, body=None, raw=False):
        req = urllib.request.Request(
            f"https://api.github.com/repos/{self.repo}{path}", method=method,
            data=json.dumps(body).encode() if body is not None else None)
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("Accept", "application/vnd.github.raw" if raw else "application/vnd.github+json")
        req.add_header("X-GitHub-Api-Version", "2022-11-28")
        if body is not None:
            req.add_header("Content-Type", "application/json")
        for attempt in range(4):
            try:
                with _opener.open(req) as resp:
                    data = resp.read()
                break
            except urllib.error.HTTPError as e:
                err = ImportError_(f"GitHub {method} {path} 失败：{e.code} {e.read().decode(errors='replace')[:300]}")
                err.status = e.code
                raise err from None
            except (urllib.error.URLError, ConnectionError, ssl.SSLError) as e:
                # 网络或代理偶尔断开：等一下重试（blob、tree 按内容寻址，重复提交无副作用）
                if attempt == 3:
                    raise ImportError_(f"连不上 GitHub：{getattr(e, 'reason', e)}") from None
                time.sleep(2 ** attempt)
        if raw:
            return data
        return json.loads(data) if data else None

    def head(self):
        return self.request("GET", "/git/ref/heads/main")["object"]["sha"]

    def read_data(self, ref):
        return json.loads(self.request("GET", f"/contents/{DATA_FILE}?ref={ref}", raw=True))

    def blob(self, data: bytes):
        return self.request("POST", "/git/blobs", {"content": base64.b64encode(data).decode(), "encoding": "base64"})["sha"]

    def commit(self, parent, files, message):
        base_tree = self.request("GET", f"/git/commits/{parent}")["tree"]["sha"]
        tree = self.request("POST", "/git/trees", {"base_tree": base_tree, "tree": [
            {"path": f["path"], "mode": "100644", "type": "blob", **({"sha": f["sha"]} if "sha" in f else {"content": f["content"]})}
            for f in files]})["sha"]
        sha = self.request("POST", "/git/commits", {"message": message, "tree": tree, "parents": [parent]})["sha"]
        self.request("PATCH", "/git/refs/heads/main", {"sha": sha, "force": False})
        return sha


def get_token():
    if os.environ.get("GITHUB_TOKEN"):
        return os.environ["GITHUB_TOKEN"]
    try:
        return subprocess.check_output(["gh", "auth", "token"], text=True).strip()
    except (OSError, subprocess.CalledProcessError):
        raise ImportError_("拿不到 GitHub 令牌：请先运行 gh auth login，或设置环境变量 GITHUB_TOKEN") from None


# ---------- 数据 ----------

def normalize_asset_id(value):
    if value is None or str(value).strip() == "":
        return None
    digits = re.sub(r"[\s-]", "", str(value))
    if not digits.isdigit() or len(digits) > 6:
        raise ImportError_(f"编号格式不对：{value}（应该像 000-123）")
    n = int(digits)
    if not 1 <= n <= ASSET_MAX:
        raise ImportError_(f"编号 {value} 超出范围（000-001 ~ 899-999）")
    s = f"{n:06d}"
    return f"{s[:3]}-{s[3:]}"


def needs_label(data, tags):
    """第一个标签是「不贴标签」的类别（衣服、鞋……）就不给编号。"""
    return not (tags and tags[0] in data.get("unlabeledTags", []))


def prefix_for(data, tags):
    return (data.get("tagCodes") or {}).get(tags[0], "000") if tags else "000"


def next_in_prefix(data, prefix, taken=()):
    nums = [int(x["assetId"][4:]) for x in data["items"] + data["locations"] if (x.get("assetId") or "").startswith(prefix + "-")]
    nums += [int(a[4:]) for a in taken if a.startswith(prefix + "-")]
    n = max(nums, default=0) + 1
    if n > 999:
        raise ImportError_(f"编号 {prefix}-xxx 已经用完了")
    return f"{prefix}-{n:03d}"


def location_paths(data):
    by_id = {l["id"]: l for l in data["locations"]}

    def path(loc):
        parts = []
        while loc:
            parts.insert(0, loc["name"])
            loc = by_id.get(loc["parent"])
        return " / ".join(parts)

    return {l["id"]: path(l) for l in data["locations"]}


def resolve_location(query, paths):
    """完整名称、中文部分（空格前）、路径或名称的一部分都可以，但必须唯一。"""
    q = query.strip()
    for match in (
        lambda p: p.split(" / ")[-1] == q,
        lambda p: p.split(" / ")[-1].split(" ")[0] == q,
        lambda p: p == q,
        lambda p: q in p.split(" / ")[-1],
    ):
        hits = [i for i, p in paths.items() if match(p)]
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            raise ImportError_(f"位置「{q}」匹配到多个：{', '.join(paths[h] for h in hits)}，请写完整一点")
    raise ImportError_(f"找不到位置「{q}」")


def check(manifest, base_dir, data):
    """检查清单。返回 (待录入条目, 错误列表)。条目上附带 _location / _files。"""
    errors, pending, seen = [], [], {}
    paths = location_paths(data)
    used = {x["assetId"]: x["name"] for x in data["items"] + data["locations"] if x.get("assetId")}
    for n, item in enumerate(manifest.get("items", []), start=1):
        if item.get("id"):
            continue  # 之前已经录入过
        label = f"第 {n} 件「{item.get('name') or '?'}」"
        if not str(item.get("name") or "").strip():
            errors.append(f"{label}：缺少名称")
        try:
            loc = item.get("location") or manifest.get("location")
            if not loc:
                raise ImportError_("没有指定位置")
            item["_location"] = resolve_location(loc, paths)
        except ImportError_ as e:
            errors.append(f"{label}：{e}")
        unknown = [t for t in item.get("tags", []) if t not in data["tags"]]
        if unknown:
            errors.append(f"{label}：没有这些标签 {unknown}。可用：{'、'.join(data['tags'])}")
        try:
            asset = normalize_asset_id(item.get("assetId"))
            item["assetId"] = asset
            # 没写编号：要贴标签的类别在写入时按类别自动给号（noLabel: true 可以跳过）
            item["_auto"] = not asset and not item.get("noLabel") and needs_label(data, item.get("tags", []))
            if asset in used:
                errors.append(f"{label}：编号 {asset} 已经被「{used[asset]}」用了")
            elif asset in seen:
                errors.append(f"{label}：编号 {asset} 和第 {seen[asset]} 件重复")
            if asset:
                seen[asset] = n
        except ImportError_ as e:
            errors.append(f"{label}：{e}")
        files = []
        for kind in ("photos", "receipts"):
            for name in item.get(kind, []):
                p = (base_dir / name)
                if not p.exists():
                    errors.append(f"{label}：找不到照片 {name}")
                elif p.suffix.lower() not in PHOTO_TYPES:
                    errors.append(f"{label}：{name} 不是支持的图片格式")
                else:
                    files.append((kind, p))
        item["_files"] = files
        for key in ("quantity", "purchasePrice"):
            if item.get(key) not in (None, "") and not isinstance(item[key], (int, float)):
                errors.append(f"{label}：{key} 应该是数字")
        item["_paths"] = paths
        pending.append(item)
    return pending, errors


def compress(path: Path, max_side, quality):
    """按 EXIF 方向转正、缩到长边 max_side、转 JPEG。HEIC 先用 sips 转。"""
    src = path
    tmp = None
    if path.suffix.lower() in (".heic", ".heif"):
        tmp = Path(tempfile.mkstemp(suffix=".jpg")[1])
        subprocess.run(["sips", "-s", "format", "jpeg", str(path), "--out", str(tmp)], check=True, capture_output=True)
        src = tmp
    try:
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            im.thumbnail((max_side, max_side))
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=quality, optimize=True)
            return buf.getvalue()
    finally:
        if tmp:
            tmp.unlink(missing_ok=True)


def build_record(item, item_id, photo_entries, now):
    rec = {
        "id": item_id, "name": item["name"].strip(), "assetId": item.get("assetId"),
        "location": item["_location"], "tags": item.get("tags", []),
        "quantity": item.get("quantity") or 1,
        "fields": {k: str(v).strip() for k, v in (item.get("fields") or {}).items() if str(v).strip()},
        "photos": photo_entries["photos"], "receipts": photo_entries["receipts"],
        "purchasePrice": item.get("purchasePrice") if item.get("purchasePrice") not in ("", None) else None,
        "archived": False, "createdAt": now, "updatedAt": now,
    }
    if rec["assetId"]:
        rec["labelPrinted"] = False
    for key in TEXT_FIELDS:
        rec[key] = str(item.get(key) or "").strip()
    return rec


def save_manifest(path, manifest):
    clean = {k: v for k, v in manifest.items() if k != "items"}
    clean["items"] = [{k: v for k, v in it.items() if not k.startswith("_")} for it in manifest["items"]]
    path.write_text(json.dumps(clean, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("manifest", type=Path, nargs="?")
    parser.add_argument("--options", action="store_true", help="列出现有的位置和标签")
    parser.add_argument("--dry-run", action="store_true", help="只检查，不写入")
    parser.add_argument("--repo", default=REPO)
    args = parser.parse_args()

    gh = GitHub(args.repo, get_token())
    head = gh.head()
    data = gh.read_data(head)
    if args.options:
        print("位置：")
        for path in sorted(location_paths(data).values()):
            print(f"  {path}")
        print("标签：" + "、".join(data["tags"]))
        print("字段建议：" + "；".join(f"{t}→{'、'.join(f)}" for t, f in data.get("fieldPresets", {}).items()))
        used = sorted(x["assetId"] for x in data["items"] + data["locations"] if x.get("assetId"))
        print(f"已用编号：{len(used)} 个，最大 {used[-1] if used else '无'}")
        return
    if not args.manifest:
        parser.error("请给出清单路径，或用 --options")
    manifest_path = args.manifest.resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))

    pending, errors = check(manifest, manifest_path.parent, data)
    if errors:
        print(f"清单有 {len(errors)} 个问题，没有写入任何数据：")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    done = len(manifest.get("items", [])) - len(pending)
    print(f"检查通过：待录入 {len(pending)} 件" + (f"，之前已录入 {done} 件（跳过）" if done else ""))
    for it in pending:
        kinds = [k for k, _ in it["_files"]]
        extra = f"，发票 {kinds.count('receipts')} 张" if "receipts" in kinds else ""
        shown = it.get("assetId") or (f"{prefix_for(data, it.get('tags', []))}-自动" if it["_auto"] else "（无编号）")
        print(f"  {shown:>10}  {it['name']}  →  {it['_paths'][it['_location']]}"
              f"  [{'、'.join(it.get('tags', []))}]  照片 {kinds.count('photos')} 张{extra}")
    if args.dry_run or not pending:
        return

    # 压缩照片并上传成 blob（和提交分开，提交失败重试时不用重新上传）
    uploads, records = [], []
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    total = sum(len(it["_files"]) for it in pending)
    done_files = 0
    for it in pending:
        item_id = "i" + secrets.token_hex(5)
        entries = {"photos": [], "receipts": []}
        for kind, path in it["_files"]:
            done_files += 1
            print(f"\r压缩并上传照片 {done_files}/{total}…", end="", flush=True)
            name = f"{secrets.token_hex(5)}.jpg"
            uploads.append({"path": f"photos/{item_id}/{name}", "sha": gh.blob(compress(path, 1600, 82))})
            uploads.append({"path": f"thumbs/{item_id}/{name}", "sha": gh.blob(compress(path, 400, 70))})
            entries[kind].append({"file": f"photos/{item_id}/{name}", "thumb": f"thumbs/{item_id}/{name}"})
        records.append((it, build_record(it, item_id, entries, now)))
    if total:
        print()

    # 一次提交写入整批；别处刚好也改了数据（422）就基于最新数据重来
    message = f"批量录入 {len(records)} 件：{manifest.get('location') or ''}".strip("：")
    for attempt in range(4):
        head = gh.head()
        latest = gh.read_data(head)
        assigned = []
        for it, rec in records:
            if it["_auto"]:
                rec["assetId"] = next_in_prefix(latest, prefix_for(latest, rec["tags"]), assigned)
                rec["labelPrinted"] = False
                assigned.append(rec["assetId"])
        used = {x["assetId"]: x["name"] for x in latest["items"] + latest["locations"] if x.get("assetId")}
        clash = [f"{r['assetId']}（已被「{used[r['assetId']]}」用了）" for _, r in records if r["assetId"] in used]
        if clash:
            raise ImportError_(f"录入期间编号被占用：{'、'.join(clash)}。没有写入任何数据")
        latest["items"].extend(r for _, r in records)
        content = json.dumps(latest, ensure_ascii=False, indent=1) + "\n"
        try:
            gh.commit(head, [{"path": DATA_FILE, "content": content}, *uploads], message)
            break
        except ImportError_ as e:
            if getattr(e, "status", None) != 422 or attempt == 3:
                raise
    for it, rec in records:
        it["id"] = rec["id"]
        it["assetId"] = rec["assetId"]
    save_manifest(manifest_path, manifest)
    print(f"全部完成，共录入 {len(records)} 件。")
    numbered = [(rec["assetId"], rec["name"]) for _, rec in records if rec["assetId"]]
    if numbered:
        print(f"其中 {len(numbered)} 件有编号，标签已加入「待打印」：")
        for a, n in numbered:
            print(f"  {a}  {n}")


if __name__ == "__main__":
    try:
        main()
    except ImportError_ as e:
        print(f"\n出错：{e}")
        sys.exit(1)
