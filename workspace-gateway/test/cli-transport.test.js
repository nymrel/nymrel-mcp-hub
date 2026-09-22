import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { fetchGateway, gatewayRequestUrl } from "../src/cli-transport.js";

const secure = { NYMREL_WORKSPACE_URL: "https://gateway.example" };
const local = (url) => ({ NYMREL_WORKSPACE_URL: url, NYMREL_WORKSPACE_ALLOW_LOOPBACK_HTTP: "1" });

async function server(t, handler) {
  const s = http.createServer(handler);
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  t.after(async () => {
    const closed = new Promise((resolve, reject) => s.close((error) => error ? reject(error) : resolve()));
    s.closeAllConnections();
    await closed;
  });
  return `http://127.0.0.1:${s.address().port}`;
}

test("HTTPS origin resolves API routes", () => {
  assert.equal(gatewayRequestUrl("/v1/repos", secure), "https://gateway.example/v1/repos");
  assert.equal(gatewayRequestUrl("/v1/workspaces/team%2Frepo", secure), "https://gateway.example/v1/workspaces/team%2Frepo");
});

test("HTTPS trailing slash, explicit port and outer whitespace are supported", () => {
  assert.equal(gatewayRequestUrl("/v1/repos", { NYMREL_WORKSPACE_URL: " https://gateway.example:8443/ " }),
    "https://gateway.example:8443/v1/repos");
});

for (const [name, value] of [
  ["missing", undefined], ["empty", ""], ["malformed", "not-a-url"],
  ["remote HTTP", "http://gateway.example"], ["FTP", "ftp://gateway.example"],
  ["credentials", "https://user:fictional-secret@gateway.example"],
  ["base path", "https://gateway.example/proxy"], ["query", "https://gateway.example/?x=y"],
  ["empty query", "https://gateway.example/?"], ["fragment", "https://gateway.example/#x"],
  ["empty fragment", "https://gateway.example/#"], ["backslash", "https://gateway.example\\wrong"],
  ["embedded newline", "https://gate\nway.example"], ["embedded tab", "https://gate\tway.example"],
  ["loopback without opt-in", "http://127.0.0.1:4000"],
  ["missing authority slashes", "https:gateway.example"],
  ["one authority slash", "https:/gateway.example"],
  ["extra authority slash", "https:///gateway.example"],
  ["normalizing base path", "https://gateway.example/private/.."],
  ["empty user information", "https://@gateway.example"],
]) {
  test(`reject ${name} before invoking transport`, async () => {
    let calls = 0;
    await assert.rejects(fetchGateway("/v1/repos", {}, {
      env: { NYMREL_WORKSPACE_URL: value },
      fetchImpl: async () => { calls += 1; return new Response("{}"); },
    }));
    assert.equal(calls, 0);
  });
}

test("invalid URL errors do not echo credentials", () => {
  assert.throws(() => gatewayRequestUrl("/v1/repos", { NYMREL_WORKSPACE_URL: "https://u:fictional-secret@gateway.example" }),
    (error) => !error.message.includes("fictional-secret"));
});

for (const value of ["http://127.0.0.1:4000", "http://[::1]:4000/"]) {
  test(`explicit development exception accepts ${value}`, () => {
    assert.ok(gatewayRequestUrl("/v1/repos", local(value)).endsWith("/v1/repos"));
  });
}
for (const value of ["http://localhost:4000", "http://127.1:4000", "http://2130706433:4000",
  "http://0x7f000001:4000", "http://127.0.0.2:4000", "http://[::ffff:127.0.0.1]:4000",
  "http://127.0.0.1.example:4000", "http://gateway.example", "http://0.0.0.0:4000"]) {
  test(`development exception rejects noncanonical/non-loopback ${value}`, () => {
    assert.throws(() => gatewayRequestUrl("/v1/repos", local(value)));
  });
}

test("development opt-in must be exactly 1", () => {
  assert.throws(() => gatewayRequestUrl("/v1/repos", {
    NYMREL_WORKSPACE_URL: "http://127.0.0.1:4000", NYMREL_WORKSPACE_ALLOW_LOOPBACK_HTTP: "true",
  }));
});

for (const route of ["https://elsewhere.example/v1/repos", "//elsewhere.example/v1/repos", "v1/repos", "/v2/repos",
  "/v1/../admin", "/v1/%2e%2e/admin", "/v1/repos?x=y", "/v1/repos#x", "/v1/foo\\bar", "/v1/a\nb", null]) {
  test(`reject unsafe or rewritten route ${JSON.stringify(route)}`, () => {
    assert.throws(() => gatewayRequestUrl(route, secure));
  });
}

