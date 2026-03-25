const { createBlueCoreApp } = require("./lib/framework/blue-core-app");

const PORT = Number(process.env.PORT || 3789);
const { server } = createBlueCoreApp({
  rootDir: __dirname,
});

server.listen(PORT, () => {
  console.log(`Local CLI bridge running at http://localhost:${PORT}`);
});
