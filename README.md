# Blue Core

Local CLI-backed multi-agent runtime for building Web agent apps on top of `codex` and `claude`.

It gives you:

- logical local-agent sessions
- SSE room streams
- room-based agent-to-agent communication
- LangGraph autoplay orchestration
- template-driven app bootstrapping

## Install

```bash
npm install
npm run build:web
npm start
```

Open [http://localhost:3789](http://localhost:3789).

## Repo Layout

- `lib/framework/blue-core-app.js`
  - reusable core runtime
- `lib/framework/index.js`
  - public framework entrypoint
- `lib/cli-adapters.js`
  - non-interactive local CLI adapters for `codex` and `claude`
- `lib/langgraph-room-runner.mjs`
  - LangGraph turn runner
- `server.js`
  - minimal demo shell
- `web/`
  - React + Vite demo client
- `examples/`
  - minimal and custom-template examples

## Public API

```js
const { createBlueCoreApp } = require("./lib/framework");

const { server } = createBlueCoreApp({
  rootDir: __dirname,
});

server.listen(3789);
```

`createBlueCoreApp()` currently accepts:

- `rootDir`
- `defaultCwd`
- `apiPrefix`
- `runners`
- `templates`
- `invokeAgent`

## Templates

Templates are the main extension point. Each template object supports:

- `id`
- `title`
- `description`
- `build(workspaceRoot)`

`build()` returns:

- `sessions`
- `roomTitle`
- `instruction`
- `seedMessage`

## Registered API

- `GET /api/health`
- `GET /api/models`
- `GET /api/config`
- `GET /api/sessions`
- `GET /api/sessions/:id`
- `GET /api/rooms`
- `GET /api/rooms/:id`
- `GET /api/rooms/:id/stream`
- `GET /api/templates`
- `POST /api/sessions`
- `POST /api/sessions/:id/message`
- `POST /api/rooms`
- `POST /api/templates/:id/create`
- `POST /api/rooms/:id/messages`
- `POST /api/rooms/:id/autoplay/start`
- `POST /api/rooms/:id/autoplay/stop`
- `POST /api/rooms/autoplay/stop-all`

## Examples

- `examples/minimal-local-web`
  - smallest Web app using the framework as-is
- `examples/custom-templates`
  - shows how to append your own room templates

## Default Permissions

Default runners are intentionally high-permission:

- `codex`: `--dangerously-bypass-approvals-and-sandbox`
- `claude`: `--dangerously-skip-permissions`

That is what makes the agents able to actually work inside a target directory. Use only on trusted machines and trusted workspaces.

## Notes

- runtime state is currently in-memory
- restart clears rooms and sessions
- PTY and terminal streaming are intentionally not part of this runtime
- sessions are logical agent conversations, not long-lived shell processes
