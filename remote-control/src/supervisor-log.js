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
 * The file is held open on one descriptor; size checks use fstat on that
 * descriptor rather than a path stat, so there is no check-then-use window on the
 * path. Lines are written synchronously so a crash loses nothing. Volume is low
 * (a few lines per restart or reconnect), so this is cheap. When the file would
 * exceed `maxBytes` it is rotated once to `<file>.1`, replacing any previous
 * rotation; if rename is blocked (a Windows reader without delete-share), the
 * content is copied aside and the live file truncated so the bound still holds.
 */
export function createSupervisorLog({ filePath, maxBytes = DEFAULT_SUPERVISOR_LOG_MAX_BYTES, now = () => new Date() } = {}) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  const rotated = `${resolved}.1`;
  const limit = Math.max(64 * 1024, Number(maxBytes) || DEFAULT_SUPERVISOR_LOG_MAX_BYTES);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  let fd = fs.openSync(resolved, 'a');

  function currentSize() {
    try { return fs.fstatSync(fd).size; } catch { return 0; }
  }

  function rotate() {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    fd = null;
    try { fs.rmSync(rotated, { force: true }); } catch { /* best effort */ }
    let renamed = false;
    try {
      fs.renameSync(resolved, rotated);
      renamed = true;
    } catch { /* fall through to copy + truncate */ }
    if (!renamed) {
      try { fs.copyFileSync(resolved, rotated); } catch { /* best effort */ }
      try { fs.truncateSync(resolved, 0); } catch { /* keep appending to the current file */ }
    }
    fd = fs.openSync(resolved, 'a');
    if (!renamed) {
      fs.writeSync(fd, `${now().toISOString()} [supervisor] Log rotated in place; previous content copied to ${path.basename(rotated)}\n`);
    }
  }

  function write(stream, message) {
    const text = String(message ?? '').replace(/\r?\n$/, '');
    if (text.length === 0) return;
    const stamp = now().toISOString();
    const lines = text.split(/\r?\n/).map((line) => `${stamp} [${stream}] ${line}\n`).join('');
    const bytes = Buffer.byteLength(lines, 'utf8');
    if (currentSize() + bytes > limit) rotate();
    fs.writeSync(fd, lines);
  }

  function close() {
    if (fd === null) return;
    try { fs.closeSync(fd); } catch { /* already closed */ }
    fd = null;
  }

  return {
    path: resolved,
    rotatedPath: rotated,
    write,
    close,
    supervisor: (message) => write('supervisor', message),
    agentOut: (message) => write('agent', message),
    agentErr: (message) => write('agent:err', message)
  };
}
