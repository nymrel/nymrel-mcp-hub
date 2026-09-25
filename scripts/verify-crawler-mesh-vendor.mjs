import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifestPath = resolve(root, 'docs/crawler-mesh/SOURCE.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

if (manifest.repository !== 'https://github.com/nymrel/nymrel-crawler-mesh') {
  throw new Error('Unexpected Crawler Mesh source repository');
}
if (manifest.revision !== 'b5dcdb971328a07bd77e953935abac1c89e43c99') {
  throw new Error('Unexpected Crawler Mesh source revision');
}

for (const entry of manifest.files) {
  const checkoutBytes = await readFile(resolve(root, entry.destination));
  // Git may materialize text as CRLF on Windows. Upstream blob IDs are based
  // on repository LF bytes, so normalize only CRLF before reconstructing the blob.
  const normalizedBytes = Buffer.from(
    checkoutBytes.toString('utf8').replace(/\r\n/g, '\n'),
    'utf8'
  );
  const header = Buffer.from(`blob ${normalizedBytes.length}\0`, 'utf8');
  const blobSha = createHash('sha1').update(header).update(normalizedBytes).digest('hex');
  if (blobSha !== entry.gitBlobSha) {
    throw new Error(`Vendored Crawler Mesh drift: ${entry.destination} expected ${entry.gitBlobSha} got ${blobSha}`);
  }
}

console.log(`Verified ${manifest.files.length} vendored Crawler Mesh files at ${manifest.revision}`);
