import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HttpError } from "./errors.js";
import { randomId } from "./utils.js";

const SHA256_RE = /^[0-9a-f]{64}$/;

function normalizeHash(input) {
  if (typeof input !== "string" || !SHA256_RE.test(input.toLowerCase())) {
    throw new HttpError(400, "invalid_artifact_hash", "Artifact identifier must be a SHA-256 hex string");
  }
  return input.toLowerCase();
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.promises.open(directory, "r");
    await handle.sync();
  } catch {
    // Some platforms do not permit directory fsync. File contents are already fsync'd.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function hashFile(file) {
  const digest = crypto.createHash("sha256");
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

async function walkFiles(root) {
  const found = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) found.push(full);
    }
  }
  await visit(root);
  return found;
}

export class ContentAddressedStore {
  constructor(config, workspaceStore) {
    this.config = config;
    this.store = workspaceStore;
    fs.mkdirSync(config.artifactDir, { recursive: true });
    fs.mkdirSync(config.tempDir, { recursive: true });
  }

  relativeKey(hash) {
    const normalized = normalizeHash(hash);
    return path.posix.join(
      "artifacts",
      normalized.slice(0, 2),
      normalized.slice(2, 4),
      normalized,
    );
  }

  absolutePath(hash) {
    const normalized = normalizeHash(hash);
    return path.join(
      this.config.artifactDir,
      normalized.slice(0, 2),
      normalized.slice(2, 4),
      normalized,
    );
  }

  async putFromRequest(req, claimedHash, principal) {
    const hash = normalizeHash(claimedHash);
    const existing = this.store.findArtifact(hash);
    const target = this.absolutePath(hash);
    if (existing) {
      try {
        const stat = await fs.promises.stat(target);
        if (stat.isFile() && stat.size === existing.size_bytes) {
          return { artifact: existing, replayed: true };
        }
      } catch {
        throw new HttpError(
          503,
          "artifact_storage_inconsistent",
          "Artifact metadata exists but the content file is unavailable",
        );
      }
    }

    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const temp = path.join(this.config.tempDir, `${randomId()}.part`);
    const handle = await fs.promises.open(temp, "wx");
    const digest = crypto.createHash("sha256");
    let size = 0;
    try {
      for await (const chunkValue of req) {
        const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
        size += chunk.length;
        if (size > this.config.maxArtifactBytes) {
          throw new HttpError(413, "artifact_too_large", "Artifact exceeds the configured size limit");
        }
        digest.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.promises.unlink(temp).catch(() => {});
      throw error;
    }
    await handle.close();

    const calculated = digest.digest("hex");
    if (calculated !== hash) {
      await fs.promises.unlink(temp).catch(() => {});
      throw new HttpError(422, "artifact_hash_mismatch", "Uploaded content does not match the claimed SHA-256", {
        claimed: hash,
        calculated,
      });
    }

    let renamed = false;
    try {
      await fs.promises.rename(temp, target);
      renamed = true;
      await syncDirectory(path.dirname(target));
    } catch (error) {
      if (error.code === "EEXIST" || error.code === "EPERM") {
        try {
          const stat = await fs.promises.stat(target);
          if (!stat.isFile() || await hashFile(target) !== hash) {
            throw new HttpError(
              503,
              "artifact_storage_inconsistent",
              "Existing artifact content does not match its content-addressed path",
            );
          }
          await fs.promises.unlink(temp).catch(() => {});
        } catch (existingError) {
          await fs.promises.unlink(temp).catch(() => {});
          throw existingError;
        }
      } else {
        await fs.promises.unlink(temp).catch(() => {});
        throw error;
      }
    }

    try {
      const registration = this.store.registerArtifact(
        {
          sha256: hash,
          sizeBytes: size,
          mimeType: req.headers["content-type"] ?? "application/octet-stream",
          storagePath: this.relativeKey(hash),
          metadata: {
            content_encoding: req.headers["content-encoding"] ?? null,
          },
        },
        principal,
      );
      return { ...registration, file_committed: true };
    } catch (error) {
      // A durable orphan is safer than a DB row pointing to missing content.
      throw error;
    }
  }

  openForRead(hashInput) {
    const hash = normalizeHash(hashInput);
    const metadata = this.store.getArtifact(hash);
    const absolute = this.absolutePath(hash);
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch {
      throw new HttpError(
        503,
        "artifact_storage_inconsistent",
        "Artifact metadata exists but the content file is unavailable",
      );
    }
    if (!stat.isFile() || stat.size !== metadata.size_bytes) {
      throw new HttpError(
        503,
        "artifact_storage_inconsistent",
        "Artifact content does not match recorded metadata",
      );
    }
    return {
      metadata,
      stream: fs.createReadStream(absolute),
    };
  }

  async sweepOrphans({ graceSeconds = 3600 } = {}) {
    const now = Date.now();
    let removed = 0;
    const files = await walkFiles(this.config.artifactDir);
    for (const file of files) {
      const name = path.basename(file).toLowerCase();
      if (!SHA256_RE.test(name) || this.store.isArtifactRegistered(name)) {
        continue;
      }
      const stat = await fs.promises.stat(file);
      if (now - stat.mtimeMs < graceSeconds * 1000) {
        continue;
      }
      await fs.promises.unlink(file).catch(() => {});
      removed += 1;
    }
    const tempFiles = await walkFiles(this.config.tempDir);
    for (const file of tempFiles) {
      const stat = await fs.promises.stat(file);
      if (now - stat.mtimeMs >= graceSeconds * 1000) {
        await fs.promises.unlink(file).catch(() => {});
        removed += 1;
      }
    }
    return { removed };
  }
}

export { normalizeHash };
