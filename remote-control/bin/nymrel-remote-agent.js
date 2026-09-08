#!/usr/bin/env node
import { loadAgentConfig } from '../src/config.js';
import { DeviceAgent } from '../src/device-agent.js';

const config = loadAgentConfig();
const agent = new DeviceAgent(config);
await agent.start();
console.log(`Nymrel Remote agent online for ${config.deviceName}`);

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping Nymrel Remote agent`);
  await agent.stop();
}
process.on('SIGINT', () => { void stop('SIGINT'); });
process.on('SIGTERM', () => { void stop('SIGTERM'); });
