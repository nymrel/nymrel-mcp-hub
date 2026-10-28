import crypto from "node:crypto";

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function randomId() {
  return crypto.randomUUID();
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])]),
    );
  }
  return value;
}

export function parseJson(text, fallback) {
  if (text === null || text === undefined || text === "") {
    return fallback;
  }
  return JSON.parse(text);
}

export function asBoolean(value) {
  return value === true || value === 1;
}

export function positiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new TypeError(`Expected integer in range ${min}..${max}`);
  }
  return parsed;
}

export function safeHeaderValue(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128 || !/^[A-Za-z0-9_.:@/-]+$/.test(trimmed)) {
    return fallback;
  }
  return trimmed;
}
