import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["src", "bin", "test", "fixtures"];
const files = [];

function collectJavaScriptFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectJavaScriptFiles(path);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(path);
    }
  }
}

for (const root of roots) {
  collectJavaScriptFiles(root);
}

for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], {
    shell: false,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
