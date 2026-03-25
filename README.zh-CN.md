# Blue Core

[English](./README.md) | [简体中文](./README.zh-CN.md)

Blue Core 是一个基于本地 `codex` 和 `claude` CLI 的多智能体运行时，用来快速构建 Web 形态的 agent app。

它当前提供：

- 逻辑化的本地 agent session
- 基于 SSE 的房间消息流
- 房间内 agent-to-agent 通信
- 基于 LangGraph 的自动轮次编排
- 基于模板的快速启动能力

## 文档索引

- [README (English)](./README.md)
- [README（简体中文）](./README.zh-CN.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [架构说明](./docs/ARCHITECTURE.zh-CN.md)

## 安装

```bash
npm install
npm run build:web
npm start
```

启动后访问 [http://localhost:3789](http://localhost:3789)。

## 仓库结构

- `lib/framework/blue-core-app.js`
  - 可复用的核心 runtime
- `lib/framework/index.js`
  - 对外导出的 framework 入口
- `lib/cli-adapters.js`
  - `codex` / `claude` 的非交互式本地 CLI 适配层
- `lib/langgraph-room-runner.mjs`
  - LangGraph 的单轮执行器
- `server.js`
  - 最小 demo server
- `web/`
  - React + Vite 的演示前端
- `examples/`
  - 最小示例和自定义模板示例

## Public API

```js
const { createBlueCoreApp } = require("./lib/framework");

const { server } = createBlueCoreApp({
  rootDir: __dirname,
});

server.listen(3789);
```

`createBlueCoreApp()` 当前支持这些主要参数：

- `rootDir`
- `defaultCwd`
- `apiPrefix`
- `runners`
- `templates`
- `invokeAgent`

## 模板机制

模板是当前最主要的扩展点。每个模板对象支持：

- `id`
- `title`
- `description`
- `build(workspaceRoot)`

`build()` 需要返回：

- `sessions`
- `roomTitle`
- `instruction`
- `seedMessage`

## 已注册 API

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

## 示例

- `examples/minimal-local-web`
  - 最小 Web 应用示例
- `examples/custom-templates`
  - 演示如何追加你自己的房间模板

## 默认权限

默认 runner 是高权限模式：

- `codex`: `--dangerously-bypass-approvals-and-sandbox`
- `claude`: `--dangerously-skip-permissions`

这样 agent 才能真正进入目标目录执行修改。只建议在可信机器和可信工作区里使用。

## 说明

- 当前 runtime 状态仍然是内存态
- 重启后 room 和 session 会清空
- PTY 和 terminal streaming 已经被有意移出这个 runtime
- 这里的 session 是逻辑会话，不是长期存活的 shell 进程
