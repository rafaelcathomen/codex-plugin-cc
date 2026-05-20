#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  resolveStateDir,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob
} from "./lib/tracked-jobs.mjs";
import { formatSessionLabel, resolveClaudeSessionId, withResolvedSessionEnv } from "./lib/session.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";
const CODEX_ATTACH_COMMAND = process.env.CODEX_CLI_PATH || "/home/rafael/.local/bin/codex";
let monitorAttachActive = false;

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write] [--no-monitor] [--resume-last|--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/codex-companion.mjs monitor [job-id] [--session] [--follow] [--hold]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return resolveClaudeSessionId();
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    sandbox: request.write ? "danger-full-access" : "read-only",
    onProgress: request.onProgress,
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  const monitor = payload.monitorOpened ? " A Codex sidecar terminal is open." : "";
  return `${payload.title} started in the background as ${payload.jobId}.${monitor} Check /codex:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function shouldOpenMonitor(options = {}) {
  if (options.json || options.noMonitor || process.env.CODEX_COMPANION_OPEN_MONITOR === "0") {
    return false;
  }
  if (String(options.prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return false;
  }
  return process.platform === "linux";
}

function sanitizeMonitorKey(value) {
  const normalized = String(value ?? "workspace")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return normalized || "workspace";
}

function getMonitorSessionKey() {
  return sanitizeMonitorKey(getCurrentClaudeSessionId() ?? "workspace");
}

function getSessionMonitorFile(cwd) {
  return path.join(resolveStateDir(cwd), `monitor-${getMonitorSessionKey()}.json`);
}

function getSessionMonitorTargetFile(cwd) {
  return path.join(resolveStateDir(cwd), `monitor-${getMonitorSessionKey()}-target.json`);
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readSessionMonitorRecord(cwd) {
  return readJsonFile(getSessionMonitorFile(cwd));
}

function readSessionMonitorTarget(cwd) {
  return readJsonFile(getSessionMonitorTargetFile(cwd));
}

function writeSessionMonitorTarget(cwd, jobId) {
  fs.mkdirSync(resolveStateDir(cwd), { recursive: true });
  fs.writeFileSync(
    getSessionMonitorTargetFile(cwd),
    `${JSON.stringify(
      {
        jobId,
        sessionId: getCurrentClaudeSessionId(),
        workspaceRoot: resolveWorkspaceRoot(cwd),
        updatedAt: nowIso()
      },
      null,
      2
    )}
`,
    "utf8"
  );
}

function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return false;
  }
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeSessionMonitorRecord(cwd, record) {
  fs.mkdirSync(resolveStateDir(cwd), { recursive: true });
  fs.writeFileSync(getSessionMonitorFile(cwd), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function removeSessionMonitorRecord(cwd, pid = process.pid) {
  const monitorFile = getSessionMonitorFile(cwd);
  const existing = readJsonFile(monitorFile);
  if (existing && Number(existing.pid) !== Number(pid)) {
    return;
  }
  try {
    fs.unlinkSync(monitorFile);
  } catch {
    // Nothing to clean up.
  }
}

function openMonitorTerminal(cwd, jobId, options = {}) {
  if (!shouldOpenMonitor(options)) {
    return false;
  }

  writeSessionMonitorTarget(cwd, jobId);

  const existingMonitor = readSessionMonitorRecord(cwd);
  if (isProcessAlive(existingMonitor?.pid)) {
    appendLogLine(options.logFile, `Reusing existing Codex sidecar terminal for ${jobId}.`);
    return true;
  }

  const alacritty = binaryAvailable("alacritty", ["--version"], { cwd });
  if (!alacritty.available) {
    appendLogLine(options.logFile, `Monitor terminal not opened: alacritty ${alacritty.detail}.`);
    return false;
  }

  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(
    "alacritty",
    [
      "--title",
      "Codex Sidecar",
      "--option",
      "window.padding.x=10",
      "--option",
      "window.padding.y=8",
      "-e",
      process.execPath,
      scriptPath,
      "monitor",
      "--cwd",
      cwd,
      "--session",
      "--follow"
    ],
    {
      cwd,
      env: withResolvedSessionEnv(process.env),
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }
  );
  child.unref();

  if (child.pid) {
    writeSessionMonitorRecord(cwd, {
      pid: child.pid,
      sessionId: getCurrentClaudeSessionId(),
      workspaceRoot: resolveWorkspaceRoot(cwd),
      openedAt: nowIso()
    });
  }

  appendLogLine(options.logFile, `Opened Codex sidecar terminal for ${jobId}.`);
  return true;
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const pendingRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: process.pid,
    logFile
  };
  writeJobFile(job.workspaceRoot, job.id, pendingRecord);
  upsertJob(job.workspaceRoot, pendingRecord);
  openMonitorTerminal(options.cwd ?? job.workspaceRoot, job.id, {
    json: options.json,
    noMonitor: options.noMonitor,
    prompt: options.prompt,
    logFile
  });

  const execution = await runTrackedJob({ ...job, logFile }, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: withResolvedSessionEnv(process.env),
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json, noMonitor: true }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "no-monitor"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const noMonitor = Boolean(options["no-monitor"]);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    const monitorOpened = openMonitorTerminal(cwd, job.id, {
      json: options.json,
      noMonitor,
      prompt,
      logFile: payload.logFile
    });
    const launchPayload = { ...payload, monitorOpened };
    outputCommandResult(launchPayload, renderQueuedTaskLaunch(launchPayload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        onProgress: progress
      }),
    {
      cwd,
      json: options.json,
      noMonitor,
      prompt
    }
  );
}

function terminalStyle(code, text) {
  if (!process.stdout.isTTY || process.env.NO_COLOR) {
    return text;
  }
  return `\x1b[${code}m${text}\x1b[0m`;
}

function bold(text) {
  return terminalStyle("1", text);
}

function dim(text) {
  return terminalStyle("90", text);
}

function statusColor(status) {
  switch (status) {
    case "completed":
      return "32";
    case "failed":
    case "cancelled":
      return "31";
    case "queued":
      return "33";
    case "running":
      return "36";
    default:
      return "37";
  }
}

function compactLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function truncateLine(value, limit) {
  const text = String(value ?? "");
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function terminalWidth() {
  return Math.max(72, Math.min(Number(process.stdout.columns) || 100, 140));
}

function terminalHeight() {
  return Math.max(24, Number(process.stdout.rows) || 36);
}

function wrapText(value, width, maxLines = 3) {
  const text = compactLine(value);
  if (!text) {
    return [];
  }
  const words = text.split(" ");
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width) {
      current = next;
      continue;
    }
    if (current) {
      lines.push(current);
      current = word;
    } else {
      lines.push(truncateLine(word, width));
      current = "";
    }
    if (lines.length >= maxLines) {
      break;
    }
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[lines.length - 1] = truncateLine(lines[lines.length - 1], Math.max(4, width - 3)) + "...";
  }

  return lines;
}

function readLogText(logFile, maxBytes = 64000) {
  if (!logFile || !fs.existsSync(logFile)) {
    return "";
  }
  const stat = fs.statSync(logFile);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(logFile, "r");
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function parseTimestampedLogLine(line) {
  const match = /^\[(\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z)\]\s*(.*)$/.exec(line);
  if (!match) {
    return null;
  }
  return { iso: match[1], time: match[2], message: match[3].trim() };
}

function summarizeActivityMessage(message) {
  if (!message) {
    return null;
  }
  if (/^(Opened|Reusing existing) Codex sidecar terminal/.test(message)) {
    return null;
  }
  if (/^(Thread ready|Turn started|Turn completed)\b/.test(message)) {
    return null;
  }
  if (/^Starting Codex Task\.$/.test(message)) {
    return "Started Codex handoff";
  }
  if (/^Starting Codex task thread\.$/.test(message)) {
    return "Started task thread";
  }
  if (/^Assistant message captured:/.test(message)) {
    return "Codex wrote a response";
  }
  if (/^Applying \d+ file change/.test(message)) {
    return message.replace(/\.$/, "");
  }
  if (/^File changes completed\.$/.test(message)) {
    return "File changes completed";
  }
  const runMatch = /^Running command:\s*(.*)$/.exec(message);
  if (runMatch) {
    return `Run: ${runMatch[1]}`;
  }
  const doneMatch = /^Command completed:.*\(exit (\d+)\)$/.exec(message);
  if (doneMatch) {
    return `Command finished, exit ${doneMatch[1]}`;
  }
  if (/^(Final output|Assistant message|Reasoning summary)$/.test(message)) {
    return null;
  }
  return message;
}

function limitTail(lines, maxLines) {
  if (!Number.isFinite(maxLines) || maxLines <= 0) {
    return lines;
  }
  return lines.slice(-maxLines);
}

function readActivityEntries(logFile, maxLines = Number.POSITIVE_INFINITY) {
  const logText = readLogText(logFile);
  if (!logText) {
    return [];
  }
  const entries = logText
    .split(/\r?\n/)
    .map(parseTimestampedLogLine)
    .filter(Boolean)
    .map((entry) => {
      const summary = summarizeActivityMessage(entry.message);
      return summary ? { ...entry, summary } : null;
    })
    .filter(Boolean);
  return limitTail(entries, maxLines);
}

function readActivityLines(logFile, maxLines = Number.POSITIVE_INFINITY) {
  return readActivityEntries(logFile, maxLines).map((entry) => `${entry.time}  ${entry.summary}`);
}

function formatAge(iso) {
  const timestamp = Date.parse(iso ?? "");
  if (!Number.isFinite(timestamp)) {
    return "unknown age";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 2) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatPhaseLabel(job) {
  const phase = String(job?.phase ?? "").toLowerCase();
  switch (phase) {
    case "queued":
      return "Queued";
    case "starting":
      return "Starting Codex";
    case "investigating":
      return "Inspecting context";
    case "editing":
      return "Editing files";
    case "running":
      return "Running command";
    case "verifying":
      return "Verifying";
    case "reviewing":
      return "Reviewing";
    case "finalizing":
      return "Finalizing";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return isActiveJobStatus(job?.status) ? "Working" : String(job?.status ?? "Idle");
  }
}

function monitorSpinner() {
  const frames = ["-", "\\", "|", "/"];
  return frames[Math.floor(Date.now() / 250) % frames.length];
}

function buildCurrentActivityLine(job, activityEntries, width) {
  if (!isActiveJobStatus(job?.status)) {
    return `${"Now".padEnd(8)} ${formatPhaseLabel(job)}`;
  }
  const latest = activityEntries.at(-1) ?? null;
  const age = latest ? formatAge(latest.iso) : "no events yet";
  const detail = latest ? ` - ${latest.summary} (${age})` : " - waiting for first event";
  return truncateLine(`${"Now".padEnd(8)} ${monitorSpinner()} ${formatPhaseLabel(job)}${detail}`, width);
}

function extractLogBlock(logFile, title) {
  const logText = readLogText(logFile);
  if (!logText) {
    return "";
  }
  const lines = logText.split(/\r?\n/);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseTimestampedLogLine(lines[index]);
    if (parsed?.message === title) {
      start = index + 1;
    }
  }
  if (start === -1) {
    return "";
  }
  const block = [];
  for (let index = start; index < lines.length; index += 1) {
    const parsed = parseTimestampedLogLine(lines[index]);
    if (parsed) {
      break;
    }
    block.push(lines[index]);
  }
  return block.join("\n").trim();
}

function formatOutputBlock(value, width, maxLines = Number.POSITIVE_INFINITY) {
  const text = String(value ?? "").trim();
  if (!text) {
    return [];
  }
  const lines = text
    .split(/\r?\n/)
    .flatMap((line) => (line.length > width ? wrapText(line, width, 4) : [line]))
    .map((line) => truncateLine(line, width));
  if (!Number.isFinite(maxLines) || maxLines <= 0) {
    return lines;
  }
  return lines.slice(0, maxLines);
}

function getMonitorOutput(job, workspaceRoot, storedJob = null) {
  const stored = storedJob ?? (job?.id ? readStoredJob(workspaceRoot, job.id) : null);
  return (
    stored?.result?.rawOutput ??
    stored?.rendered ??
    extractLogBlock(job?.logFile, "Final output") ??
    ""
  );
}

function selectSessionMonitorJob(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot))).filter(
    (job) => job.jobClass === "task"
  );
  const target = readSessionMonitorTarget(cwd);
  const selected = target?.jobId ? jobs.find((job) => job.id === target.jobId) ?? null : null;
  if (!selected) {
    return { workspaceRoot, job: null, target, sessionId };
  }
  return {
    ...buildSingleJobSnapshot(cwd, selected.id, { maxProgressLines: 12 }),
    target,
    sessionId
  };
}

function buildMonitorSnapshot(cwd, reference, options = {}) {
  if (options.session) {
    return selectSessionMonitorJob(cwd);
  }
  return {
    ...buildSingleJobSnapshot(cwd, reference, { maxProgressLines: 12 }),
    sessionId: getCurrentClaudeSessionId()
  };
}

function renderKeyValue(lines, key, value, width) {
  if (!value) {
    return;
  }
  lines.push(`${key.padEnd(8)} ${truncateLine(value, Math.max(10, width - 9))}`);
}

function buildMonitorContent(snapshot, options = {}) {
  const width = terminalWidth();
  const divider = dim("-".repeat(width));
  const lines = [];
  const sessionId = snapshot.sessionId ?? getCurrentClaudeSessionId();
  const job = snapshot.job;
  const target = snapshot.target ?? null;

  lines.push(`${terminalStyle("1;36", "Codex Sidecar")} ${dim(new Date().toLocaleTimeString())}`);
  lines.push(divider);
  renderKeyValue(lines, "Workspace", snapshot.workspaceRoot, width);
  if (options.session) {
    renderKeyValue(lines, "Claude", formatSessionLabel(sessionId), width);
  }

  if (!job) {
    lines.push("");
    lines.push(`${bold("Status")}   ${terminalStyle("33", "idle")}`);
    lines.push("Waiting for the next Claude Code -> Codex handoff.");
    if (target?.jobId) {
      lines.push(dim(`Last requested job ${target.jobId} is no longer in the local job list.`));
    }
    lines.push("");
    lines.push(dim("q closes this sidecar."));
    return lines;
  }

  const storedJob = job.id ? readStoredJob(snapshot.workspaceRoot, job.id) : null;
  const status = String(job.status ?? "unknown");
  const phase = job.phase ? ` / ${job.phase}` : "";
  const elapsed = job.elapsed ? ` (${job.elapsed})` : "";
  lines.push("");
  lines.push(`${bold("Current Handoff")}  ${terminalStyle(statusColor(status), `${status}${phase}`)}${elapsed}`);
  const activityEntries = readActivityEntries(job.logFile);
  renderKeyValue(lines, "Job", job.id, width);
  if (job.threadId) {
    renderKeyValue(lines, "Attach", `codex resume ${job.threadId}`, width);
  }
  if (isActiveJobStatus(job.status)) {
    renderKeyValue(lines, "Cancel", `/codex:cancel ${job.id}`, width);
  }
  lines.push(buildCurrentActivityLine(job, activityEntries, width));

  lines.push("");
  lines.push(bold("Input"));
  const inputSummary = storedJob?.summary ?? job.summary ?? job.title ?? "Codex Task";
  const inputLines = wrapText(inputSummary, width, 4);
  lines.push(...(inputLines.length ? inputLines : [dim("No prompt summary available.")]));

  const output = getMonitorOutput(job, snapshot.workspaceRoot, storedJob);
  const outputLines = formatOutputBlock(output, width);

  lines.push("");
  lines.push(bold(isActiveJobStatus(job.status) ? "Live Activity" : "Output"));
  lines.push(divider);

  if (!isActiveJobStatus(job.status) && outputLines.length) {
    lines.push(...outputLines);
  } else {
    const activityLines = activityEntries.map((entry) => truncateLine(`${entry.time}  ${entry.summary}`, width));
    lines.push(...(activityLines.length ? activityLines : [dim("Waiting for progress events.")]));
    if (outputLines.length) {
      lines.push("");
      lines.push(bold("Latest Response"));
      lines.push(...outputLines);
    }
  }

  lines.push("");
  if (options.session) {
    const footer = isActiveJobStatus(job.status)
      ? "New handoffs replace this view. q closes it."
      : "Finished. Waiting for the next handoff. q closes it.";
    lines.push(dim(footer));
  } else if (!isActiveJobStatus(job.status)) {
    lines.push(dim("Job finished."));
  }
  return lines;
}

function clampScrollOffset(value, maxScroll) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(Math.trunc(numeric), maxScroll));
}

function renderMonitorScreen(snapshot, options = {}) {
  const height = terminalHeight();
  const contentLines = buildMonitorContent(snapshot, options);
  const footerLines = process.stdout.isTTY
    ? 1
    : 0;
  const viewportHeight = Math.max(1, height - footerLines);
  const maxScroll = Math.max(0, contentLines.length - viewportHeight);
  const scrollOffset = clampScrollOffset(options.scrollOffset ?? 0, maxScroll);
  const visibleLines = contentLines.slice(scrollOffset, scrollOffset + viewportHeight);

  while (visibleLines.length < viewportHeight) {
    visibleLines.push("");
  }

  if (footerLines) {
    const attachHint = snapshot?.job?.threadId ? "a/Enter attach  " : "";
    const position = maxScroll > 0
      ? `${scrollOffset + 1}-${Math.min(contentLines.length, scrollOffset + viewportHeight)}/${contentLines.length}`
      : `1-${contentLines.length}/${contentLines.length}`;
    const controls = maxScroll > 0
      ? `Scroll ${position}  wheel up/down PgUp/PgDn Home/End  ${attachHint}q quit`
      : `${attachHint}q quit`;
    visibleLines.push(dim(controls));
  }

  return {
    rendered: `${visibleLines.join("\n")}\n`,
    maxScroll,
    scrollOffset,
    contentLines: contentLines.length
  };
}

function createMonitorScreen() {
  if (!process.stdout.isTTY) {
    return {
      enter() {},
      leave() {}
    };
  }
  let active = false;
  return {
    enter() {
      if (active) {
        return;
      }
      active = true;
      process.stdout.write("\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?25l\x1b[2J\x1b[H");
    },
    leave() {
      if (!active) {
        return;
      }
      active = false;
      process.stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l");
    }
  };
}

function enterMonitorScreen() {
  const screen = createMonitorScreen();
  screen.enter();
  return screen;
}

function waitForChildExit(child) {
  return new Promise((resolve) => {
    child.once("error", (error) => {
      resolve({ code: 1, signal: null, error });
    });
    child.once("exit", (code, signal) => {
      resolve({ code, signal, error: null });
    });
  });
}

async function runMonitorAttach(cwd, threadId, screen) {
  if (!threadId) {
    return;
  }

  screen.leave();
  process.stdout.write(`Attaching to Codex thread ${threadId}. Exit Codex to return to the sidecar.\n\n`);

  monitorAttachActive = true;
  try {
    const child = spawn(CODEX_ATTACH_COMMAND, ["resume", threadId], {
      cwd,
      env: process.env,
      stdio: "inherit",
      windowsHide: true
    });
    const result = await waitForChildExit(child);
    if (result.error) {
      process.stderr.write(`Failed to attach Codex: ${result.error.message}\n`);
      await sleep(1500);
    } else if (result.code && result.code !== 0) {
      process.stderr.write(`Codex attach exited with code ${result.code}.\n`);
      await sleep(1000);
    }
  } finally {
    monitorAttachActive = false;
    screen.enter();
  }
}

function restoreRawMode(previousRawMode) {
  if (!process.stdin.isTTY) {
    return;
  }
  if (typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(Boolean(previousRawMode));
  }
}

function renderMonitorFrame(rendered) {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[H\x1b[2J");
  }
  process.stdout.write(rendered);
}

async function waitForMonitorHold() {
  if (!process.stdin.isTTY) {
    return;
  }
  process.stdout.write("\nMonitor ended. Press Enter to close.");
  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", resolve);
  });
}

function installMonitorCleanup(cwd, restoreScreen = () => {}) {
  writeSessionMonitorRecord(cwd, {
    pid: process.pid,
    sessionId: getCurrentClaudeSessionId(),
    workspaceRoot: resolveWorkspaceRoot(cwd),
    openedAt: nowIso()
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    removeSessionMonitorRecord(cwd, process.pid);
    restoreScreen();
  };
  process.once("exit", cleanup);
  const handleSigint = () => {
    if (monitorAttachActive) {
      process.once("SIGINT", handleSigint);
      return;
    }
    cleanup();
    process.exit(0);
  };
  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  return cleanup;
}

function interpretMonitorKey(chunk) {
  const sgrMouse = /\x1b\[<(\d+);\d+;\d+([mM])/.exec(chunk);
  if (sgrMouse) {
    const code = Number(sgrMouse[1]);
    if (sgrMouse[2] === "M" && (code === 64 || code === 96)) {
      return { type: "scroll", delta: -3 };
    }
    if (sgrMouse[2] === "M" && (code === 65 || code === 97)) {
      return { type: "scroll", delta: 3 };
    }
  }

  const legacyMouseIndex = chunk.indexOf("\x1b[M");
  if (legacyMouseIndex !== -1 && chunk.length >= legacyMouseIndex + 4) {
    const code = chunk.charCodeAt(legacyMouseIndex + 3) - 32;
    if (code === 64) {
      return { type: "scroll", delta: -3 };
    }
    if (code === 65) {
      return { type: "scroll", delta: 3 };
    }
  }

  switch (chunk) {
    case "q":
    case "Q":
    case "\u0003":
      return { type: "quit" };
    case "a":
    case "A":
    case "\r":
    case "\n":
      return { type: "attach" };
    case "\u001b[A":
    case "k":
      return { type: "scroll", delta: -1 };
    case "\u001b[B":
    case "j":
      return { type: "scroll", delta: 1 };
    case "\u001b[5~":
    case "\u0002":
      return { type: "page", direction: -1 };
    case "\u001b[6~":
    case "\u0006":
      return { type: "page", direction: 1 };
    case "\u001b[H":
    case "\u001b[1~":
    case "g":
      return { type: "home" };
    case "\u001b[F":
    case "\u001b[4~":
    case "G":
      return { type: "end" };
    default:
      return null;
  }
}

function installMonitorKeyControls(onAction) {
  if (!process.stdin.isTTY) {
    return () => {};
  }
  const previousRawMode = process.stdin.isRaw;
  if (typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true);
  }
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  const onData = (chunk) => {
    const action = interpretMonitorKey(String(chunk));
    if (action) {
      onAction(action);
    }
  };
  process.stdin.on("data", onData);
  return () => {
    process.stdin.off("data", onData);
    restoreRawMode(previousRawMode);
    process.stdin.pause();
  };
}

async function handleMonitor(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "poll-interval-ms"],
    booleanOptions: ["follow", "hold", "session"]
  });

  const cwd = resolveCommandCwd(options);
  const sessionMode = Boolean(options.session);
  const reference = positionals[0] ?? "";
  if (!reference && !sessionMode) {
    throw new Error("monitor requires a job id. Run /codex:status to list jobs.");
  }

  const screen = sessionMode ? enterMonitorScreen() : createMonitorScreen();
  const cleanupMonitor = sessionMode ? installMonitorCleanup(cwd, () => screen.leave()) : () => {};

  const pollIntervalMs = Math.max(100, Number(options["poll-interval-ms"]) || 250);
  let lastRendered = "";
  let scrollOffset = 0;
  let maxScroll = 0;
  let forceRender = true;
  let shouldQuit = false;
  let attachRequested = false;
  let lastSnapshot = null;

  const renderNow = () => {
    if (!lastSnapshot) {
      return;
    }
    const frame = renderMonitorScreen(lastSnapshot, { session: sessionMode, scrollOffset });
    scrollOffset = frame.scrollOffset;
    maxScroll = frame.maxScroll;
    if (forceRender || frame.rendered !== lastRendered) {
      renderMonitorFrame(frame.rendered);
      lastRendered = frame.rendered;
      forceRender = false;
    }
  };

  let cleanupKeys = () => {};
  const installKeys = () => {
    cleanupKeys = sessionMode
      ? installMonitorKeyControls((action) => {
          const pageSize = Math.max(1, terminalHeight() - 4);
          switch (action.type) {
            case "quit":
              shouldQuit = true;
              break;
            case "attach":
              if (lastSnapshot?.job?.threadId) {
                attachRequested = true;
              }
              break;
            case "scroll":
              scrollOffset = clampScrollOffset(scrollOffset + action.delta, maxScroll);
              break;
            case "page":
              scrollOffset = clampScrollOffset(scrollOffset + action.direction * pageSize, maxScroll);
              break;
            case "home":
              scrollOffset = 0;
              break;
            case "end":
              scrollOffset = maxScroll;
              break;
            default:
              break;
          }
          forceRender = true;
          renderNow();
        })
      : () => {};
  };
  installKeys();

  try {
    while (true) {
      lastSnapshot = buildMonitorSnapshot(cwd, reference, { session: sessionMode });
      forceRender = forceRender || Boolean(lastSnapshot.job && isActiveJobStatus(lastSnapshot.job.status));
      renderNow();

      if (attachRequested) {
        attachRequested = false;
        const threadId = lastSnapshot?.job?.threadId ?? null;
        cleanupKeys();
        lastRendered = "";
        forceRender = true;
        await runMonitorAttach(cwd, threadId, screen);
        installKeys();
        continue;
      }

      const active = lastSnapshot.job ? isActiveJobStatus(lastSnapshot.job.status) : false;
      if (shouldQuit || !options.follow || (!sessionMode && !active)) {
        break;
      }
      await sleep(pollIntervalMs);
    }
  } finally {
    cleanupKeys();
    if (sessionMode) {
      cleanupMonitor();
    }
  }

  if (options.hold && !sessionMode) {
    await waitForMonitorHold();
  }
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "monitor":
      await handleMonitor(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
