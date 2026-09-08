import { canonicalize } from './canonical.js';
import { hmacSha256, sha256 } from './crypto.js';

export class AuditLedger {
  constructor(key) {
    this.key = key;
  }

  makeReceipt(state, event) {
    const previous = state.receipts.at(-1)?.hash ?? null;
    const body = {
      v: 1,
      seq: state.receipts.length + 1,
      at: event.at ?? new Date().toISOString(),
      prevHash: previous,
      event: event.event,
      tenantId: event.tenantId ?? null,
      principal: event.principal ?? null,
      deviceId: event.deviceId ?? null,
      callId: event.callId ?? null,
      toolName: event.toolName ?? null,
      status: event.status ?? null,
      policy: event.policy ?? null,
      argsHash: event.argsHash ?? null,
      resultHash: event.resultHash ?? null,
      metadataHash: event.metadata === undefined ? null : sha256(event.metadata)
    };
    const hash = hmacSha256(this.key, canonicalize(body));
    return { ...body, hash };
  }

  append(state, event) {
    const receipt = this.makeReceipt(state, event);
    state.receipts.push(receipt);
    return receipt;
  }

  verify(receipts) {
    let prevHash = null;
    for (let index = 0; index < receipts.length; index += 1) {
      const receipt = receipts[index];
      if (receipt.seq !== index + 1 || receipt.prevHash !== prevHash) return { valid: false, index, reason: 'chain discontinuity' };
      const { hash, ...body } = receipt;
      const expected = hmacSha256(this.key, canonicalize(body));
      if (hash !== expected) return { valid: false, index, reason: 'receipt signature mismatch' };
      prevHash = hash;
    }
    return { valid: true, count: receipts.length, root: prevHash };
  }
}
