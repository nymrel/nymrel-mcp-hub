import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const endpoints = new Set(['/.well-known/openid-configuration', '/.well-known/oauth-authorization-server', '/auth', '/token', '/token/revocation', '/jwks', '/me', '/session/end', '/session/end/confirm', '/session/end/success', '/google/callback']);
export const isIssuerPath = pathname => endpoints.has(pathname) || pathname.startsWith('/interaction/') || pathname.startsWith('/auth/');

// No timeout-based stealing: a crashed owner requires verified offline recovery.
// Canonicalizing the directory prevents two spelling/symlink aliases owning one DB.
export async function acquireIssuerOwner(databasePath) {
  const directory = await fs.realpath(path.dirname(databasePath));
  const database = path.join(directory, path.basename(databasePath));
  try { if ((await fs.lstat(database)).isSymbolicLink()) throw new Error('Issuer database must not be a symlink'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lockPath = `${database}.owner`;
  const owner = randomUUID();
  const handle = await fs.open(lockPath, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({ owner, pid: process.pid })); await handle.sync(); }
  catch (error) { await handle.close(); throw error; }
  await handle.close();
  let released = false;
  const check = async () => {
    if (released || JSON.parse(await fs.readFile(lockPath, 'utf8')).owner !== owner) throw new Error('Issuer storage ownership lost');
  };
  return { databasePath: database, check, async release() { await check(); await fs.unlink(lockPath); released = true; } };
}

function unavailable(res) {
  res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end('{"status":"unavailable"}');
}

// Called before listen. Disabled mode performs no imports, file reads or network I/O.
export async function installIssuerHost(server, remoteConfig, { env = process.env, createApp } = {}) {
  const enabled = env.NYMREL_REMOTE_OIDC_ISSUER_ENABLED;
  if (enabled === undefined || enabled === 'false') return null;
  if (enabled !== 'true') throw new Error('Issuer enable flag must be true or false');
  if (!env.NYMREL_OIDC_CONFIG_FILE) throw new Error('Issuer config file required');
  const stat = await fs.stat(env.NYMREL_OIDC_CONFIG_FILE);
  if (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid())) throw new Error('Issuer config must be private to its runtime owner');
  const config = JSON.parse(await fs.readFile(env.NYMREL_OIDC_CONFIG_FILE, 'utf8'));
  const origin = new URL(remoteConfig.publicBaseUrl).origin;
  if (!origin.startsWith('https:') || config.issuer !== origin || config.offline) throw new Error('Issuer must match the Remote HTTPS origin');
  const root = await fs.realpath(env.NYMREL_REMOTE_CONTAINER_WRITABLE_ROOT || '/data');
  const directory = await fs.realpath(path.dirname(config.databasePath));
  if (directory !== path.join(root, 'oidc')) throw new Error('Issuer database must be in the dedicated writable-root/oidc directory');
  const owner = await acquireIssuerOwner(config.databasePath);
  let app;
  try {
    const factory = createApp || (await import('../oidc-issuer/src/http.js')).createIssuerHttp;
    app = await factory({ ...config, databasePath: owner.databasePath, trustProxy: true });
  } catch (error) { await owner.release(); throw error; }
  const original = server.listeners('request');
  if (original.length !== 1) { app.close(); await owner.release(); throw new Error('Expected one Remote listener'); }
  let failed = false, closed = false;
  const ready = async () => {
    if (failed || closed) throw new Error('Issuer unavailable');
    try { await owner.check(); app.health(); } catch (error) { failed = true; throw error; }
  };
  server.removeListener('request', original[0]);
  server.on('request', async (req, res) => {
    let pathname;
    try { pathname = new URL(req.url, origin).pathname; } catch { unavailable(res); return; }
    const issuerRequest = isIssuerPath(pathname);
    if (!issuerRequest && pathname !== '/healthz' && pathname !== '/readyz') { original[0](req, res); return; }
    try { await ready(); } catch { unavailable(res); return; }
    if (!issuerRequest) { original[0](req, res); return; }
    // Public ingress is already TLS-terminated; never trust caller-supplied host/proto.
    req.headers.host = new URL(origin).host;
    delete req.headers.forwarded;
    delete req.headers['x-forwarded-for'];
    req.headers['x-forwarded-host'] = new URL(origin).host;
    req.headers['x-forwarded-proto'] = 'https';
    try { await app.handler(req, res); } catch { failed = true; if (!res.headersSent) unavailable(res); else res.destroy(); }
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    app.close();
    // A lost marker must not remove another owner's lock.
    await owner.release();
  };
  server.once('close', () => { void close().catch(() => {}); });
  return { ready, close };
}
