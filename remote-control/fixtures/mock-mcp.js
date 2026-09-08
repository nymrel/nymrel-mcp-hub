import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  let req;
  try { req = JSON.parse(line); } catch { continue; }
  if (req.method === 'notifications/initialized') continue;
  if (req.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } } })}\n`);
  } else if (req.method === 'tools/list') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } }] } })}\n`);
  } else if (req.method === 'tools/call') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: `read:${req.params.arguments.path}` }] } })}\n`);
  }
}
