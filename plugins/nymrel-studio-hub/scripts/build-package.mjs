import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UPSTREAM_COMMIT = '8c689189b065d4164d1f00a0ebec6e3508a543e5';
const EXPECTED_TOOLS = [
  'nymrel_ucp_audit', 'nymrel_surety_guard', 'nymrel_swarm_claim', 'nymrel_machine_trust',
  'nymrel_proof_ledger', 'nymrel_crawler_mesh', 'nymrel_beacon_ping', 'nymrel_headless_quote',
  'nymrel_local_forge', 'nymrel_open_ucp', 'nymrel_sandstorm', 'nymrel_a2ui_render',
  'nymrel_swarm_bus', 'nymrel_proof_verify', 'nymrel_web_search'
];
const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');
const repoRoot = path.resolve(pluginRoot, '..', '..');
const exportRoot = path.resolve(pluginRoot, 'export');
const zipPath = path.resolve(pluginRoot, 'nymrel-studio-hub-0.1.1.zip');
const serverRoot = path.join(exportRoot, 'server');
if (path.dirname(exportRoot) !== pluginRoot || path.dirname(zipPath) !== pluginRoot || path.dirname(serverRoot) !== exportRoot) {
  throw new Error('Refusing to write outside the plugin export directory.');
}

function run(command, args, cwd) {
  const windowsCorepack = process.platform === 'win32' && command === 'corepack';
  const executable = windowsCorepack ? (process.env.ComSpec || 'cmd.exe') : command;
  const invocation = windowsCorepack ? ['/d', '/s', '/c', `${command} ${args.join(' ')}`] : args;
  const result = spawnSync(executable, invocation, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stderr || result.stdout}`);
  return result.stdout;
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
async function zipTree(directory, prefix) {
  const entries = [];
  async function collect(folder, relative = '') {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = path.posix.join(relative, entry.name);
      const absolute = path.join(folder, entry.name);
      if (entry.isDirectory()) await collect(absolute, rel);
      else if (entry.isFile()) entries.push({ name: `${prefix}/${rel}`, data: await readFile(absolute) });
      else throw new Error(`Unsupported package entry: ${absolute}`);
    }
  }
  await collect(directory);
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x21, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(entry.data.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    local.push(localHeader, name, entry.data);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(entry.data.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + entry.data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  await writeFile(zipPath, Buffer.concat([...local, centralBytes, end]));
  return entries.length;
}
async function hashTree(directory, relative = '') {
  const hashes = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = path.posix.join(relative.replaceAll(path.sep, '/'), entry.name);
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(hashes, await hashTree(full, rel));
    else if (entry.isFile()) hashes[rel] = sha256(await readFile(full));
  }
  return hashes;
}

const currentHead = run('git', ['rev-parse', 'HEAD'], repoRoot).trim();
const upstreamIsAncestor = spawnSync('git', ['merge-base', '--is-ancestor', UPSTREAM_COMMIT, currentHead], { cwd: repoRoot, windowsHide: true });
if (upstreamIsAncestor.status !== 0) throw new Error(`Pinned source ${UPSTREAM_COMMIT} is not an ancestor of ${currentHead}`);
const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
const packageLock = JSON.parse(await readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'));
const pluginJson = JSON.parse(await readFile(path.join(pluginRoot, 'plugin.json'), 'utf8'));
if (packageJson.version !== '1.0.0' || packageLock.packages?.['']?.version !== packageJson.version) {
  throw new Error('Upstream package version and lockfile do not match the pinned release.');
}
const runtimeDependency = packageJson.dependencies?.undici;
if (runtimeDependency !== '8.10.2') throw new Error(`Unexpected undici runtime dependency: ${runtimeDependency}`);

const toolListing = run(process.execPath, [path.join(repoRoot, 'bin', 'mcp-server.js'), '--list-tools'], repoRoot);
const actualTools = [...toolListing.matchAll(/^\d+\. \[([^\]]+)\]/gm)].map((match) => match[1]);
if (JSON.stringify(actualTools) !== JSON.stringify(EXPECTED_TOOLS)) {
  throw new Error(`Upstream tool list changed: ${JSON.stringify(actualTools)}`);
}

// Build artifacts are generated from the pinned checkout before staging the portable package.
run('corepack', ['npm@12.0.2', 'run', 'build'], repoRoot);
const trackedSourcePaths = run('git', ['ls-tree', '-r', '--name-only', UPSTREAM_COMMIT, '--', 'src', 'bin/mcp-server.js', 'package.json', 'package-lock.json', 'tsconfig.json'], repoRoot)
  .split(/\r?\n/).filter(Boolean);
const sourceFiles = {};
for (const rel of trackedSourcePaths) {
  const current = await readFile(path.join(repoRoot, rel));
  const diff = spawnSync('git', ['diff', '--quiet', UPSTREAM_COMMIT, '--', rel], { cwd: repoRoot, windowsHide: true });
  if (diff.status !== 0) throw new Error(`Working source differs from ${UPSTREAM_COMMIT}:${rel}`);
  sourceFiles[rel] = sha256(Buffer.from(current.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
}
const pluginSourcePaths = [
  'README.md', 'plugin.json', 'mcp.json', 'scripts/build-package.mjs',
  'server/bin/studio-mcp-server.js', 'skills/nymrel-studio-hub/SKILL.md', 'test/truth-boundary.test.mjs'
];
const pluginSourceFiles = {};
for (const rel of pluginSourcePaths) {
  const current = await readFile(path.join(pluginRoot, rel));
  pluginSourceFiles[rel] = sha256(Buffer.from(current.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
}

await rm(exportRoot, { recursive: true, force: true });
await mkdir(path.join(serverRoot, 'bin'), { recursive: true });
await cp(path.join(repoRoot, 'dist', 'src'), path.join(serverRoot, 'dist', 'src'), { recursive: true });
await cp(path.join(repoRoot, 'bin', 'mcp-server.js'), path.join(serverRoot, 'bin', 'mcp-server.js'));
await cp(path.join(pluginRoot, 'server', 'bin', 'studio-mcp-server.js'), path.join(serverRoot, 'bin', 'studio-mcp-server.js'));
for (const rel of ['README.md', 'plugin.json', 'mcp.json', 'skills/nymrel-studio-hub/SKILL.md']) {
  const to = path.join(exportRoot, rel);
  await mkdir(path.dirname(to), { recursive: true });
  await cp(path.join(pluginRoot, rel), to);
}
for (const rel of [
  'package.json', 'package-lock.json', 'LICENSE', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'llms.txt'
]) await cp(path.join(repoRoot, rel), path.join(serverRoot, rel));
for (const rel of [
  'docs/proof-ledger/LICENSE', 'docs/proof-ledger/SOURCE.json',
  'docs/crawler-mesh/LICENSE', 'docs/crawler-mesh/SOURCE.json',
  'docs/crawler-mesh/bandit-reviewed.json'
]) {
  const to = path.join(serverRoot, rel);
  await mkdir(path.dirname(to), { recursive: true });
  await cp(path.join(repoRoot, rel), to);
}

// Resolve only locked production dependencies; no install or lifecycle scripts run at plugin launch.
run('corepack', ['npm@12.0.2', 'ci', '--omit=dev', '--ignore-scripts', '--fund=false', '--audit=false'], serverRoot);
const npmTree = JSON.parse(run('corepack', ['npm@12.0.2', 'ls', '--omit=dev', '--all', '--json'], serverRoot));
const runtimePackages = [];
function visit(deps = {}) {
  for (const [name, item] of Object.entries(deps)) {
    runtimePackages.push({ name, version: item.version });
    visit(item.dependencies);
  }
}
visit(npmTree.dependencies);
runtimePackages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const mcpConfig = JSON.parse(await readFile(path.join(exportRoot, 'mcp.json'), 'utf8'));
const serverConfig = mcpConfig.mcpServers?.['nymrel-studio-hub'];
if (serverConfig?.type !== 'stdio' || serverConfig.command !== 'node' ||
    serverConfig.args?.[0] !== '${PLUGIN_ROOT}/server/bin/studio-mcp-server.js' ||
    serverConfig.cwd !== '${PLUGIN_ROOT}/server' ||
    !(await readFile(path.join(serverRoot, 'bin', 'studio-mcp-server.js'))).byteLength) {
  throw new Error('Portable mcp.json does not target the real bundled Node entrypoint.');
}
await smokeStdio(path.join(serverRoot, 'bin', 'studio-mcp-server.js'));
run(process.execPath, ['--test', path.join(pluginRoot, 'test', 'truth-boundary.test.mjs')], repoRoot);
const bundleFiles = await hashTree(exportRoot);
const receipt = {
  format: 'nymrel-local-plugin-source-receipt.v1',
  pluginName: pluginJson.name,
  pluginVersion: pluginJson.version,
  upstreamRepository: 'https://github.com/nymrel/nymrel-mcp-hub',
  upstreamCommit: UPSTREAM_COMMIT,
  packageBuildCommit: currentHead,
  upstreamPackage: packageJson.name,
  upstreamVersion: packageJson.version,
  toolCount: actualTools.length,
  toolIds: actualTools,
  nodeEngine: packageJson.engines.node,
  packageManager: packageJson.packageManager,
  runtimeDependencies: runtimePackages,
  sourceSha256: sha256(Buffer.from(JSON.stringify({ upstream: sourceFiles, plugin: pluginSourceFiles }))),
  sourceFilesSha256: sourceFiles,
  pluginSourceFilesSha256: pluginSourceFiles,
  bundleFilesSha256: bundleFiles
};
await writeFile(path.join(exportRoot, 'SOURCE_RECEIPT.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
const zipEntries = await zipTree(exportRoot, 'nymrel-studio-hub');
const zipHash = sha256(await readFile(zipPath));
await writeFile(`${zipPath}.sha256`, `${zipHash}  ${path.basename(zipPath)}\n`, 'utf8');
console.log(JSON.stringify({ packageRoot: exportRoot, zipPath, zipSha256: zipHash, zipEntries, upstreamCommit: UPSTREAM_COMMIT, packageBuildCommit: currentHead, toolCount: actualTools.length, runtimePackages, sourceSha256: receipt.sourceSha256 }, null, 2));

async function smokeStdio(binary) {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [binary, '--stdio'], { cwd: serverRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    let newline;
    while ((newline = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (pending.has(message.id)) pending.get(message.id)(message);
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const awaitResponse = (id) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stdio response ${id} timed out. stderr: ${stderr.slice(-1500)}`)), 10_000);
    pending.set(id, (value) => { clearTimeout(timer); resolve(value); });
  });
  try {
    const initializePromise = awaitResponse(1);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'nymrel-plugin-package-smoke', version: '1.0.0' } } })}\n`);
    const initialized = await initializePromise;
    if (initialized.error || initialized.result?.serverInfo?.name !== '@nymrel/mcp-hub') throw new Error(`stdio initialize failed: ${JSON.stringify(initialized)}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const listPromise = awaitResponse(2);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    const listed = await listPromise;
    const listedTools = listed.result?.tools?.map((tool) => tool.name);
    if (JSON.stringify(listedTools) !== JSON.stringify(EXPECTED_TOOLS)) throw new Error(`stdio tools/list mismatch: ${JSON.stringify(listedTools)}`);
    if (listed.result?.tools?.some((tool) => !tool.description.includes('[Studio plugin evidence:'))) throw new Error('stdio tools/list is missing evidence disclosures.');
    const readPromise = awaitResponse(3);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'nymrel://status' } })}\n`);
    const read = await readPromise;
    const status = JSON.parse(read.result?.contents?.[0]?.text ?? 'null');
    if (read.error || read.result?.contents?.[0]?.uri !== 'nymrel://status' || status?.status !== 'LOCAL_PROCESS_RESPONDING') throw new Error(`stdio harmless status read failed: ${JSON.stringify(read)}`);
    const callPromise = awaitResponse(4);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nymrel_open_ucp', arguments: { action: 'settle_x402' } } })}\n`);
    const called = await callPromise;
    const payload = JSON.parse(called.result?.content?.[0]?.text ?? 'null');
    if (payload?.commitmentProof?.settlementStatus !== 'SIMULATED_NOT_SETTLED' || payload.paymentPerformed !== false) throw new Error('stdio simulated settlement disclosure failed.');
    console.log('stdio smoke: initialize PASS; tools/list PASS (15 labeled IDs); local status PASS; OpenUCP non-settlement label PASS');
  } finally {
    child.kill();
  }
}
