import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fork } from "node:child_process";

test("malformed request target returns 400 and leaves the same server healthy", { timeout: 15000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-request-target-"));
  const fixture = path.join(root, "server.mjs");
  const serverModule = new URL("../src/index.js", import.meta.url).href;
  const helpersModule = new URL("./helpers.js", import.meta.url).href;
  await fs.writeFile(fixture, `
    import { startGateway } from ${JSON.stringify(serverModule)};
    import { makeConfig } from ${JSON.stringify(helpersModule)};
    const gateway = await startGateway(makeConfig(${JSON.stringify(root)}), { installSignalHandlers: false });
    process.send({ port: gateway.server.address().port });
  `);
  const child = fork(fixture, { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stderr.resume();
  try {
    const port = await Promise.race([
      new Promise((resolve, reject) => {
        child.once("message", (message) => resolve(message.port));
        child.once("error", reject);
      }),
      exited.then(() => { throw new Error("Fixture exited before listening"); }),
    ]);
    const response = await new Promise((resolve, reject) => {
      let body = "";
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.end("GET http://[ HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n");
      });
      socket.setTimeout(3000, () => socket.destroy(new Error("Fixture response timed out")));
      socket.on("data", (chunk) => { body += chunk; });
      socket.once("error", reject);
      socket.once("close", () => resolve(body));
    });
    assert.match(response, /^HTTP\/1\.1 400 /);
    assert.match(response, /"error":"invalid_request_target"/);
    assert.doesNotMatch(response, /http:\/\/\[/);
    assert.equal(child.exitCode, null);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");
    assert.equal(child.exitCode, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const cleanupDeadline = setTimeout(() => child.kill("SIGKILL"), 1000);
      try { await exited; } finally { clearTimeout(cleanupDeadline); }
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
