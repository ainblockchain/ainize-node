/** Immutable checkpoint blobs: a late attempt can never overwrite a newer attempt's state. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, mkdirSync, lstatSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(id);
const privateDirectory = path => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('Checkpoint directory must be private');
};
export class Checkpoints {
  constructor(root) { privateDirectory(root); this.root = root; }
  path(jobId, checksum) {
    if (!validId(jobId) || typeof checksum !== 'string' || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error('Invalid checkpoint reference');
    return join(this.root, jobId, `${checksum}.json`);
  }
  save(jobId, state) {
    if (!validId(jobId)) throw new Error('Invalid checkpoint job');
    const bytes = Buffer.from(JSON.stringify(state));
    if (bytes.length > 8 * 1024 * 1024) throw new Error('Checkpoint exceeds 8 MiB');
    const checksum = hash(bytes), file = this.path(jobId, checksum), directory = join(this.root, jobId);
    privateDirectory(directory);
    const temporary = join(directory, `${randomUUID()}.tmp`);
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      try { linkSync(temporary, file); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const reference = { jobId, checksum };
      this.load(reference); // Verify an existing destination rather than trusting a colliding path.
      const dir = openSync(directory, constants.O_RDONLY);
      try { fsyncSync(dir); } finally { closeSync(dir); }
      return reference;
    } finally { unlinkSync(temporary); }
  }
  load(reference) {
    const file = this.path(reference?.jobId, reference?.checksum);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024 || (stat.mode & 0o077) !== 0) throw new Error('Invalid checkpoint file');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try { bytes = readFileSync(fd); } finally { closeSync(fd); }
    if (hash(bytes) !== reference.checksum) throw new Error('Checkpoint checksum mismatch');
    return JSON.parse(bytes.toString('utf8'));
  }
}
