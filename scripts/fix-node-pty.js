const fs = require("node:fs");
const path = require("node:path");

const candidates = [
  path.join(__dirname, "..", "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper"),
  path.join(__dirname, "..", "node_modules", "node-pty", "prebuilds", "darwin-x64", "spawn-helper"),
];

for (const filePath of candidates) {
  if (!fs.existsSync(filePath)) continue;

  const currentMode = fs.statSync(filePath).mode;
  const desiredMode = currentMode | 0o111;

  if (currentMode !== desiredMode) {
    fs.chmodSync(filePath, desiredMode);
    console.log(`Marked executable: ${filePath}`);
  }
}
