import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "sync-active-plugin.mjs");

test("sync-active-plugin mirrors the plugin root to active install destinations", () => {
  const temp = makeTempDir();
  const marketplace = path.join(temp, "marketplace", "openai-codex", "plugins", "codex");
  const cache = path.join(temp, "cache", "openai-codex", "codex", "1.0.3");

  fs.mkdirSync(marketplace, { recursive: true });
  fs.writeFileSync(path.join(marketplace, "stale.txt"), "remove me\n");

  const result = run("node", [
    SCRIPT,
    "--marketplace",
    marketplace,
    "--cache",
    cache
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /synced .*marketplace/);
  assert.match(result.stdout, /synced .*cache/);
  assert.equal(fs.existsSync(path.join(marketplace, ".claude-plugin", "plugin.json")), true);
  assert.equal(fs.existsSync(path.join(cache, "scripts", "codex-companion.mjs")), true);
  assert.equal(fs.existsSync(path.join(marketplace, "stale.txt")), false);
});

test("sync-active-plugin dry-run does not modify destinations", () => {
  const temp = makeTempDir();
  const marketplace = path.join(temp, "marketplace", "openai-codex", "plugins", "codex");
  const cache = path.join(temp, "cache", "openai-codex", "codex", "1.0.3");

  const result = run("node", [
    SCRIPT,
    "--dry-run",
    "--marketplace",
    marketplace,
    "--cache",
    cache
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[dry-run\]/);
  assert.equal(fs.existsSync(marketplace), false);
  assert.equal(fs.existsSync(cache), false);
});

test("sync-active-plugin resolves the active cache path from Claude installed plugins", () => {
  const temp = makeTempDir();
  const home = path.join(temp, "home");
  const cache = path.join(temp, "active-cache", "openai-codex", "codex", "1.0.4");
  const manifestDir = path.join(home, ".claude", "plugins");
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, "installed_plugins.json"),
    `${JSON.stringify(
      {
        version: 2,
        plugins: {
          "codex@openai-codex": [
            {
              installPath: cache,
              version: "1.0.4",
              lastUpdated: "2026-05-19T16:27:13.054Z"
            }
          ]
        }
      },
      null,
      2
    )}\n`
  );

  const result = run("node", [SCRIPT, "--skip-marketplace"], {
    env: {
      ...process.env,
      HOME: home
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /synced .*1\.0\.4/);
  assert.equal(fs.existsSync(path.join(cache, "scripts", "codex-companion.mjs")), true);
});
