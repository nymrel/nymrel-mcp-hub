import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createIssuerHttp } from '../src/http.js';

// No defaults for identity, signing material, Google credentials or callback.
const path = process.env.NYMREL_OIDC_CONFIG_FILE;
if (!path) throw new Error('NYMREL_OIDC_CONFIG_FILE is required');
const config = JSON.parse(await readFile(path, 'utf8'));
if (config.offline || !config.issuer?.startsWith('https://')) throw new Error('Entrypoint requires an HTTPS issuer');
const port = Number(process.env.PORT || 3100);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
const app = await createIssuerHttp(config);
const server = createServer(app.handler);
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(port, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => app.close()));
