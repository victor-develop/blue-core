const { spawn } = require("node:child_process");

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

async function runCodex(prompt, { cwd }) {
  const args = [
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
  ];

  const { stdout } = await runCommand("codex", args, { cwd });
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const messages = [];

  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      if (item.type === "item.completed" && item.item?.type === "agent_message" && item.item?.text) {
        messages.push(item.item.text);
      }
    } catch {
      // Ignore non-JSON noise lines.
    }
  }

  const text = messages.join("\n").trim();
  if (!text) {
    throw new Error("Codex returned no agent message.");
  }
  return text;
}

async function runClaude(prompt, { cwd }) {
  const args = ["--dangerously-skip-permissions", "-p", prompt];
  const { stdout } = await runCommand("claude", args, { cwd });
  const text = stdout.trim();
  if (!text) {
    throw new Error("Claude returned no text.");
  }
  return text;
}

async function invokeLocalAgent({ model, prompt, cwd }) {
  if (model === "codex") {
    return runCodex(prompt, { cwd });
  }
  if (model === "claude") {
    return runClaude(prompt, { cwd });
  }
  throw new Error(`Unsupported local agent model: ${model}`);
}

module.exports = {
  invokeLocalAgent,
};
