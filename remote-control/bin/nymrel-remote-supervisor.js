#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const agentPath = path.join(here, 'nymrel-remote-agent.js');
const minBackoffMs = Math.max(250, Number(process.env.NYMREL_REMOTE_SUPERVISOR_MIN_BACKOFF_MS || 1000));
const maxBackoffMs = Math.max(minBackoffMs, Number(process.env.NYMREL_REMOTE_SUPERVISOR_MAX_BACKOFF_MS || 30000));
const stableResetMs = Math.max(1000, Number(process.env.NYMREL_REMOTE_SUPERVISOR_STABLE_RESET_MS || 60000));

let stopping = false;
let child = null;
let backoffMs = minBackoffMs;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  while (!stopping) {
    const startedAt = Date.now();
    console.log(`Starting Nymrel Remote device agent (backoff=${backoffMs}ms)`);
    child = spawn(process.execPath, [agentPath], {
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, NYMREL_REMOTE_SUPERVISED: 'true' }
    });

    const outcome = await new Promise((resolve) => {
      child.once('error', (error) => resolve({ error }));
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child = null;

    if (stopping) break;
    const uptimeMs = Date.now() - startedAt;
    if (uptimeMs >= stableResetMs) backoffMs = minBackoffMs;
    const reason = outcome.error?.message || `code=${outcome.code ?? 'null'} signal=${outcome.signal ?? 'none'}`;
    console.warn(`Nymrel Remote device agent exited (${reason}); restarting after ${backoffMs}ms`);
    await sleep(backoffMs);
    backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
  }
}

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping Nymrel Remote supervisor`);
  if (child && child.exitCode === null) {
    try { child.kill('SIGTERM'); } catch { /* best effort */ }
  }
}

process.on('SIGINT', () => { void stop('SIGINT'); });
process.on('SIGTERM', () => { void stop('SIGTERM'); });

await run();
