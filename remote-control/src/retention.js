const TERMINAL_CALLS = new Set(['completed', 'failed', 'cancelled', 'expired']);
const DEFAULT_CALL_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PAIRING_RETENTION_MS = 60 * 60 * 1000;

function validTime(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

export async function pruneDurablePayloads(runtime, config, now = Date.now()) {
  const callRetentionMs = Number.isFinite(config.callRetentionMs) ? config.callRetentionMs : DEFAULT_CALL_RETENTION_MS;
  const pairingRetentionMs = Number.isFinite(config.pairingRetentionMs) ? config.pairingRetentionMs : DEFAULT_PAIRING_RETENTION_MS;
  let prunedCalls = 0;
  let prunedPairings = 0;
  await runtime.store.transaction((state) => {
    for (const [callId, call] of Object.entries(state.calls || {})) {
      if (!TERMINAL_CALLS.has(call.status)) continue;
      const terminalAt = validTime(call.completedAt) ?? validTime(call.expiresAt) ?? validTime(call.createdAt);
      if (terminalAt === null || now - terminalAt < callRetentionMs) continue;
      delete state.calls[callId];
      prunedCalls += 1;
    }

    for (const [pairingKey, pairing] of Object.entries(state.pairings || {})) {
      const terminalAt = pairing.status === 'consumed'
        ? validTime(pairing.consumedAt)
        : pairing.status === 'expired'
          ? validTime(pairing.expiresAt)
          : null;
      if (terminalAt === null || now - terminalAt < pairingRetentionMs) continue;
      delete state.pairings[pairingKey];
      prunedPairings += 1;
    }
  });
  return { prunedCalls, prunedPairings };
}

export function startRetentionCleanup(runtime, config, { intervalMs = 60_000 } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await pruneDurablePayloads(runtime, config);
      if (result.prunedCalls || result.prunedPairings) {
        runtime.logger.info?.(`Retention cleanup pruned ${result.prunedCalls} call record(s) and ${result.prunedPairings} pairing record(s)`);
      }
    } catch (error) {
      runtime.logger.error?.(`Retention cleanup failed: ${error?.name || 'Error'}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, Math.max(15_000, intervalMs));
  timer.unref?.();
  return () => clearInterval(timer);
}
