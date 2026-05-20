import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  CLAUDE_ENV_FILE_ENV,
  SESSION_ID_ENV,
  formatSessionLabel,
  readExportedEnvValue,
  resolveClaudeSessionId,
  resolveEnvValue,
  withResolvedSessionEnv
} from "../plugins/codex/scripts/lib/session.mjs";

test("session resolver reads Claude env file exports", () => {
  const dir = makeTempDir();
  const envFile = path.join(dir, "claude-env.sh");
  fs.writeFileSync(
    envFile,
    [
      "export CODEX_COMPANION_SESSION_ID='sess-from-file'",
      "export CLAUDE_PLUGIN_DATA='/tmp/plugin data'",
      ""
    ].join("\n"),
    "utf8"
  );

  const env = { [CLAUDE_ENV_FILE_ENV]: envFile };

  assert.equal(resolveClaudeSessionId(env), "sess-from-file");
  assert.equal(resolveEnvValue("CLAUDE_PLUGIN_DATA", env), "/tmp/plugin data");
});

test("session resolver prefers the process env over Claude env file", () => {
  const dir = makeTempDir();
  const envFile = path.join(dir, "claude-env.sh");
  fs.writeFileSync(envFile, "export CODEX_COMPANION_SESSION_ID='sess-from-file'\n", "utf8");

  assert.equal(
    resolveClaudeSessionId({
      [CLAUDE_ENV_FILE_ENV]: envFile,
      [SESSION_ID_ENV]: "sess-from-env"
    }),
    "sess-from-env"
  );
});

test("session resolver parses shell-escaped single quotes", () => {
  const dir = makeTempDir();
  const envFile = path.join(dir, "claude-env.sh");
  fs.writeFileSync(envFile, "export CODEX_COMPANION_SESSION_ID='sess-'\"'\"'quoted'\n", "utf8");

  assert.equal(readExportedEnvValue(envFile, SESSION_ID_ENV), "sess-'quoted");
});

test("withResolvedSessionEnv injects the recovered session id for child processes", () => {
  const dir = makeTempDir();
  const envFile = path.join(dir, "claude-env.sh");
  fs.writeFileSync(envFile, "export CODEX_COMPANION_SESSION_ID='sess-from-file'\n", "utf8");

  assert.deepEqual(withResolvedSessionEnv({ [CLAUDE_ENV_FILE_ENV]: envFile }), {
    [CLAUDE_ENV_FILE_ENV]: envFile,
    [SESSION_ID_ENV]: "sess-from-file"
  });
});

test("formatSessionLabel keeps sidecar headers compact", () => {
  assert.equal(formatSessionLabel(null), "workspace fallback");
  assert.equal(formatSessionLabel("sess-short"), "sess-short");
  assert.equal(formatSessionLabel("0123456789abcdef0123456789"), "01234567...6789");
});
