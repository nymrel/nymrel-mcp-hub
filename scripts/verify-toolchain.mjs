import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const packageSource = read("package.json");
const packageJson = JSON.parse(packageSource);

assert.equal(read(".node-version").trim(), "24.20.0");
assert.equal(packageJson.engines.node, ">=22 <25");
assert.equal(packageJson.packageManager, "npm@12.0.2");
assert.deepEqual(packageJson.devEngines, {
  runtime: { name: "node", version: ">=22 <25", onFail: "error" },
  packageManager: { name: "npm", version: "12.0.2", onFail: "error" },
});
assert.equal(
  (packageSource.match(/^  "engines": \{$/gmu) ?? []).length,
  1,
  "package.json must declare exactly one top-level engines object",
);

const npmrc = new Set(read(".npmrc").trim().split(/\r?\n/u));
for (const required of [
  "engine-strict=true",
  "strict-allow-scripts=true",
  "strict-peer-deps=true",
]) {
  assert(npmrc.has(required), `.npmrc must contain ${required}`);
}

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
assert([22, 24].includes(nodeMajor), `Node ${process.versions.node} is outside the reviewed LTS lines`);

const npmUserAgent = process.env.npm_config_user_agent ?? "";
assert.match(npmUserAgent, /(?:^|\s)npm\/12\.0\.2(?:\s|$)/u, "npm 12.0.2 is required");

assert.deepEqual(packageJson.files.slice(0, 4), [
  "dist/src/**/*.js",
  "dist/src/**/*.js.map",
  "dist/src/**/*.d.ts",
  "dist/src/**/*.d.ts.map",
]);
assert(!packageJson.files.includes("dist"), "npm packaging must not sweep compiled tests");

const pyproject = read("pyproject.toml");
for (const marker of [
  'requires = ["setuptools==84.0.0"]',
  'requires-python = ">=3.11,<3.15"',
  'license = "MIT"',
  'where = ["python"]',
  'include = ["nymrel_mcp_hub*"]',
  'exclude = ["tests*"]',
  'target-version = "py311"',
]) {
  assert(pyproject.includes(marker), `pyproject.toml must contain ${marker}`);
}

const tsconfig = JSON.parse(read("tsconfig.json"));
assert.deepEqual(
  tsconfig.compilerOptions.types,
  ["node"],
  "TypeScript 7 requires the Node runtime type surface to be explicit",
);

console.log("Toolchain contract verified: Node 22/24, npm 12.0.2, Python 3.11-3.14.");
