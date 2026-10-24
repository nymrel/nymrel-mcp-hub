import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('Alexa+ simulator completes one useful workflow and fails closed twice', async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['examples/alexa-simulator.mjs'],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? ''
      },
      timeout: 10_000,
      maxBuffer: 256 * 1024
    }
  );

  assert.equal(stderr, '');

  const transcript = JSON.parse(stdout);
  assert.equal(transcript.schemaVersion, 1);
  assert.equal(transcript.mode, 'local-synthetic-simulation');
  assert.equal(transcript.protocolVersion, '2025-11-25');
  assert.equal(transcript.transport, 'loopback-streamable-http');

  assert.equal(transcript.success.tool, 'nymrel_surety_guard');
  assert.equal(transcript.success.verdict, 'ALLOW');
  assert.match(transcript.success.assistant, /passed the strict pre-execution safety check/);

  assert.equal(transcript.safeRefusal.tool, 'nymrel_surety_guard');
  assert.equal(transcript.safeRefusal.verdict, 'BLOCK');
  assert.match(transcript.safeRefusal.violation, /recursive deletion/i);
  assert.match(transcript.safeRefusal.assistant, /will not run/i);

  assert.equal(transcript.hostedBoundary.requestedTool, 'nymrel_swarm_claim');
  assert.equal(transcript.hostedBoundary.errorCode, -32602);
  assert.match(transcript.hostedBoundary.assistant, /not exposed/i);

  assert.deepEqual(transcript.limitations, [
    'This is a deterministic local simulator, not evidence of Alexa+ platform validation.',
    'No public endpoint, cloud service, account, credential, or external network is used.',
    'The simulator does not execute either inspected command.'
  ]);
});