test("one request preserves intent, body, token and idempotency key while enforcing redirect policy", async () => {
  let calls = 0;
  const response = new Response("{}", { status: 200 });
  const headers = { authorization: "Bearer unit-test-only", "idempotency-key": "fixed-intent" };
  const body = JSON.stringify({ git_url: "https://body-data.example/repo", evidence: "fictional" });
  const result = await fetchGateway("/v1/registry/import", { method: "POST", headers, body, redirect: "follow" }, {
    env: secure,
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, "https://gateway.example/v1/registry/import");
      assert.equal(options.method, "POST");
      assert.equal(options.headers, headers);
      assert.equal(options.body, body);
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      return response;
    },
  });
  assert.equal(result, response);
  assert.equal(calls, 1);
});

test("transport failure is propagated without retry", async () => {
  let calls = 0;
  const failure = new Error("fictional transport failure");
  await assert.rejects(fetchGateway("/v1/repos", {}, { env: secure, fetchImpl: async () => {
    calls += 1;
    throw failure;
  } }), (error) => error === failure);
  assert.equal(calls, 1);
});

test("caller cancellation is retained", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await fetchGateway("/v1/repos", { signal: controller.signal }, { env: secure, fetchImpl: async (_url, options) => {
    assert.equal(options.signal.aborted, true);
    assert.equal(options.signal.reason, controller.signal.reason);
    return new Response("{}");
  } });
});

for (const timeoutMs of [0, -1, 1.2, NaN, Infinity, 60001]) {
  test(`reject invalid timeout ${timeoutMs}`, async () => {
    let calls = 0;
    await assert.rejects(fetchGateway("/v1/repos", {}, {
      env: secure, timeoutMs, fetchImpl: async () => { calls += 1; return new Response("{}"); },
    }));
    assert.equal(calls, 0);
  });
}

for (const status of [301, 302, 303, 307, 308]) {
  test(`real fetch blocks ${status} before a second origin receives the body`, async (t) => {
    let targetHits = 0;
    let firstHits = 0;
    const target = await server(t, (_req, res) => { targetHits += 1; res.end("{}"); });
    const source = await server(t, (_req, res) => {
      firstHits += 1;
      res.writeHead(status, { Location: `${target}/v1/capture` });
      res.end();
    });
    await assert.rejects(fetchGateway("/v1/registry/import", {
      method: "POST", headers: { authorization: "Bearer unit-test-only" }, body: '{"fictional":true}',
    }, { env: local(source) }));
    assert.equal(firstHits, 1);
    assert.equal(targetHits, 0);
  });
}

test("real fetch also rejects a same-origin redirect", async (t) => {
  let targetHits = 0;
  const origin = await server(t, (req, res) => {
    if (req.url === "/v1/target") { targetHits += 1; res.end("{}"); return; }
    res.writeHead(307, { Location: "/v1/target" }); res.end();
  });
  await assert.rejects(fetchGateway("/v1/repos", {}, { env: local(origin) }));
  assert.equal(targetHits, 0);
});

test("real successful response preserves JSON body and status", async (t) => {
  const origin = await server(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); });
  const response = await fetchGateway("/v1/repos", {}, { env: local(origin) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("server errors remain available to the CLI and are not retried", async (t) => {
  let hits = 0;
  const origin = await server(t, (_req, res) => { hits += 1; res.writeHead(403); res.end('{"error":"forbidden"}'); });
  const response = await fetchGateway("/v1/repos", {}, { env: local(origin) });
  assert.equal(response.status, 403);
  assert.equal(response.ok, false);
  assert.equal(hits, 1);
});

test("deadline aborts a request with no response headers", async (t) => {
  const origin = await server(t, () => {});
  await assert.rejects(fetchGateway("/v1/repos", {}, { env: local(origin), timeoutMs: 30 }),
    (error) => error.name === "TimeoutError");
});

test("deadline remains active while the CLI consumes a stalled response body", async (t) => {
  const origin = await server(t, (_req, res) => { res.writeHead(200); res.write('{"partial":'); });
  const response = await fetchGateway("/v1/repos", {}, { env: local(origin), timeoutMs: 100 });
  await assert.rejects(response.text(), (error) => error.name === "AbortError" || error.name === "TimeoutError");
});
