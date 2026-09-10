import os from 'node:os';
import path from 'node:path';
import { DeviceAgent } from './device-agent.js';
import { NativeLocalClient } from './native-local-client.js';

function jsonArrayEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return [...fallback];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${name} must be a JSON string array`); }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error(`${name} must be a JSON string array`);
  }
  return parsed;
}

export function loadNativeLocalOptions() {
  const allowedDirectories = jsonArrayEnv('NYMREL_REMOTE_ALLOWED_DIRECTORIES', [os.homedir()])
    .map((value) => path.resolve(value));
  const cwd = path.resolve(process.env.NYMREL_REMOTE_LOCAL_CWD || allowedDirectories[0]);
  const shell = process.env.NYMREL_REMOTE_LOCAL_SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh');
  const blockedCommands = jsonArrayEnv('NYMREL_REMOTE_BLOCKED_COMMANDS', []);
  return { allowedDirectories, cwd, shell, blockedCommands };
}

export class NativeDeviceAgent extends DeviceAgent {
  constructor(config, { logger = console, nativeOptions = loadNativeLocalOptions() } = {}) {
    super(config, { logger });
    this.client = new NativeLocalClient(nativeOptions);
  }
}
