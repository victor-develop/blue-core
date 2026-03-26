const { spawn } = require("node:child_process");
const readline = require("node:readline");
const {
  collectCliOutput,
  extractFinalText,
  normalizeCliRecord,
  RAW_EVENT_TYPES,
  tryParseJson,
} = require("./cli-event-normalizer");

function runCommand(command, args, { cwd, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
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
        reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function getCliInvocation(model, prompt) {
  if (model === "codex") {
    return {
      command: "codex",
      args: [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--json",
        "--color",
        "never",
        "-c",
        "mcp_servers.notion.enabled=false",
        "-c",
        "mcp_servers.grafana.enabled=false",
        "-c",
        "mcp_servers.infra-mcp.enabled=false",
        prompt,
      ],
    };
  }

  if (model === "claude") {
    return {
      command: "claude",
      args: [
        "--dangerously-skip-permissions",
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        prompt,
      ],
    };
  }

  if (model === "opencode") {
    return {
      command: "opencode",
      args: ["run", "--format", "json", prompt],
    };
  }

  throw new Error(`Unsupported local agent model: ${model}`);
}

async function* invokeLocalAgentStream({ model, prompt, cwd, timeoutMs = 120000 }) {
  const { command, args } = getCliInvocation(model, prompt);
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  let stdout = "";
  let index = 0;
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const closePromise = new Promise((resolve, reject) => {
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
        return;
      }
      resolve();
    });
  });

  const rl = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });

  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;
      stdout += `${rawLine}\n`;
      const record = tryParseJson(line);
      if (!record) continue;
      yield normalizeCliRecord(model, record, index, line);
      index += 1;
    }
    await closePromise;
  } finally {
    rl.close();
  }
}

async function runCodex(prompt, { cwd }) {
  const { args } = getCliInvocation("codex", prompt);
  const { stdout } = await runCommand("codex", args, { cwd });
  const output = collectCliOutput("codex", stdout);
  if (!output.text) {
    throw new Error("Codex returned no agent message.");
  }
  return output;
}

async function runClaude(prompt, { cwd }) {
  const { args } = getCliInvocation("claude", prompt);
  const { stdout } = await runCommand("claude", args, { cwd });
  const output = collectCliOutput("claude", stdout);
  if (!output.text) {
    throw new Error("Claude returned no text.");
  }
  return output;
}

async function runOpencode(prompt, { cwd }) {
  const { args } = getCliInvocation("opencode", prompt);
  const { stdout } = await runCommand("opencode", args, { cwd });
  const output = collectCliOutput("opencode", stdout);
  if (!output.text) {
    throw new Error("OpenCode returned no text.");
  }
  return output;
}

async function invokeLocalAgentDetailed({ model, prompt, cwd }) {
  const events = [];
  for await (const event of invokeLocalAgentStream({ model, prompt, cwd })) {
    events.push(event);
  }

  const text = extractFinalText(model, events, "");
  if (!text) {
    const labels = {
      codex: "Codex returned no agent message.",
      claude: "Claude returned no text.",
      opencode: "OpenCode returned no text.",
    };
    throw new Error(labels[model] || `No text returned for ${model}.`);
  }

  return {
    source: model,
    rawEventCount: events.length,
    events,
    text,
  };
}

async function invokeLocalAgent({ model, prompt, cwd }) {
  const result = await invokeLocalAgentDetailed({ model, prompt, cwd });
  return result.text;
}

module.exports = {
  RAW_EVENT_TYPES,
  invokeLocalAgentStream,
  invokeLocalAgentDetailed,
  invokeLocalAgent,
};
