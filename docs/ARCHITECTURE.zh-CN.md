# 架构说明

[English](./ARCHITECTURE.md) | [简体中文](./ARCHITECTURE.zh-CN.md)

## 1. 总览

Blue Core 是一个基于本地 CLI 的多智能体 Web runtime。它的核心思路很简单：

- 本地 `codex` 和 `claude` CLI 负责真正的 agent 工作
- 服务端负责 room、session 和自动编排
- 前端通过 REST 和 SSE 消费状态，而不是消费 terminal 流

这个 runtime 有意不保留 PTY session，也不做 terminal transport。它把 agent 建模成“可以被重复调用的逻辑参与者”。

## 2. 核心分层

### 2.1 应用壳层

入口是 [server.js](/Users/victorzhou/blue-core/server.js)，它通过 [lib/framework/blue-core-app.js](/Users/victorzhou/blue-core/lib/framework/blue-core-app.js) 启动整个框架。

职责：

- 创建 HTTP server
- 挂载静态资源
- 注册 REST API
- 对外暴露 runtime 对象

### 2.2 Session 层

`SessionStore` 是 direct agent conversation 的内存模型。

职责：

- 创建逻辑 session
- 保存 persona、cwd、model 和消息历史
- 把 direct prompt 发给本地 CLI adapter
- 返回结构化的 user / agent 消息

这里的 session 不是长期 shell，而是“可复用的 agent 身份 + 消息历史”。

### 2.3 Room 层

`RoomStore` 管理多智能体的群聊空间。

职责：

- 基于选中的 session 创建 room
- 维护 room 成员和事件历史
- 追加 user、agent、system 事件
- 提供 room snapshot
- 把 room 事件推送到 SSE

room 是协作单元，session 是参与者。

### 2.4 SSE 传输层

`RoomSSEHub` 是房间活动的流式层。

职责：

- 按 room 维护订阅者
- 推送 `message` 事件
- 推送 `turn.started` 事件

选择 SSE 的原因：

- 对单向 room 活动流来说比 WebSocket 更简单
- 对多 agent UI 更容易理解和维护
- 很适合当前这种“旁观房间”的交互形态

### 2.5 Agent 调用层

[lib/cli-adapters.js](/Users/victorzhou/blue-core/lib/cli-adapters.js) 是框架和本地 CLI 之间的边界层。

职责：

- 以非交互 JSON 模式调用 `codex`
- 以非交互 prompt 模式调用 `claude`
- 把输出归一化成纯文本

这也是移除 PTY 的关键设计点：框架只处理结构化调用结果，而不是处理 terminal 重绘噪音。

### 2.6 编排层

[lib/langgraph-room-runner.mjs](/Users/victorzhou/blue-core/lib/langgraph-room-runner.mjs) 负责构建 LangGraph 单轮执行图，`LangGraphAutoplayManager` 负责循环运行它。

职责：

- 决定下一位发言者
- 基于 room 上下文构造 prompt
- 调用被选中的 agent
- 把回复追加回 room
- 在手动中断或达到最大轮次时停止

## 3. 请求和事件流

### 3.1 Direct Session Message

1. 客户端调用 `POST /api/sessions/:id/message`
2. `SessionStore` 先追加一条 user message
3. CLI adapter 调用本地 agent
4. agent 回复被保存为 agent message
5. API 返回这次新增的两条消息

### 3.2 Room Message Broadcast

1. 客户端调用 `POST /api/rooms/:id/messages`
2. `RoomStore` 追加一条 room user event
3. room snapshot 被更新
4. SSE 订阅方收到新事件

### 3.3 Autoplay Loop

1. 客户端调用 `POST /api/rooms/:id/autoplay/start`
2. `LangGraphAutoplayManager` 把 room 标记为 active
3. 可以先插入一条 seed message
4. 每一轮会：
   - 发出 `turn.started`
   - 汇总最近的 room history
   - 调用当前选中的本地 agent
   - 把 agent 回复追加进 room
   - 发出一条 `message` SSE 事件
5. 循环在以下情况停止：
   - `POST /api/rooms/:id/autoplay/stop`
   - `POST /api/rooms/autoplay/stop-all`
   - 达到最大轮次
   - agent 调用失败

## 4. 默认模板

模板本质上是工厂函数，用来定义：

- 要创建哪些 session
- 这些 session 用什么 persona
- 要创建哪个 room
- 用什么 seed message 启动这个 room

当前内置模板：

- `new-father-edu-psych`
- `menti-clone-build`

这套模板机制，是基于 Blue Core 构建垂直场景 multi-agent app 的最快路径。

## 5. 设计原则

### 5.1 框架内不做 PTY

Blue Core 有意不内建 PTY 和 raw terminal transport，原因是：

- terminal 输出噪音很大，很难稳定解析
- 交互式 shell 状态很难在协作型 UI 里干净表达
- 大多数 app builder 真正要的是“消息级编排”，而不是“终端模拟”

### 5.2 Local CLI First

这个框架假设你的本地 `codex` / `claude` CLI 已经可用，并直接把它们当成执行后端。

好处：

- 可以复用本地登录态
- 不强迫每个 app 都先配 API key
- 执行模型更贴近本地开发工作流

### 5.3 Room 是主抽象

这个框架最核心的产品抽象是 room：

- 多个本地 agent
- 一条共享 instruction
- 一条共享事件流
- 可观察的 autoplay

这让 Blue Core 同时适合作为 runtime，也适合作为 UI substrate。

## 6. 当前限制

- 状态仍然只在内存里
- 还没有持久化数据库
- 没有 per-room 权限控制
- 没有任务队列执行层
- 没有内建 metrics 或 tracing

## 7. 建议的下一步

- 用 SQLite 持久化 sessions、rooms、events
- 抽出可插拔的 storage interface
- 为常见 app 形态补更多 examples
- 更正式地整理 framework public API
