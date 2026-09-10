#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const writableRoot = path.resolve(process.env.NYMREL_REMOTE_CONTAINER_WRITABLE_ROOT || '/data');
const storePath = path.resolve(process.env.NYMREL_REMOTE_STORE || path.join(writableRoot, 'state.json'));
const uid = Number.parseInt(process.env.NYMREL_REMOTE_CONTAINER_UID || '1000', 10);
const gid = Number.parseInt(process.env.NYMREL_REMOTE_CONTAINER_GID || '1000', 10);

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

if (!inside(writableRoot, storePath)) {
  throw new Error(`NYMREL_REMOTE_STORE must remain inside ${writableRoot} in the production container`);
}
if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0) {
  throw new Error('Container UID and GID must be positive integers');
}

if (typeof process.getuid === 'function' && process.getuid() === 0) {
  await fs.mkdir(writableRoot, { recursive: true });
  const stat = await fs.lstat(writableRoot);
  if (stat.isSymbolicLink()) throw new Error('Container writable root must not be a symbolic link');
  await fs.chown(writableRoot, uid, gid);
  try { await fs.chown(storePath, uid, gid); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  process.setgid(gid);
  process.setuid(uid);
}

await import('./nymrel-remote-server.js');
