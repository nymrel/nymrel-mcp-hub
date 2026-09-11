import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SUPERVISOR_LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Append-only, UTF-8, timestamped supervisor log.
 *
 * The Windows launcher previously redirected the supervisor's stdio through
 * Windows PowerShell (`>> supervisor.log 2>&1`). That produced a UTF-16LE file,
 * no timestamps, and PowerShell `NativeCommandError` framing around every native
 * stderr line. The supervisor now owns the file directly so operators can read it
 * with ordinary tools and correlate reconnects with wall-clock time.
 *
 * Lines are written synchronously so a crash loses nothing. Volume is low (a few
 * lines per restart or reconnect), so this is cheap. When the file exceeds
 * `maxBytes` it is rotated once to `<file>.1`, replacing any previous rotation.
 */
export function createSupervisorLog({ filePath, maxBytes = DEFAULT_SUPERVISOR_LOG_MAX_BYTES, now = () => new Date() } = {}) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  const rotated = `${resolved}.1`;
  const limit = Math.max(64 * 1024, Number(maxBytes) || DEFAULT_SUPERVISOR_LOG_MAX_BYTES);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  function rotateIfNeeded(incomingBytes) {
    let size = 0;
    try { size = fs.statSync(resolved).size; } catch { return; }
    if (size + incomingBytes <= limit) return;
    try { fs.rmSync(rotated, { force: true }); } catch { /* best effort */ }
    try {
      fs.renameSync(resolved, rotated);
      return;
    } catch { /* a reader without delete-share can block rename on Windows */ }
    // Fallback keeps the size bound even when rename is blocked: preserve a copy, then truncate in place.
    try { fs.copyFileSync(resolved, rotated); } catch { /* best effort */ }
    try {
      fs.truncateSync(resolved, 0);
      fs.appendFileSync(resolved, `${now().toISOString()} [supervisor] Log rotated in place; previous content copied to ${path.basename(rotated)}\n`, { encoding: 'utf8' });
    } catch { /* keep appending to the current file */ }
  }

  function write(stream, message) {
    const text = String(message ?? '').replace(/\r?\n$/, '');
    if (text.length === 0) return;
    const stamp = now().toISOString();
    const lines = text.split(/\r?\n/).map((line) => `${stamp} [${stream}] ${line}\n`).join('');
    const bytes = Buffer.byteLength(lines, 'utf8');
    rotateIfNeeded(bytes);
    fs.appendFileSync(resolved, lines, { encoding: 'utf8' });
  }

  return {
    path: resolved,
    rotatedPath: rotated,
    write,
    supervisor: (message) => write('supervisor', message),
    agentOut: (message) => write('agent', message),
    agentErr: (message) => write('agent:err', message)
  };
}
