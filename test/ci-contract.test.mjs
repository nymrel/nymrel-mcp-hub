import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const packageSource = read("package.json");
const packageJson = JSON.parse(packageSource);
const ci = read(".github/workflows/ci.yml");
const codeql = read(".github/workflows/codeql.yml");
const release = read(".github/workflows/publish.yml");
const dependabot = read(".github/dependabot.yml");

const pins = {
  checkout: "3d3c42e5aac5ba805825da76410c181273ba90b1",
  setupNode: "820762786026740c76f36085b0efc47a31fe5020",
  setupPython: "5fda3b95a4ea91299a34e894583c3862153e4b97",
  uploadArtifact: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  downloadArtifact: "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  codeql: "cdf488f595d80d6e07e03d4674febd5ab45fa938",
  pypiPublish: "dc37677b2e1c63e2034f94d8a5b11f265b73ba33",
  zizmor: "3dc1ecc9bcb9e94e9b2c709687979e1298497054",
};

function assertedActionPins(workflow) {
  const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gmu)].map((match) => match[1]);
  assert(uses.length > 0, "workflow must use at least one action");
  for (const action of uses) {
    assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/u, `${action} is not pinned to a full commit SHA`);
  }
  return uses;
}

test("package policy is exact and excludes compiled tests", () => {
  assert.equal((packageSource.match(/^  "engines": \{$/gmu) ?? []).length, 1);
  assert.equal(packageJson.engines.node, ">=22 <25");
  assert.equal(packageJson.packageManager, "npm@12.0.2");
  assert.deepEqual(packageJson.devDependencies, {
    "@types/node": "24.13.3",
    typescript: "7.0.2",
  });
  assert.deepEqual(packageJson.files.slice(0, 4), [
    "dist/src/**/*.js",
    "dist/src/**/*.js.map",
    "dist/src/**/*.d.ts",
    "dist/src/**/*.d.ts.map",
  ]);
  assert(!packageJson.files.includes("dist"), "npm packaging must not sweep compiled tests");
  assert.equal(
    packageJson.scripts["verify:package"],
    "tsc && corepack npm@12.0.2 pack --dry-run --json --ignore-scripts | node scripts/verify-npm-package.mjs",
  );
  assert(packageJson.scripts.verify.includes("scripts/verify-npm-package.mjs"));
  assert.equal(packageJson.devEngines.runtime.onFail, "error");
  assert.equal(packageJson.devEngines.packageManager.onFail, "error");
  assert(!("allowScripts" in packageJson), "zero-script dependency graph needs no allowlist");
  const npmrc = read(".npmrc");
  assert.match(npmrc, /^engine-strict=true$/mu);
  assert.match(npmrc, /^strict-allow-scripts=true$/mu);
  assert.match(npmrc, /^strict-peer-deps=true$/mu);
  assert.deepEqual(JSON.parse(read("tsconfig.json")).compilerOptions.types, ["node"]);
});

test("CI covers supported Node and Python lines on current hosted runners", () => {
  assert.match(ci, /^permissions:\r?\n\s+contents: read$/mu);
  assert(!ci.includes("pull_request_target"));
  assert(!ci.includes("continue-on-error"));
  assert(!ci.includes("ubuntu-latest"));
  assert(ci.includes("ubuntu-24.04"));
  assert(ci.includes("windows-2025"));
  assert(ci.includes('node: ["22.23.2", "24.20.0"]'));
  assert(ci.includes('python: ["3.11", "3.12", "3.13", "3.14"]'));
  assert(!ci.includes("npm install --global"));
  assert(!ci.includes("cache: npm"), "setup-node must not invoke npm before the pinned toolchain");
  assert.equal(
    (ci.match(/package-manager-cache: false/gu) ?? []).length,
    1,
    "the Node bootstrap must explicitly disable setup-node's implicit npm cache",
  );
  assert(
    ci.indexOf("package-manager-cache: false") < ci.indexOf("corepack npm@12.0.2 --version"),
    "the cache boundary must be declared before npm 12 is activated",
  );
  assert(ci.includes("corepack npm@12.0.2 ci"));
  assert(ci.includes("python -m pip install --upgrade pip==26.2.1"));
  assert(ci.includes("python -m pip uninstall --yes nymrel-mcp-hub"));
  assert(ci.includes("python -m pip_audit --strict"));
  assert(ci.includes("python -m bandit -q -r python/nymrel_mcp_hub"));
  assert(ci.includes("python -m build --outdir"));
  assert(ci.includes("python -m twine check"));
  assert(ci.includes('"$RUNNER_TEMP/consumer/bin/nymrel-mcp" --list-tools'));
  assert(ci.includes("version: 1.29.0"));
  assert(ci.includes("persona: pedantic"));
  const uses = assertedActionPins(ci);
  assert(uses.includes(`actions/checkout@${pins.checkout}`));
  assert(uses.includes(`actions/setup-node@${pins.setupNode}`));
  assert(uses.includes(`actions/setup-python@${pins.setupPython}`));
  assert(uses.includes(`zizmorcore/zizmor-action@${pins.zizmor}`));
});

test("CodeQL is least privilege and covers both implementation languages", () => {
  assert.match(codeql, /^permissions:\r?\n\s+contents: read$/mu);
  assert(codeql.includes("language: [javascript-typescript, python]"));
  assert(codeql.includes("security-events: write"));
  assert(codeql.includes("queries: security-extended"));
  assert(!codeql.includes("pull_request_target"));
  const uses = assertedActionPins(codeql);
  assert(uses.includes(`actions/checkout@${pins.checkout}`));
  assert.equal(uses.filter((use) => use === `github/codeql-action/init@${pins.codeql}`).length, 1);
  assert.equal(uses.filter((use) => use === `github/codeql-action/analyze@${pins.codeql}`).length, 1);
});

test("release is tag-only, tokenless, artifact-gated, and environment-scoped", () => {
  assert.match(release, /^permissions:\r?\n\s+contents: read$/mu);
  assert(release.includes("tags:"));
  assert(!release.includes("pull_request:"));
  assert(!release.includes("workflow_dispatch:"));
  assert(!release.includes("NPM_TOKEN"));
  assert(!release.includes("NODE_AUTH_TOKEN"));
  assert(!release.includes("skip-existing"));
  assert(!release.includes("continue-on-error"));
  assert(!release.includes("|| true"));
  assert(!release.includes("|| npm install"));
  assert(!release.includes("npm install --global"));
  assert(!release.includes("cache: npm"));
  assert(!release.includes("cache: pip"));
  assert(release.includes("package-manager-cache: false"));
  assert(release.includes("group: nymrel-mcp-hub-release-${{ github.ref }}"));
  assert(release.includes("cancel-in-progress: false"));
  assert.equal((release.match(/fetch-depth: 0/gu) ?? []).length, 2);
  assert.equal((release.match(/git merge-base --is-ancestor/gu) ?? []).length, 2);
  assert(release.includes("python -m pip uninstall --yes nymrel-mcp-hub"));
  assert(release.includes("python -m pip_audit --strict"));
  assert(release.includes("environment: npm"));
  assert(release.includes("environment: pypi"));
  assert.equal((release.match(/id-token: write/gu) ?? []).length, 2);
  const uses = assertedActionPins(release);
  for (const expected of [
    `actions/checkout@${pins.checkout}`,
    `actions/setup-node@${pins.setupNode}`,
    `actions/setup-python@${pins.setupPython}`,
    `actions/upload-artifact@${pins.uploadArtifact}`,
    `actions/download-artifact@${pins.downloadArtifact}`,
    `pypa/gh-action-pypi-publish@${pins.pypiPublish}`,
  ]) {
    assert(uses.includes(expected), `release workflow must use ${expected}`);
  }
});

test("Python packaging is single-source and excludes tests", () => {
  const pyproject = read("pyproject.toml");
  assert(!existsSync(new URL("../setup.py", import.meta.url)), "legacy setup.py must stay removed");
  assert(pyproject.includes('requires = ["setuptools==84.0.0"]'));
  assert(pyproject.includes('requires-python = ">=3.11,<3.15"'));
  assert(pyproject.includes('license = "MIT"'));
  assert(pyproject.includes('include = ["nymrel_mcp_hub*"]'));
  assert(pyproject.includes('exclude = ["tests*"]'));
  assert(pyproject.includes('namespaces = false'));
  assert(pyproject.includes('select = ["E4", "E7", "E9", "F"]'));
  assert.deepEqual(read("requirements-dev.txt").trim().split(/\r?\n/u), [
    "bandit==1.9.4",
    "build==1.6.0",
    "pip-audit==2.10.1",
    "pytest==9.1.1",
    "PyYAML==6.0.3",
    "ruff==0.16.5",
    "setuptools==84.0.0",
    "twine==7.0.0",
  ]);
});

test("Dependabot covers both package ecosystems and GitHub Actions", () => {
  for (const ecosystem of ["npm", "pip", "github-actions"]) {
    assert(dependabot.includes(`package-ecosystem: ${ecosystem}`));
  }
  assert.equal((dependabot.match(/interval: weekly/gu) ?? []).length, 3);
  assert.equal((dependabot.match(/default-days: 7/gu) ?? []).length, 3);
});
