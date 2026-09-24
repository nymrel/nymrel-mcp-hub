import { HttpError } from "./errors.js";

const SHA_RE = /^[0-9a-f]{40,64}$/i;
const REPO_ID_RE = /^[a-z0-9][a-z0-9._/-]{0,199}$/;

export function normalizeResourcePath(input) {
  if (input === "*") {
    return "*";
  }
  if (typeof input !== "string") {
    throw new HttpError(400, "invalid_path", "Resource paths must be strings");
  }
  const value = input.trim().replaceAll("\\", "/");
  if (!value || value.startsWith("/") || /^[A-Za-z]:\//.test(value)) {
    throw new HttpError(400, "invalid_path", "Resource paths must be repo-relative");
  }
  if (value.includes("//")) {
    throw new HttpError(400, "invalid_path", "Resource paths must not contain empty segments");
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new HttpError(400, "invalid_path", "Resource paths must not contain traversal segments");
  }
  return parts.join("/");
}

export function pathsOverlap(a, b) {
  const left = normalizeResourcePath(a);
  const right = normalizeResourcePath(b);
  if (left === "*" || right === "*" || left === right) {
    return true;
  }
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function normalizeResourcePaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 128) {
    throw new HttpError(400, "invalid_paths", "paths must be a non-empty array with at most 128 entries");
  }
  return [...new Set(paths.map(normalizeResourcePath))].sort();
}

export function normalizeRepoId(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new HttpError(400, "invalid_repo_id", "repo_id must be a non-empty string");
  }
  let value = input.trim().toLowerCase().replaceAll("\\", "/");
  value = value.replace(/\s+/g, "-").replace(/[^a-z0-9._/-]+/g, "-").replace(/-+/g, "-");
  value = value.replace(/^[-/]+|[-/]+$/g, "");
  if (!REPO_ID_RE.test(value)) {
    throw new HttpError(400, "invalid_repo_id", "repo_id is not portable");
  }
  return value;
}

export function normalizeSha(input, field = "sha") {
  if (typeof input !== "string" || !SHA_RE.test(input.trim())) {
    throw new HttpError(400, "invalid_sha", `${field} must be a 40-64 character hexadecimal Git SHA`);
  }
  return input.trim().toLowerCase();
}
