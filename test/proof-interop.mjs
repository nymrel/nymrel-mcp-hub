// Test-only batch bridge; never included in the npm runtime package.
import { executeProofLedger, proofLedgerToolDefinition } from '../dist/src/tools/proofLedgerTool.js';
import { executeProofVerify, proofVerifyToolDefinition } from '../dist/src/tools/proofVerifyTool.js';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const results = [];
for (const request of JSON.parse(input)) {
  if (request.operation === 'schemas') results.push([proofLedgerToolDefinition, proofVerifyToolDefinition]);
  else results.push(await (request.operation === 'create' ? executeProofLedger : executeProofVerify)(request.args));
}
process.stdout.write(JSON.stringify(results));
