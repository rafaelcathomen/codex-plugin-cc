#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SOURCE = path.join(ROOT, "plugins", "codex");
const DEFAULT_MARKETPLACE_DEST = "/home/rafael/.claude/plugins/marketplaces/openai-codex/plugins/codex";
const DEFAULT_CACHE_DEST = "/home/rafael/.claude/plugins/cache/openai-codex/codex/1.0.3";

function parseArgs(argv) {
  const options = {
    source: DEFAULT_SOURCE,
    marketplace: DEFAULT_MARKETPLACE_DEST,
    cache: DEFAULT_CACHE_DEST,
    dryRun: false,
    skipMarketplace: false,
    skipCache: false,
    allowAnyDestination: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--source":
        options.source = requireValue(argv, (index += 1), arg);
        break;
      case "--marketplace":
        options.marketplace = requireValue(argv, (index += 1), arg);
        break;
      case "--cache":
        options.cache = requireValue(argv, (index += 1), arg);
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--skip-marketplace":
        options.skipMarketplace = true;
        break;
      case "--skip-cache":
        options.skipCache = true;
        break;
      case "--allow-any-destination":
        options.allowAnyDestination = true;
        break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function printUsage() {
  console.log(`Usage: node scripts/sync-active-plugin.mjs [options]

Copies plugins/codex from this checkout into the active Claude plugin install.

Options:
  --source <path>        Source plugin root. Default: ${DEFAULT_SOURCE}
  --marketplace <path>   Marketplace destination. Default: ${DEFAULT_MARKETPLACE_DEST}
  --cache <path>         Cache destination. Default: ${DEFAULT_CACHE_DEST}
  --skip-marketplace     Do not sync the marketplace destination.
  --skip-cache           Do not sync the cache destination.
  --dry-run              Print planned copies without changing files.
`);
}

function assertPluginRoot(source) {
  const required = [
    ".claude-plugin/plugin.json",
    "commands/rescue.md",
    "scripts/codex-companion.mjs"
  ];
  for (const relative of required) {
    const candidate = path.join(source, relative);
    if (!fs.existsSync(candidate)) {
      throw new Error(`Source does not look like a codex plugin root: missing ${candidate}`);
    }
  }
}

function assertSafeDestination(destination, options) {
  const resolved = path.resolve(destination);
  const home = os.homedir();
  const tmp = os.tmpdir();
  const allowed =
    options.allowAnyDestination ||
    resolved.startsWith(path.resolve(tmp) + path.sep) ||
    resolved.includes(`${path.sep}.claude${path.sep}plugins${path.sep}`);

  if (!allowed) {
    throw new Error(`Refusing to sync outside a Claude plugin or temp path: ${resolved}`);
  }
  if (resolved === "/" || resolved === home || resolved === path.dirname(resolved)) {
    throw new Error(`Refusing unsafe destination: ${resolved}`);
  }
}

function syncOne(source, destination, options) {
  const resolvedSource = path.resolve(source);
  const resolvedDestination = path.resolve(destination);
  assertSafeDestination(resolvedDestination, options);
  if (resolvedDestination === resolvedSource || resolvedSource.startsWith(resolvedDestination + path.sep)) {
    throw new Error(`Refusing to sync source into itself: ${resolvedDestination}`);
  }

  if (options.dryRun) {
    console.log(`[dry-run] ${resolvedSource} -> ${resolvedDestination}`);
    return;
  }

  fs.mkdirSync(path.dirname(resolvedDestination), { recursive: true });
  fs.rmSync(resolvedDestination, { recursive: true, force: true });
  fs.cpSync(resolvedSource, resolvedDestination, { recursive: true, force: true });
  console.log(`synced ${resolvedDestination}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = path.resolve(options.source);
  assertPluginRoot(source);

  if (!options.skipMarketplace) {
    syncOne(source, options.marketplace, options);
  }
  if (!options.skipCache) {
    syncOne(source, options.cache, options);
  }
}

main();
