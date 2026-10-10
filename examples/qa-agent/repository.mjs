/** A pinned GitHub snapshot. No branch changes or release methods are exposed to the model. */
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export function sourcePath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 500 && !path.startsWith('/')
    && !/[\\\x00-\x1f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..')
    && !path.split('/').some(part => part === '.git' || /^\.env(?:\.|$)/.test(part));
}

export class GitHubSnapshot {
  constructor(ctx, repository, commit) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository) || !sha(commit)) throw new Error('Repository and full commit SHA required');
    this.ctx = ctx; this.repository = repository; this.commit = commit;
    this.entries = null; this.cache = new Map();
  }
  async request(path) {
    const token = this.ctx.secret('GITHUB_READ_TOKEN');
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    let response;
    try {
      response = await this.ctx.fetch(`https://api.github.com/repos/${this.repository}/${path}`, {
        headers, redirect: 'error', signal: AbortSignal.timeout(30_000), maxBytes: 8 * 1024 * 1024,
      });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch { throw new Error('Repository read failed'); }
  }
  async index() {
    if (this.entries) return this.entries;
    const result = await this.request(`git/trees/${this.commit}?recursive=1`);
    if (result.truncated !== false || !Array.isArray(result.tree)) throw new Error('Complete repository tree required');
    this.entries = new Map(result.tree.filter(entry => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode)
      && sourcePath(entry.path) && sha(entry.sha)).map(entry => [entry.path, { sha: entry.sha, mode: entry.mode, size: entry.size }]));
    return this.entries;
  }
  async list() { return [...(await this.index()).keys()].sort(); }
  async read(path) {
    if (!sourcePath(path)) throw new Error('Invalid source path');
    if (this.cache.has(path)) return this.cache.get(path);
    const entry = (await this.index()).get(path);
    if (!entry) throw new Error('Source file not found');
    if (!Number.isSafeInteger(entry.size) || entry.size > 1024 * 1024) throw new Error('Source file exceeds read limit');
    const result = await this.request(`git/blobs/${entry.sha}`);
    if (result.sha !== entry.sha || result.encoding !== 'base64' || typeof result.content !== 'string') throw new Error('Invalid source blob');
    const bytes = Buffer.from(result.content, 'base64');
    if (bytes.length !== entry.size || bytes.includes(0)) throw new Error('Source file is not supported text');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    this.cache.set(path, text);
    return text;
  }
}
