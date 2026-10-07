import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("production readiness requires all three bearer roles", () => {
  const partial = loadConfig({
    HOST: "0.0.0.0",
    PORT: "8787",
    NYMREL_WORKSPACE_READ_TOKEN: "read-only",
  });
  assert.equal(partial.authReady, false);

  const full = loadConfig({
    HOST: "0.0.0.0",
    PORT: "8787",
    NYMREL_WORKSPACE_READ_TOKEN: "read",
    NYMREL_WORKSPACE_WRITE_TOKEN: "write",
    NYMREL_WORKSPACE_ADMIN_TOKEN: "admin",
  });
  assert.equal(full.authReady, true);
});

test("production bearer roles must use distinct tokens", () => {
  assert.throws(
    () => loadConfig({
      HOST: "0.0.0.0",
      PORT: "8787",
      NYMREL_WORKSPACE_READ_TOKEN: "same",
      NYMREL_WORKSPACE_WRITE_TOKEN: "same",
      NYMREL_WORKSPACE_ADMIN_TOKEN: "same",
    }),
    /must be distinct/,
  );
});

test("explicit insecure local mode is auth-ready without bearer tokens", () => {
  const config = loadConfig({
    HOST: "127.0.0.1",
    PORT: "8787",
    NYMREL_WORKSPACE_INSECURE_LOCAL: "1",
  });
  assert.equal(config.authReady, true);
  assert.equal(config.insecureLocal, true);
});
