import { execFile } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';

/** Must match node:24-slim's node user; no host-wide group membership is granted. */
export const HOSTED_AGENT_UID = 1000;
export type HostedAgentAclExec = (args: string[]) => Promise<void>;
const setAcl: HostedAgentAclExec = (args) => new Promise((resolve, reject) => {
  execFile('setfacl', args, (error) => {
    if (error) reject(new Error('hosted agent permissions require POSIX ACL support and setfacl', { cause: error }));
    else resolve();
  });
});

export type HostedAgentAclRead = (path: string) => Promise<string>;
const readAcl: HostedAgentAclRead = (path) => new Promise((resolve, reject) => {
  execFile('getfacl', ['--omit-header', '--numeric', '--', path], (error, stdout) => {
    if (error) reject(new Error('hosted agent state validation requires getfacl', { cause: error }));
    else resolve(stdout);
  });
});

/** Host-owned paths are prepared; private runtime-owned state is validated without mutation. */
export async function hostedAgentAccess(
  path: string, kind: 'state' | 'gateway' | 'socket',
  exec: HostedAgentAclExec = setAcl, uid = HOSTED_AGENT_UID,
  inspectAcl: HostedAgentAclRead = readAcl,
): Promise<void> {
  const owner = process.getuid?.();
  if (owner === undefined) throw new Error('hosted agent Unix permissions require a POSIX host');
  if (kind !== 'socket') mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (kind === 'state' && stat.isDirectory() && stat.uid === uid && stat.uid !== owner) {
    // Group bits include the POSIX ACL mask, so 0700 also disables named grants.
    // The API need not read the contents: Docker binds this directory for its owner.
    if ((stat.mode & 0o7777) !== 0o700) throw new Error('runtime-owned state must have private mode 0700');
    const defaults = (await inspectAcl(path)).split('\n').map(line => line.trim()).filter(line => line.startsWith('default:'));
    const privateDefaults = new Set(['default:user::rwx', 'default:group::---', 'default:other::---', 'default:mask::---']);
    if (defaults.some(line => !privateDefaults.has(line))) throw new Error('runtime-owned state must have private default ACLs');
    return;
  }
  if (stat.uid !== owner || (kind === 'socket' ? !stat.isSocket() : !stat.isDirectory())) {
    throw new Error('hosted agent access path must be owned by the API host and have the expected type');
  }
  chmodSync(path, kind === 'socket' ? 0o600 : 0o700);

  const permission = kind === 'state' ? 'rwx' : kind === 'gateway' ? 'r-x' : 'rw-';
  // Replace access ACLs: no preexisting group or named-user grant may survive.
  await exec(['--set', `u::${kind === 'socket' ? 'rw-' : 'rwx'},${owner === uid ? '' : `u:${uid}:${permission},`}g::---,m::${owner === uid ? '---' : permission},o::---`, '--', path]);
  if (kind !== 'socket') {
    await exec(['-k', '--', path]);
    if (kind === 'state') await exec(['-d', '--set', `u::rwx,${owner === uid ? '' : `u:${owner}:rwx,u:${uid}:rwx,`}g::---,m::${owner === uid ? '---' : 'rwx'},o::---`, '--', path]);
  }
}
