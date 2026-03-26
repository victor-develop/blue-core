#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_MODEL = process.env.ITERATION_JUDGE_MODEL || "gpt-5.4-mini";
const DEFAULT_TIMEOUT_MS = Number(process.env.ITERATION_JUDGE_TIMEOUT_MS || 120000);
const DECISIONS = new Set(["CONTINUE", "STOP"]);

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    model: DEFAULT_MODEL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    goal: "",
    done: "",
    remaining: "",
    blockers: "",
    userPreference: "",
    contextFile: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--cwd" && next) {
      options.cwd = path.resolve(next);
      index += 1;
      continue;
    }
    if (arg === "--model" && next) {
      options.model = next;
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms" && next) {
      options.timeoutMs = Number(next);
      index += 1;
      continue;
    }
    if (arg === "--goal" && next) {
      options.goal = next;
      index += 1;
      continue;
    }
    if (arg === "--done" && next) {
      options.done = next;
      index += 1;
      continue;
    }
    if (arg === "--remaining" && next) {
      options.remaining = next;
      index += 1;
      continue;
    }
    if (arg === "--blockers" && next) {
      options.blockers = next;
      index += 1;
      continue;
    }
    if (arg === "--user-preference" && next) {
      options.userPreference = next;
      index += 1;
      continue;
    }
    if (arg === "--context-file" && next) {
      options.contextFile = path.resolve(next);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node scripts/iteration-judge.mjs [options]",
      "",
      "Outputs exactly one decision marker by default: CONTINUE or STOP.",
      "",
      "Options:",
      "  --goal <text>             Original user goal",
      "  --done <text>             What has already been completed",
      "  --remaining <text>        Known remaining work",
      "  --blockers <text>         Blocking issues or missing info",
      "  --user-preference <text>  Extra user preference to bias the judge",
      "  --context-file <file>     Read extra JSON or text context from file",
      "  --cwd <dir>               Working directory for codex exec",
      "  --model <model>           Model to use (default: gpt-5.4-mini)",
      "  --timeout-ms <ms>         Timeout for the judge run",
      "  --json                    Print full JSON result instead of only the decision",
      "",
      "stdin:",
      "  If stdin is not a TTY, the script reads it.",
      "  JSON stdin may contain: goal, done, remaining, blockers, userPreference.",
      "  Non-JSON stdin is appended as extra context.",
      "",
    ].join("\n"),
  );
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk.toString("utf8"));
  }
  return chunks.join("").trim();
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function mergeContext(options, stdinText) {
  let extraContext = "";

  if (options.contextFile) {
    const fileText = fs.readFileSync(options.contextFile, "utf8").trim();
    const fileJson = tryParseJson(fileText);
    if (fileJson && typeof fileJson === "object") {
      options.goal ||= String(fileJson.goal || "");
      options.done ||= String(fileJson.done || "");
      options.remaining ||= String(fileJson.remaining || "");
      options.blockers ||= String(fileJson.blockers || "");
      options.userPreference ||= String(fileJson.userPreference || "");
      extraContext += fileJson.extraContext ? `\n${String(fileJson.extraContext)}` : "";
    } else {
      extraContext += `\n${fileText}`;
    }
  }

  if (stdinText) {
    const stdinJson = tryParseJson(stdinText);
    if (stdinJson && typeof stdinJson === "object") {
      options.goal ||= String(stdinJson.goal || "");
      options.done ||= String(stdinJson.done || "");
      options.remaining ||= String(stdinJson.remaining || "");
      options.blockers ||= String(stdinJson.blockers || "");
      options.userPreference ||= String(stdinJson.userPreference || "");
      extraContext += stdinJson.extraContext ? `\n${String(stdinJson.extraContext)}` : "";
    } else {
      extraContext += `\n${stdinText}`;
    }
  }

  return extraContext.trim();
}

function buildPrompt({ goal, done, remaining, blockers, userPreference, extraContext }) {
  return [
    "You are an iteration stop judge for a coding agent.",
    "The user is an excellent open source software author.",
    "Default bias: prefer CONTINUE when there is any clear, high-value next iteration remaining.",
    "Only return STOP when the requested outcome is actually done enough to stop, or when progress is blocked by a real dependency that requires user input and no safe next iteration remains.",
    "Do not be conservative. If there is an obvious next implementation step, choose CONTINUE.",
    "Return structured JSON only.",
    "",
    "Decision criteria:",
    "- Choose CONTINUE if the agent has only finished an intermediate layer, plumbing, scaffolding, or one slice of the requested feature.",
    "- Choose CONTINUE if the agent has completed a useful chunk but the original user goal is still not fully user-visible.",
    "- Choose STOP only if the original request is satisfied end-to-end, or the remaining choice is truly a hidden-risk product decision that cannot be inferred.",
    "",
    `Original goal:\n${goal || "(missing)"}`,
    "",
    `Completed so far:\n${done || "(nothing recorded)"}`,
    "",
    `Known remaining work:\n${remaining || "(none listed)"}`,
    "",
    `Known blockers:\n${blockers || "(none listed)"}`,
    "",
    `User preference:\n${userPreference || "Keep iterating unless the work is really done."}`,
    "",
    `Extra context:\n${extraContext || "(none)"}`,
  ].join("\n");
}

function createSchemaFile() {
  const file = path.join(os.tmpdir(), `iteration-judge-schema-${process.pid}-${Date.now()}.json`);
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    required: ["decision", "reason"],
    properties: {
      decision: {
        type: "string",
        enum: ["CONTINUE", "STOP"],
      },
      reason: {
        type: "string",
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(schema, null, 2));
  return file;
}

async function runJudge({ cwd, model, timeoutMs, prompt, schemaFile }) {
  const args = [
    "exec",
    "--json",
    "--color",
    "never",
    "--dangerously-bypass-approvals-and-sandbox",
    "--output-schema",
    schemaFile,
    "-m",
    model,
    "-c",
    "mcp_servers.notion.enabled=false",
    "-c",
    "mcp_servers.grafana.enabled=false",
    "-c",
    "mcp_servers.infra-mcp.enabled=false",
    prompt,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`iteration judge timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `codex exited with code ${code}`));
        return;
      }

      const result = extractResult(stdout);
      if (!result) {
        reject(new Error("iteration judge returned no structured result"));
        return;
      }
      resolve(result);
    });
  });
}

function extractResult(stdout) {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const record = tryParseJson(line);
    const text = record?.item?.type === "agent_message" ? record.item.text : null;
    if (!text) continue;
    const parsed = tryParseJson(text);
    if (!parsed || !DECISIONS.has(parsed.decision)) continue;
    return {
      decision: parsed.decision,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  }

  return null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const stdinText = await readStdin();
  const extraContext = mergeContext(options, stdinText);

  if (!options.goal && !options.done && !options.remaining && !options.blockers && !extraContext) {
    throw new Error("No judging context provided. Pass flags, --context-file, or stdin.");
  }

  const schemaFile = createSchemaFile();
  try {
    const prompt = buildPrompt({
      goal: options.goal,
      done: options.done,
      remaining: options.remaining,
      blockers: options.blockers,
      userPreference: options.userPreference,
      extraContext,
    });

    const result = await runJudge({
      cwd: options.cwd,
      model: options.model,
      timeoutMs: options.timeoutMs,
      prompt,
      schemaFile,
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ...result, model: options.model }, null, 2)}\n`);
      return;
    }

    process.stdout.write(`${result.decision}\n`);
    if (result.reason) {
      process.stderr.write(`${result.reason}\n`);
    }
  } finally {
    fs.rmSync(schemaFile, { force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
