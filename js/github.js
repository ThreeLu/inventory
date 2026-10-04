// GitHub REST API 的最小封装：读文件、建 blob、一次提交多个文件。
// 所有请求都带 cache: 'no-store'，因为 GitHub API 默认会被浏览器缓存 60 秒。

// 自动测试会把它指向本地的假 GitHub（tests/fake_github.py）；正常使用时就是 api.github.com
const API = localStorage.getItem('inventory-api-base') || 'https://api.github.com';

// 每次提交的说明后面带上是哪台设备改的（「手机丢了怎么办」页面里看最近的修改记录，认得出陌生设备）
function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return '安卓手机';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows 电脑';
  return '电脑';
}
export const DEVICE = deviceLabel();

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class GitHub {
  constructor({ token, repo, branch = 'main' }) {
    this.token = token;
    this.repo = repo;
    this.branch = branch;
  }

  async request(method, path, { body, raw = false } = {}) {
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(API + path, {
        method, headers, cache: 'no-store',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new GitHubError('连不上 GitHub，请检查网络', 0);
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message || ''; } catch { /* 没有 JSON 正文 */ }
      const hint = {
        401: '令牌无效或已过期，请到「设置」重新填写',
        403: '令牌没有权限，或请求太频繁',
        404: '找不到数据仓库或文件，请检查「设置」里的仓库名和令牌权限',
      }[res.status];
      throw new GitHubError(hint ? `${hint}（${detail}）` : `GitHub 返回 ${res.status}：${detail}`, res.status);
    }
    if (raw) return res;
    return res.status === 204 ? null : res.json();
  }

  repoPath(rest) {
    return `/repos/${this.repo}${rest}`;
  }

  async headSha() {
    const ref = await this.request('GET', this.repoPath(`/git/ref/heads/${this.branch}`));
    return ref.object.sha;
  }

  async readText(path, ref) {
    const res = await this.request('GET', this.repoPath(`/contents/${encodePath(path)}?ref=${ref}`), { raw: true });
    return res.text();
  }

  async readBlob(path, ref = this.branch) {
    const res = await this.request('GET', this.repoPath(`/contents/${encodePath(path)}?ref=${ref}`), { raw: true });
    return res.blob();
  }

  async createBlob(base64) {
    const out = await this.request('POST', this.repoPath('/git/blobs'), { body: { content: base64, encoding: 'base64' } });
    return out.sha;
  }

  // changes: [{ path, content }]（文本） | [{ path, sha }]（已上传的 blob） | [{ path, remove: true }]
  // 父提交不是分支最新时，GitHub 拒绝快进更新，返回 422；调用方据此重试。
  async commit(parentSha, changes, message) {
    const parent = await this.request('GET', this.repoPath(`/git/commits/${parentSha}`));
    const tree = await this.request('POST', this.repoPath('/git/trees'), {
      body: {
        base_tree: parent.tree.sha,
        tree: changes.map((c) => ({
          path: c.path, mode: '100644', type: 'blob',
          ...(c.remove ? { sha: null } : c.sha ? { sha: c.sha } : { content: c.content }),
        })),
      },
    });
    const commit = await this.request('POST', this.repoPath('/git/commits'), {
      body: { message: `${message} · ${DEVICE}`, tree: tree.sha, parents: [parentSha] },
    });
    await this.request('PATCH', this.repoPath(`/git/refs/heads/${this.branch}`), {
      body: { sha: commit.sha, force: false },
    });
    return commit.sha;
  }
}

// 最近的提交：[{ message, date, device }]。device 是说明最后「 · 」后面的设备名；定时任务、批量录入脚本没有
export async function recentCommits(gh, n = 40) {
  const list = await gh.request('GET', gh.repoPath(`/commits?sha=${gh.branch}&per_page=${n}`));
  return list.map((c) => {
    const msg = c.commit.message.split('\n')[0];
    const m = msg.match(/^(.*) · ([^·]+)$/);
    const bot = /github-actions/.test(c.commit.author?.name || '');
    return { message: m ? m[1] : msg, date: c.commit.committer?.date || c.commit.author?.date, device: m ? m[2] : bot ? 'GitHub 定时任务' : '没写设备' };
  });
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}
