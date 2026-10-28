import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const roots = ["src", "test", "scripts", "bin"];
const files = [];
for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(path.join(root, entry.name));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      files.push(path.join(root, entry.name));
    }
  }
}
files.sort();
for (const file of files) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}
console.log(`syntax=PASS files=${files.length}`);
