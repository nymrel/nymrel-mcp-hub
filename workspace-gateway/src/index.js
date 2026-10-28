import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { ContentAddressedStore } from "./cas.js";
import { WorkspaceDatabase } from "./db.js";
import { createGatewayServer } from "./server.js";
import { WorkspaceStore } from "./store.js";

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

async function storageProbe(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.artifactDir, { recursive: true });
  fs.mkdirSync(config.tempDir, { recursive: true });
  const probe = `${config.tempDir}/.write-probe-${process.pid}`;
  try {
    await fs.promises.writeFile(probe, "ok", { flag: "wx" });
    await fs.promises.unlink(probe);
    return true;
  } catch {
    await fs.promises.unlink(probe).catch(() => {});
    return false;
  }
}

export async function buildGateway(config = loadConfig()) {
  if (config.insecureLocal && !isLoopbackHost(config.host)) {
    throw new Error(
      "NYMREL_WORKSPACE_INSECURE_LOCAL requires HOST=127.0.0.1, ::1, or localhost",
    );
  }

  const storageReady = await storageProbe(config);
  const database = new WorkspaceDatabase(config.dbPath);
  const store = new WorkspaceStore(database, config);
  const cas = new ContentAddressedStore(config, store);

  const auditAtStartup = store.auditStatus();
  let recovery = {
    skipped: !auditAtStartup.valid,
    expired_leases: 0,
    orphaned_tasks: 0,
    orphaned_handoffs: 0,
  };
  let orphanSweep = { skipped: !auditAtStartup.valid, removed: 0 };

  if (auditAtStartup.valid) {
    recovery = { skipped: false, ...store.recoverState() };
    orphanSweep = {
      skipped: false,
      ...(await cas.sweepOrphans({ graceSeconds: 3600 })),
    };
  }

  const runtime = {
    started_at_epoch: Math.floor(Date.now() / 1000),
    storageReady,
    auditAtStartup,
    recovery,
    orphanSweep,
  };
  const server = createGatewayServer({
    config,
    store,
    cas,
    runtime,
  });
  return {
    config,
    database,
    store,
    cas,
    runtime,
    server,
  };
}

export async function startGateway(config = loadConfig(), { installSignalHandlers = true } = {}) {
  const gateway = await buildGateway(config);
  await new Promise((resolve, reject) => {
    gateway.server.once("error", reject);
    gateway.server.listen(config.port, config.host, () => {
      gateway.server.off("error", reject);
      resolve();
    });
  });

  const address = gateway.server.address();
  console.log(JSON.stringify({
    level: "info",
    event: "workspace_gateway_started",
    host: config.host,
    port: typeof address === "object" && address ? address.port : config.port,
    auth_ready: config.authReady,
    audit_valid: gateway.store.auditStatus().valid,
    storage_ready: gateway.runtime.storageReady,
  }));

  let shuttingDown = false;
  const shutdown = async (signal = "manual") => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({
      level: "info",
      event: "workspace_gateway_stopping",
      signal,
    }));
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      timer.unref?.();
      gateway.server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    gateway.database.close();
  };
  gateway.shutdown = shutdown;

  if (installSignalHandlers) {
    for (const signal of ["SIGTERM", "SIGINT"]) {
      process.once(signal, () => {
        shutdown(signal)
          .then(() => process.exit(0))
          .catch(() => process.exit(1));
      });
    }
  }

  return gateway;
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry === import.meta.url) {
  startGateway().catch((error) => {
    console.error(JSON.stringify({
      level: "error",
      event: "workspace_gateway_start_failed",
      error: error?.message ?? String(error),
    }));
    process.exitCode = 1;
  });
}
