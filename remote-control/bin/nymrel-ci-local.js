#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { runTrustedCiCheckout } from '../src/ci-local-runner.js';

function usage() {
  return `Usage: nymrel-ci-local --trusted-source --repo PATH --repository owner/name --sha FULL_SHA [--manifest PATH] [--job ID ...] [--allow-network-request]\n\nRuns Nymrel CI only for an operator-approved trusted checkout. This command is not a sandbox and must not be used for untrusted/public-fork code.`;
}

function parseArgs(argv) {
  const out = { jobs: [], trustedSource: false, allowNetwork: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--trusted-source') out.trustedSource = true;
    else if (arg === '--allow-network-request') out.allowNetwork = true;
    else if (arg === '--repo') out.repoRoot = argv[++i];
    else if (arg === '--repository') out.repository = argv[++i];
    else if (arg === '--sha') out.commitSha = argv[++i];
    else if (arg === '--manifest') out.manifestPath = argv[++i];
    else if (arg === '--job') out.jobs.push(argv[++i]);
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  if (!args.trustedSource) throw new Error('--trusted-source is required; untrusted code must use a disposable worker');
  if (!args.repoRoot || !args.repository || !args.commitSha) throw new Error('--repo, --repository, and --sha are required');
  const repoRoot = await fs.realpath(path.resolve(args.repoRoot));
  const manifestPath = await fs.realpath(path.resolve(repoRoot, args.manifestPath || '.nymrel/ci.json'));
  const manifestRelative = path.relative(repoRoot, manifestPath);
  if (manifestRelative.startsWith('..') || path.isAbsolute(manifestRelative)) throw new Error('manifest must resolve inside the trusted checkout');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const receipt = await runTrustedCiCheckout({
    repoRoot,
    repository: args.repository,
    commitSha: args.commitSha,
    manifest,
    selectedJobs: args.jobs,
    allowNetwork: args.allowNetwork,
    onOutput: (stream, chunk) => (stream === 'stderr' ? process.stderr : process.stdout).write(chunk)
  });
  process.stdout.write(`\nNYMREL_CI_RECEIPT ${JSON.stringify(receipt)}\n`);
  process.exitCode = receipt.conclusion === 'success' ? 0 : 1;
} catch (error) {
  process.stderr.write(`nymrel-ci-local: ${String(error?.message || error)}\n${usage()}\n`);
  process.exitCode = 2;
}
