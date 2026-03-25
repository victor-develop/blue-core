const path = require("path");
const { createBlueCoreApp } = require("../../lib/framework");

const PORT = Number(process.env.PORT || 3790);
const exampleRoot = path.resolve(__dirname, "..", "..");

const { server } = createBlueCoreApp({
  rootDir: exampleRoot,
});

server.listen(PORT, () => {
  console.log(`Minimal Blue Core example running at http://localhost:${PORT}`);
});
