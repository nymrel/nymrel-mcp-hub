const TERMINAL_CALLS = new Set(['completed', 'failed', 'cancelled', 'expired']);

function validTime(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

export async function pruneDurablePayloads(runtime, config, now = Date.now()) {
  let prunedCalls = 0;
  let prunedPairings = 0;
  await runtime.store.transaction((state) => {
    for (const [callId, call] of Object.entries(state.calls || {})) {
      if (!TERMINAL_CALLS.has(call.status)) continue;
      const terminalAt = validTime(call.completedAt) ?? validTime(call.expiresAt) ?? validTime(call.createdAt);
      if (terminalAt === null || now - terminalAt < config.callRetentionMs) continue;
      delete state.calls[callId];
      prunedCalls += 1;
    }

    for (const [pairingKey, pairing] of Object.entries(state.pairings || {})) {
      const terminalAt = pairing.status === 'consumed'
        ? validTime(pairing.consumedAt)
        : pairing.status === 'expired'
          ? validTime(pairing.expiresAt)
          : null;
      if (terminalAt === null || now - terminalAt < config.pairingRetentionMs) continue;
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
