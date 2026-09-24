// Mounted into the container only by check-issuer-container-recovery.mjs.
// This file is excluded from the production image. It never completes a login.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, chown, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const ISSUER = 'https://issuer.example.test';
export const GOOGLE_DISCOVERY = 'https://accounts.google.com/.well-known/openid-configuration';
export const CLIENT_ID = 'container-recovery-fixture';
export const CALLBACK = 'https://client.example.test/callback';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function initialize(root, uid = 1000, gid = 1000) {
  const privateRoot = join(root, 'fixture');
  const issuerRoot = join(root, 'oidc');
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  await mkdir(issuerRoot, { recursive: true, mode: 0o700 });
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const config = {
    issuer: ISSUER, clientId: CLIENT_ID, callback: CALLBACK,
    identity: { issuer: 'https://accounts.google.com', subject: 'fixture-google-sub', accountId: 'fixture-account' },
    jwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'container-fixture', alg: 'RS256', use: 'sig' }] },
    cookieKeys: [randomBytes(32).toString('hex')], databasePath: join(issuerRoot, 'issuer.sqlite'),
    google: { clientId: 'fixture-google-client', clientSecret: randomBytes(32).toString('hex') }
  };
  const runtime = Object.fromEntries(['SIGNING_KEY', 'DATA_KEY', 'AUDIT_KEY', 'BOOTSTRAP_TOKEN']
    .map(name => [`NYMREL_REMOTE_${name}`, randomBytes(32).toString('hex')]));
  const files = [join(privateRoot, 'issuer.json'), join(privateRoot, 'runtime.json')];
  await writeFile(files[0], JSON.stringify(config), { mode: 0o600 });
  await writeFile(files[1], JSON.stringify(runtime), { mode: 0o600 });
  if (process.platform !== 'win32') {
    for (const file of [root, privateRoot, issuerRoot, ...files]) await chown(file, uid, gid);
  }
}

// The production host rejects offline config and mock-transport options. Instead,
// this separately mounted test preload supplies public discovery only. Docker's
// network=none independently prevents egress, including non-fetch transports.
export function fixtureFetch(realFetch, localOrigin = 'http://127.0.0.1:8787') {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = init?.method || input?.method || 'GET';
    if (url.href === GOOGLE_DISCOVERY && method === 'GET') {
      return Response.json({
        issuer: 'https://accounts.google.com',
        authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        token_endpoint: 'https://oauth2.googleapis.com/token',
        jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
        response_types_supported: ['code'], subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        code_challenge_methods_supported: ['S256']
      });
    }
    if (url.origin === localOrigin) return realFetch(input, init);
    throw new Error('Container fixture forbids external requests');
  };
}

export async function preload(root) {
  const runtime = JSON.parse(await readFile(join(root, 'fixture', 'runtime.json'), 'utf8'));
  for (const name of ['SIGNING_KEY', 'DATA_KEY', 'AUDIT_KEY', 'BOOTSTRAP_TOKEN']) {
    process.env[`NYMREL_REMOTE_${name}`] = runtime[`NYMREL_REMOTE_${name}`];
  }
  globalThis.fetch = fixtureFetch(globalThis.fetch);
}

async function request(path, init = {}, origin = 'http://127.0.0.1:8787') {
  return fetch(`${origin}${path}`, { ...init, redirect: 'manual', signal: AbortSignal.timeout(3000) });
}

export async function createInteraction(origin = 'http://127.0.0.1:8787') {
  const params = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: CALLBACK, response_type: 'code',
    scope: 'openid offline_access devices:read tools:read', resource: 'https://mcp.nymrel.com/mcp',
    state: 'container-fixture-state', prompt: 'consent', code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(randomBytes(32)).digest('base64url')
  });
  const auth = await request(`/auth?${params}`, {}, origin);
  assert.equal(auth.status, 303);
  const target = new URL(auth.headers.get('location'), ISSUER);
  assert.equal(target.origin, ISSUER);
  assert.match(target.pathname, /^\/interaction\/[A-Za-z0-9_-]+$/);
  const cookies = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.ok(cookies, 'Authorization must create an interaction cookie');
  const interaction = await request(target.pathname, { headers: { cookie: cookies } }, origin);
  assert.equal(interaction.status, 200);
  assert.match(await interaction.text(), /Continue with Google/);
  // Stop before clicking Continue. No identity, grant or token is created.
}

export async function snapshot(root, requireInteraction = true) {
  for (const endpoint of ['/healthz', '/readyz']) assert.equal((await request(endpoint)).status, 200, endpoint);
  assert.equal((await request('/nymrel/plugin/readonly/mcp')).status, 404, 'Read bridge must stay disabled');
  const discovery = await request('/.well-known/openid-configuration');
  assert.equal(discovery.status, 200);
  assert.equal((await discovery.json()).issuer, ISSUER);
  const keys = await request('/jwks');
  assert.equal(keys.status, 200);
  const jwks = await keys.json();
  assert.ok(jwks.keys.length > 0);
  assert.ok(jwks.keys.every(key => !key.d && key.kty === 'RSA'), 'Only public RSA keys may be returned');
  const status = await readFile('/proc/1/status', 'utf8');
  assert.match(status, /^Uid:\s+1000\s+1000\s+1000\s+1000$/m, 'Server must drop all UID privileges');
  const issuerRoot = join(root, 'oidc');
  for (const file of [issuerRoot, join(root, 'fixture'), ...await readdir(issuerRoot).then(names => names.map(name => join(issuerRoot, name))),
    join(root, 'fixture', 'issuer.json'), join(root, 'fixture', 'runtime.json')]) {
    const info = await stat(file);
    assert.equal(info.uid, 1000, 'Private files must belong to runtime UID');
    assert.equal(info.mode & 0o077, 0, 'Private files must exclude group/other access');
  }
  const db = new DatabaseSync(join(issuerRoot, 'issuer.sqlite'), { readOnly: true });
  let rows;
  try { rows = db.prepare('SELECT model,id,payload,expires,grant_id,uid,user_code FROM oidc ORDER BY model,id').all(); }
  finally { db.close(); }
  if (requireInteraction) {
    assert.ok(rows.some(row => row.model === 'Interaction'), 'Real issuer interaction must be stored');
    assert.ok(rows.some(row => row.model === 'BrowserInteractionBinding'), 'Real browser binding must be stored');
  }
  assert.ok(rows.every(row => !['AuthorizationCode', 'AccessToken', 'RefreshToken', 'Grant'].includes(row.model)),
    'Container fixture must not complete authorization');
  const owner = await stat(join(issuerRoot, 'issuer.sqlite.owner.sqlite'));
  return { jwksSha256: digest(jwks), storageSha256: digest(rows), rowCount: rows.length, ownerInode: owner.ino };
}

// --import preloads this same mounted fixture without changing the image.
if (process.env.NYMREL_CONTAINER_FIXTURE_PRELOAD === 'true') await preload('/data');
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const command = process.argv[2];
  if (command === 'initialize') await initialize('/data');
  else if (command === 'interaction') await createInteraction();
  else if (command === 'snapshot') console.log(JSON.stringify(await snapshot('/data', process.argv[3] !== '--empty')));
  else throw new Error('Unknown container fixture command');
}
