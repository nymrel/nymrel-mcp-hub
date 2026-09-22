// The operator-configured origin is the trust boundary, not a value in an
// imported candidate/evidence file. Never follow redirects with those bodies.
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const UNSAFE_URL_TEXT = /[\u0000-\u0020\u007f\\]/;

/** Resolve a CLI API route only against an explicit, validated gateway origin. */
export function gatewayRequestUrl(route, env = process.env) {
  const value = env.NYMREL_WORKSPACE_URL?.trim();
  if (!value) throw new Error("NYMREL_WORKSPACE_URL is required");
  if (!/^https?:\/\/[^/?#\\@\s]+\/?$/i.test(value) || UNSAFE_URL_TEXT.test(value)) {
    throw new Error("NYMREL_WORKSPACE_URL must be a plain gateway origin");
  }
  let base;
  try {
    base = new URL(value);
  } catch {
    // Do not echo a malformed URL, which could contain credentials.
    throw new Error("NYMREL_WORKSPACE_URL must be a valid gateway origin");
  }
  if (base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
    throw new Error("NYMREL_WORKSPACE_URL must not contain credentials, a path, a query, or a fragment");
  }
  const literalLoopback = /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/.test(value);
  const allowLocalHttp = env.NYMREL_WORKSPACE_ALLOW_LOOPBACK_HTTP === "1" && literalLoopback;
  if (base.protocol !== "https:" && !(base.protocol === "http:" && allowLocalHttp)) {
    throw new Error("Gateway requests require HTTPS; literal-loopback HTTP needs an explicit development opt-in");
  }
  if (typeof route !== "string" || !route.startsWith("/v1/") ||
      UNSAFE_URL_TEXT.test(route) || /[?#]/.test(route)) {
    throw new Error("Gateway route must be an absolute /v1/ API path on the configured origin");
  }
  const target = new URL(route, base);
  if (target.origin !== base.origin || target.pathname !== route) {
    throw new Error("Gateway route must preserve its path and configured origin");
  }
  return target.toString();
}

/** One attempt only. A timeout does not prove that a mutation was rejected. */
export async function fetchGateway(route, options = {}, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const url = gatewayRequestUrl(route, env);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("Gateway timeout must be an integer from 1 to 60000 milliseconds");
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  return fetchImpl(url, {
    ...options,
    // These controls cannot be overridden by the request options.
    redirect: "error",
    signal,
  });
}
