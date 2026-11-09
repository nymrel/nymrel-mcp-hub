import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../../bin/mcp-server.js', import.meta.url));

for (const [flag, expected] of [
  ['--list-tools', '15 Registered Tools'],
  ['--list-resources', 'nymrel://ecosystem'],
  ['--list-prompts', 'secure-agent-command']
]) {
  test(`${flag} prints the requested discovery catalog and exits without waiting on stdin`, () => {
    const result = spawnSync(process.execPath, [cliPath, flag], { encoding: 'utf8', timeout: 3000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(expected));
    assert.equal(result.stderr, '');
  });
}
