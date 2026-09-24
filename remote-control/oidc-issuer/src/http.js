import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createIssuer } from './issuer.js';
import { createSqliteStore } from './sqlite-adapter.js';
import { createGoogleClient, GOOGLE_ISSUER } from './google-client.js';

const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
class Denied extends Error {}

async function form(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new Denied();
  let text = '';
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 4096) throw new Denied(); }
  const params = new URLSearchParams(text);
  if ([...params.keys()].some(k => k !== 'csrf') || params.getAll('csrf').length !== 1) throw new Denied();
  return params;
}

// Production-shaped, but deploy only after the README's operational/live gates.
export async function createIssuerHttp(config, { googleFetch } = {}) {
  if (config.identity?.issuer !== GOOGLE_ISSUER) throw new Error('Google issuer required');
  const origin = new URL(config.issuer).origin;
  if (config.issuer !== origin) throw new Error('HTTP issuer must be an origin without a path or trailing slash');
  if (googleFetch && !config.offline) throw new Error('Mock transport is offline-only');
  const app = createIssuer(config);
  const store = createSqliteStore(config.databasePath);
  const bindings = new store.Adapter('BrowserInteractionBinding');
  const cookieName = config.offline ? 'nymrel_interaction' : '__Host-nymrel_interaction';
  const redirectUri = `${origin}/google/callback`;
  let google;
  try { google = await createGoogleClient({ ...config.google, redirectUri, fetchImpl: googleFetch }); }
  catch (error) { app.close(); store.close(); throw error; }
  app.provider.proxy = config.trustProxy === true;
  const callback = app.provider.callback();
  const cookie = req => {
    const matches = (req.headers.cookie || '').split(';').map(x => x.trim()).filter(x => x.startsWith(`${cookieName}=`));
    if (matches.length !== 1) return undefined;
    const value = matches[0].slice(cookieName.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
  };
  async function load(req, uid, stage) {
    const sid = cookie(req), binding = sid && await bindings.find(sid);
    if (!binding || binding.uid !== uid || binding.stage !== stage) throw new Denied();
    return { sid, binding };
  }
  const redirect = (res, location) => { res.writeHead(303, { location }); res.end(); };
  const html = (res, title, action, csrf) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(title)}</title><h1>${escape(title)}</h1><p>Access is limited to device discovery and the approved read-only tools.</p><form method="post" action="${escape(action)}"><input type="hidden" name="csrf" value="${escape(csrf)}"><button>${escape(title)}</button></form></html>`);
  };
  async function newBinding(req, res, uid, stage) {
    const old = cookie(req); if (old) await bindings.destroy(old);
    const sid = random(), csrf = random();
    await bindings.upsert(sid, { uid, stage, csrf }, 300);
    res.setHeader('set-cookie', `${cookieName}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300${config.offline ? '' : '; Secure'}`);
    return csrf;
  }
  return {
    close() { app.close(); store.close(); },
    async handler(req, res) {
      res.setHeader('cache-control', 'no-store');
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('content-security-policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
      try {
        const url = new URL(req.url, origin);
        if (url.origin !== origin) throw new Denied();
        if (url.pathname === '/google/callback') {
          if (req.method !== 'GET') throw new Denied();
          const sid = cookie(req), binding = sid && await bindings.take(sid, 'google');
          if (!binding || binding.stage !== 'google') throw new Denied();
          let verified;
          try { verified = await google.finish(url, binding); } catch { throw new Denied(); }
          if (verified.subject !== config.identity.subject) throw new Denied();
          await bindings.upsert(sid, { uid: binding.uid, stage: 'verified', verified }, 60);
          redirect(res, `/interaction/${binding.uid}/finish`); return;
        }
        const match = /^\/interaction\/([A-Za-z0-9_-]+)(?:\/(start|finish|consent))?$/.exec(url.pathname);
        if (!match) { if (url.pathname.startsWith('/interaction/')) throw new Denied(); callback(req, res); return; }
        const [, uid, action] = match;
        let details;
        try { details = await app.provider.interactionDetails(req, res); } catch { throw new Denied(); }
        if (details.uid !== uid || details.params.client_id !== config.clientId) throw new Denied();
        if (!action && req.method === 'GET') {
          if (details.prompt.name === 'login') {
            html(res, 'Continue with Google', `/interaction/${uid}/start`, await newBinding(req, res, uid, 'login'));
          } else if (details.prompt.name === 'consent' && details.session?.accountId === config.identity.accountId) {
            html(res, 'Approve read-only access', `/interaction/${uid}/consent`, await newBinding(req, res, uid, 'consent'));
          } else throw new Denied();
          return;
        }
        if (action === 'finish' && req.method === 'GET' && details.prompt.name === 'login') {
          const { sid } = await load(req, uid, 'verified');
          const binding = await bindings.take(sid, 'verified'); if (!binding) throw new Denied();
          await app.completeLogin(req, res, binding.verified); return;
        }
        if (req.method !== 'POST' || !['start', 'consent'].includes(action) || req.headers.origin !== origin) throw new Denied();
        const stage = action === 'start' ? 'login' : 'consent';
        if (details.prompt.name !== stage) throw new Denied();
        const { sid, binding } = await load(req, uid, stage);
        const body = await form(req);
        if (!equal(body.get('csrf'), binding.csrf)) throw new Denied();
        if (!await bindings.take(sid, stage)) throw new Denied();
        if (action === 'consent') { await app.approveConsent(req, res); return; }
        const request = await google.begin();
        await bindings.upsert(sid, { uid, stage: 'google', ...request }, 300);
        redirect(res, request.url);
      } catch (error) {
        if (res.headersSent) { res.destroy(); return; }
        res.writeHead(error instanceof Denied ? 403 : 500, { 'content-type': 'text/plain' });
        res.end(error instanceof Denied ? 'Request denied' : 'Request failed');
      }
    }
  };
}
