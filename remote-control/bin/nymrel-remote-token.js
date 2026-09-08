#!/usr/bin/env node
import { loadServerConfig } from '../src/config.js';
import { TokenService } from '../src/token.js';

function arg(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const subject = arg('subject');
const tenantId = arg('tenant') || 'default';
const scopes = (arg('scopes') || '').split(',').map((x) => x.trim()).filter(Boolean);
const ttlSec = Number.parseInt(arg('ttl') || '3600', 10);
if (!subject) {
  console.error('Usage: nymrel-remote-token --subject=<id> --scopes=devices:pair,devices:read,... [--tenant=default] [--ttl=3600]');
  process.exit(2);
}
if (!Number.isInteger(ttlSec) || ttlSec < 60 || ttlSec > 86400) throw new Error('--ttl must be 60..86400 seconds');
const config = loadServerConfig();
const service = new TokenService(config.signingKey);
const token = service.mint({ subject, tenantId, scopes, type: 'user', ttlSec });
process.stdout.write(`${token}\n`);
