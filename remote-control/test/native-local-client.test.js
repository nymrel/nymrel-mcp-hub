import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { NativeLocalClient } from '../src/native-local-client.js';

function execFileText(file, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = String(stdout || '');
        error.stderr = String(stderr || '');
        reject(error);
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

async function withClient(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-native-'));
  const client = new NativeLocalClient({
    allowedDirectories: [root],
    cwd: root,
    shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'
  });
  await client.start();
  try { await run(client, root); } finally {
    await client.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('native backend performs bounded file operations without a local MCP dependency', async () => {
  await withClient(async (client, root) => {
    const tools = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === 'read_file'));
    assert.ok(tools.some((tool) => tool.name === 'start_process'));

    const wrote = await client.callTool('write_file', { path: 'notes/a.txt', content: 'alpha\nbeta\n' });
    assert.equal(wrote.isError, false);
    assert.equal(wrote.structuredContent.mode, 'rewrite');

    const read = await client.callTool('read_file', { path: 'notes/a.txt', offset: 1, length: 1 });
    assert.equal(read.structuredContent.text, 'beta');

    const edited = await client.callTool('edit_block', {
      path: 'notes/a.txt', old_string: 'beta', new_string: 'gamma', expected_replacements: 1
    });
    assert.equal(edited.structuredContent.replacements, 1);

    const searched = await client.callTool('search_content', { path: root, pattern: 'gamma' });
    assert.equal(searched.structuredContent.results.length, 1);

    await assert.rejects(
      client.callTool('read_file', { path: path.dirname(root) }),
      /outside allowed directories/i
    );
  });
});

test('native backend retains process output in a managed session', async () => {
  await withClient(async (client) => {
    const command = process.platform === 'win32'
      ? "Write-Output 'native-ok'"
      : "printf 'native-ok\\n'";
    const started = await client.callTool('start_process', { command });
    assert.equal(started.isError, false);
    const pid = started.structuredContent.pid;

    let lastRead = await client.callTool('read_process_output', { pid });
    let output = lastRead.structuredContent.output;
    const outputDeadline = Date.now() + (process.platform === 'win32' ? 30_000 : 10_000);
    while (Date.now() < outputDeadline && lastRead.structuredContent.state !== 'finished') {
      await new Promise((resolve) => setTimeout(resolve, 50));
      lastRead = await client.callTool('read_process_output', { pid, length: 20 });
      output += lastRead.structuredContent.output;
    }
    assert.match(output, /native-ok/, `last process read: ${JSON.stringify(lastRead?.structuredContent)}`);

    assert.equal(lastRead.structuredContent.state, 'finished');
    assert.equal(lastRead.structuredContent.exitCode, 0);

    const sessions = await client.callTool('list_sessions', {});
    assert.ok(sessions.structuredContent.sessions.some((session) => session.pid === pid));
  });
});

test('structured trusted CI launcher executes an exact clean Git checkout without inherited secrets', async () => {
  await withClient(async (client, root) => {
    await fs.mkdir(path.join(root, '.nymrel'), { recursive: true });
    await fs.writeFile(path.join(root, '.nymrel', 'ci.json'), JSON.stringify({
      version: 1,
      jobs: [{
        id: 'env-proof',
        command: 'node -e "process.stdout.write(process.env.NYMREL_TEST_SECRET ? \'leak\' : \'ci-env-clean\')"'
      }]
    }), 'utf8');

    await execFileText('git', ['init'], root);
    await execFileText('git', ['add', '.nymrel/ci.json'], root);
    await execFileText('git', ['-c', 'user.name=Nymrel CI', '-c', 'user.email=ci@nymrel.invalid', 'commit', '-m', 'ci fixture'], root);
    const sha = await execFileText('git', ['rev-parse', 'HEAD'], root);

    const previous = process.env.NYMREL_TEST_SECRET;
    process.env.NYMREL_TEST_SECRET = 'must-not-reach-ci';
    try {
      const tools = await client.listTools();
      assert.ok(tools.some((tool) => tool.name === 'start_trusted_ci'));
      const runId = '9'.repeat(64);
      const started = await client.callTool('start_trusted_ci', {
        runId,
        repoRoot: root,
        repository: 'nymrel/ci-fixture',
        commitSha: sha
      });
      assert.equal(started.isError, false);
      assert.equal(started.structuredContent.runId, runId);
      const pid = started.structuredContent.pid;

      let output = '';
      let last;
      const deadline = Date.now() + (process.platform === 'win32' ? 30_000 : 15_000);
      do {
        await new Promise((resolve) => setTimeout(resolve, 50));
        last = await client.callTool('read_process_output', { pid, length: 5000 });
        output += last.structuredContent.output;
      } while (Date.now() < deadline && last.structuredContent.state !== 'finished');

      assert.equal(last.structuredContent.state, 'finished', output);
      assert.equal(last.structuredContent.exitCode, 0, output);
      assert.match(output, /ci-env-clean/);
      assert.doesNotMatch(output, /must-not-reach-ci|\bleak\b/);
      assert.match(output, /NYMREL_CI_RECEIPT/);
      assert.match(output, /"conclusion":"success"/);

      const verified = await client.callTool('get_trusted_ci_result', { runId });
      assert.equal(verified.isError, false);
      assert.equal(verified.structuredContent.conclusion, 'success');
      assert.equal(verified.structuredContent.receipt.repository, 'nymrel/ci-fixture');
      assert.equal(verified.structuredContent.receipt.commitSha, sha.toLowerCase());
      assert.match(verified.structuredContent.receipt.receiptHash, /^[0-9a-f]{64}$/);
    } finally {
      if (previous === undefined) delete process.env.NYMREL_TEST_SECRET;
      else process.env.NYMREL_TEST_SECRET = previous;
    }
  });
});

test('durable trusted CI receipt survives a native client restart', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-ci-recovery-'));
  const repoRoot = path.join(workspace, 'repo');
  const stateDirectory = path.join(workspace, 'ci-state');
  await fs.mkdir(path.join(repoRoot, '.nymrel'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, '.nymrel', 'ci.json'), JSON.stringify({
    version: 1,
    jobs: [{ id: 'verify', command: 'node -e "process.stdout.write(\'restart-safe\')"' }]
  }), 'utf8');
  await execFileText('git', ['init'], repoRoot);
  await execFileText('git', ['add', '.nymrel/ci.json'], repoRoot);
  await execFileText('git', ['-c', 'user.name=Nymrel CI', '-c', 'user.email=ci@nymrel.invalid', 'commit', '-m', 'ci recovery fixture'], repoRoot);
  const sha = await execFileText('git', ['rev-parse', 'HEAD'], repoRoot);
  const runId = '8'.repeat(64);

  const makeClient = () => new NativeLocalClient({
    allowedDirectories: [workspace],
    cwd: repoRoot,
    ciStateDirectory: stateDirectory,
    shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'
  });

  const first = makeClient();
  let second;
  try {
    await first.start();
    const started = await first.callTool('start_trusted_ci', {
      runId,
      repoRoot,
      repository: 'nymrel/ci-recovery-fixture',
      commitSha: sha
    });
    assert.equal(started.isError, false);
    assert.equal(started.structuredContent.runId, runId);

    const pid = started.structuredContent.pid;
    const deadline = Date.now() + (process.platform === 'win32' ? 30_000 : 15_000);
    let state;
    do {
      await new Promise((resolve) => setTimeout(resolve, 50));
      state = await first.callTool('read_process_output', { pid, length: 5000 });
    } while (Date.now() < deadline && state.structuredContent.state !== 'finished');
    assert.equal(state.structuredContent.state, 'finished');

    const live = await first.callTool('get_trusted_ci_result', { runId });
    assert.equal(live.isError, false, live.content?.[0]?.text);
    assert.equal(live.structuredContent.durable, true);
    assert.equal(live.structuredContent.recovered, false);
    assert.equal(live.structuredContent.receipt.commitSha, sha.toLowerCase());

    await first.stop();
    second = makeClient();
    await second.start();
    const recovered = await second.callTool('get_trusted_ci_result', { runId });
    assert.equal(recovered.isError, false, recovered.content?.[0]?.text);
    assert.equal(recovered.structuredContent.durable, true);
    assert.equal(recovered.structuredContent.recovered, true);
    assert.equal(recovered.structuredContent.conclusion, 'success');
    assert.equal(recovered.structuredContent.receipt.commitSha, sha.toLowerCase());
  } finally {
    await first.stop().catch(() => {});
    await second?.stop().catch(() => {});
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('empty polls and trailing line separators do not consume future process output', async () => {
  await withClient(async (client) => {
    const pid = 12345;
    const session = {
      child: { exitCode: 0 }, output: '', readCursor: 0,
      state: 'running', exitCode: null, signal: null
    };
    client.sessions.set(pid, session);
    const read = async () => (await client.callTool('read_process_output', { pid })).structuredContent;
    assert.equal((await read()).totalLines, 0);
    assert.equal((await read()).output, '');
    session.output = 'first\n';
    assert.equal((await read()).output, 'first');
    assert.equal((await read()).output, '');
    session.output += 'second\n\n';
    assert.equal((await read()).output, 'second\n');
    assert.equal((await read()).output, '');
    session.output += 'third\n';
    session.state = 'finished';
    session.exitCode = 0;
    assert.equal((await read()).output, 'third');
    assert.equal((await read()).output, '');
  });
});
