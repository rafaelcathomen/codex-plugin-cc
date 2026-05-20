import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
export const CLAUDE_ENV_FILE_ENV = "CLAUDE_ENV_FILE";

const CLAUDE_SESSION_ENV_CANDIDATES = [
  SESSION_ID_ENV,
  "CLAUDE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID"
];

function parseSingleQuotedValue(value) {
  return value.slice(1, -1).split("'\"'\"'").join("'");
}

function parseDoubleQuotedValue(value) {
  return value
    .slice(1, -1)
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t");
}

function parseShellValue(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return parseSingleQuotedValue(value);
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return parseDoubleQuotedValue(value);
  }
  return value;
}

export function readExportedEnvValue(filePath, name) {
  if (!filePath || !name) {
    return null;
  }
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    let value = null;
    for (const line of lines) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/.exec(line);
      if (match?.[1] === name) {
        value = parseShellValue(match[2]);
      }
    }
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function resolveEnvValue(name, env = process.env) {
  const direct = env?.[name];
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  return readExportedEnvValue(env?.[CLAUDE_ENV_FILE_ENV], name);
}

function readProcessInfo(pid) {
  if (process.platform !== "linux") {
    return null;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    const afterName = stat.slice(closeParen + 2).trim().split(/\s+/);
    const ppid = Number(afterName[1]);
    const startTime = afterName[19] ?? "";
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    return { pid, ppid, startTime, cmdline };
  } catch {
    return null;
  }
}

function processLooksLikeClaude(cmdline) {
  return String(cmdline ?? "")
    .split(/\s+/)
    .map((token) => path.basename(token.replace(/^['"]|['"]$/g, "")))
    .some((token) => /^claude(?:$|[-_.])|^claude-code(?:$|[-_.])/i.test(token));
}

function deriveSessionIdFromClaudeAncestor() {
  let pid = process.ppid;
  const seen = new Set();
  for (let depth = 0; depth < 24; depth += 1) {
    if (!Number.isInteger(pid) || pid <= 1 || seen.has(pid)) {
      return null;
    }
    seen.add(pid);
    const info = readProcessInfo(pid);
    if (!info) {
      return null;
    }
    if (processLooksLikeClaude(info.cmdline)) {
      const hash = createHash("sha256")
        .update(`${info.pid}:${info.startTime}:${info.cmdline}`)
        .digest("hex")
        .slice(0, 16);
      return `claude-${hash}`;
    }
    pid = info.ppid;
  }
  return null;
}

export function resolveClaudeSessionId(env = process.env) {
  for (const name of CLAUDE_SESSION_ENV_CANDIDATES) {
    const value = resolveEnvValue(name, env);
    if (value) {
      return value;
    }
  }
  return deriveSessionIdFromClaudeAncestor();
}

export function withResolvedSessionEnv(env = process.env) {
  const sessionId = resolveClaudeSessionId(env);
  if (!sessionId || env?.[SESSION_ID_ENV]) {
    return env;
  }
  return {
    ...env,
    [SESSION_ID_ENV]: sessionId
  };
}

export function formatSessionLabel(sessionId) {
  const value = String(sessionId ?? "").trim();
  if (!value) {
    return "workspace fallback";
  }
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}
