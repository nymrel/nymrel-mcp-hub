import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let source = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  source += chunk;
}

const result = JSON.parse(source);
const packages = Array.isArray(result) ? result : Object.values(result);
assert.equal(packages.length, 1, "npm pack must describe exactly one package");

const artifact = packages[0];
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(artifact.name, packageJson.name);
assert.equal(artifact.version, packageJson.version);

const paths = artifact.files.map((entry) => entry.path);
assert.equal(artifact.entryCount, paths.length, "npm pack entryCount must match the manifest");
assert(paths.includes(packageJson.main), `npm package must contain ${packageJson.main}`);
assert(paths.includes(packageJson.types), `npm package must contain ${packageJson.types}`);

const forbidden = paths.filter((path) =>
  /^(?:dist\/test|python|test|tests)(?:\/|$)/u.test(path),
);
assert.deepEqual(forbidden, [], `npm package contains non-runtime files: ${forbidden.join(", ")}`);

const publicFiles = new Set([
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "bin/mcp-server",
  "bin/mcp-server.js",
  "llms.txt",
  "package.json",
]);
const unexpected = paths.filter(
  (path) => !publicFiles.has(path) && !path.startsWith("dist/src/"),
);
assert.deepEqual(unexpected, [], `npm package contains unexpected files: ${unexpected.join(", ")}`);

console.log(
  `Verified npm artifact ${artifact.filename}: ${paths.length} files, ${artifact.size} bytes.`,
);
