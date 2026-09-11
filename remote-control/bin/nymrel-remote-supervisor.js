#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createSupervisorLog } from '../src/supervisor-log.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const agentPath = path.join(here, 'nymrel-remote-agent.js');
const minBackoffMs = Math.max(250, Number(process.env.NYMREL_REMOTE_SUPERVISOR_MIN_BACKOFF_MS || 1000));
const maxBackoffMs = Math.max(minBackoffMs, Number(process.env.NYMREL_REMOTE_SUPERVISOR_MAX_BACKOFF_MS || 30000));
const stableResetMs = Math.max(1000, Number(process.env.NYMREL_REMOTE_SUPERVISOR_STABLE_RESET_MS || 60000));

// When NYMREL_REMOTE_SUPERVISOR_LOG is set (the Windows launcher sets it), the
// supervisor owns a UTF-8, timestamped, rotating log file and captures the
// agent's stdout/stderr into it. Otherwise stdio is inherited for interactive use.
const log = createSupervisorLog({
  filePath: process.env.NYMREL_REMOTE_SUPERVISOR_LOG,
  maxBytes: process.env.NYMREL_REMOTE_SUPERVISOR_LOG_MAX_BYTES
});
const info = (message) => (log ? log.supervisor(message) : console.log(message));
const warn = (message) => (log ? log.supervisor(message) : console.warn(message));

let stopping = false;
let child = null;
let backoffMs = minBackoffMs;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureChildOutput(proc) {
  if (!log) return;
  for (const [stream, write] of [[proc.stdout, log.agentOut], [proc.stderr, log.agentErr]]) {
    if (!stream) continue;
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    lines.on('line', (line) => write(line));
  }
}

async function run() {
  if (log) info(`Supervisor log: ${log.path} (rotates to ${path.basename(log.rotatedPath)})`);
  while (!stopping) {
    const startedAt = Date.now();
    info(`Starting Nymrel Remote device agent (backoff=${backoffMs}ms)`);
    child = spawn(process.execPath, [agentPath], {
      stdio: log ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
      env: { ...process.env, NYMREL_REMOTE_SUPERVISED: 'true' }
    });
    captureChildOutput(child);

    const outcome = await new Promise((resolve) => {
      child.once('error', (error) => resolve({ error }));
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child = null;

    if (stopping) break;
    const uptimeMs = Date.now() - startedAt;
    if (uptimeMs >= stableResetMs) backoffMs = minBackoffMs;
    const reason = outcome.error?.message || `code=${outcome.code ?? 'null'} signal=${outcome.signal ?? 'none'}`;
    warn(`Nymrel Remote device agent exited after ${Math.round(uptimeMs / 1000)}s (${reason}); restarting after ${backoffMs}ms`);
    await sleep(backoffMs);
    backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
  }
}

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  info(`${signal}: stopping Nymrel Remote supervisor`);
  if (child && child.exitCode === null) {
    try { child.kill('SIGTERM'); } catch { /* best effort */ }
  }
}

process.on('SIGINT', () => { void stop('SIGINT'); });
process.on('SIGTERM', () => { void stop('SIGTERM'); });

await run();
