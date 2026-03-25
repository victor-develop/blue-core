const path = require("path");
const { createBlueCoreApp, createDefaultTemplates } = require("../../lib/framework");

const PORT = Number(process.env.PORT || 3791);
const exampleRoot = path.resolve(__dirname, "..", "..");

const templates = [
  ...createDefaultTemplates(exampleRoot),
  {
    id: "pm-eng-ship-room",
    title: "PM + Engineer Ship Room",
    description: "A product manager and engineer negotiate scope and ship a focused feature.",
    build: (workspaceRoot) => {
      const projectDir = path.join(workspaceRoot, "ship-room");
      return {
        sessions: [
          {
            model: "claude",
            title: "ProductLead",
            cwd: projectDir,
            persona:
              "You are a product lead. You narrow scope aggressively, define acceptance criteria, and keep discussion focused on shipping.",
          },
          {
            model: "codex",
            title: "EngineerLead",
            cwd: projectDir,
            persona:
              "You are an engineer lead. You make implementation tradeoffs explicit, write code pragmatically, and push toward a running version quickly.",
          },
        ],
        roomTitle: "PM Engineer Ship Room",
        instruction:
          "Collaborate to ship a single focused feature in the working directory. Clarify scope, implement the code, and keep each room message short and concrete.",
        seedMessage:
          "Agree on a tight scope, define the stack, split work, and begin implementation immediately.",
      };
    },
  },
];

const { server } = createBlueCoreApp({
  rootDir: exampleRoot,
  templates,
  apiPrefix: "/api",
});

server.listen(PORT, () => {
  console.log(`Custom template example running at http://localhost:${PORT}`);
});
