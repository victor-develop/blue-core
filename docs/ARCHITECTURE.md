# Architecture

[English](./ARCHITECTURE.md) | [简体中文](./ARCHITECTURE.zh-CN.md)

## 1. Overview

Blue Core is a local CLI-backed multi-agent runtime for Web applications. It is designed around a simple idea:

- local `codex` and `claude` CLIs do the real agent work
- the server manages rooms, sessions, and orchestration
- the frontend consumes REST and SSE instead of terminal streams

The runtime deliberately does not keep PTY sessions or terminal transport. It models agents as logical participants that can be invoked repeatedly.

## 2. Core Layers

### 2.1 Application Shell

The entrypoint is [`server.js`](/Users/victorzhou/blue-core/server.js), which boots the framework via [`lib/framework/blue-core-app.js`](/Users/victorzhou/blue-core/lib/framework/blue-core-app.js).

Responsibilities:

- create the HTTP server
- mount static assets
- register REST APIs
- expose runtime objects

### 2.2 Session Layer

The `SessionStore` is an in-memory model of direct agent conversations.

Responsibilities:

- create logical sessions
- store persona, cwd, model, and message history
- send direct prompts to a local CLI adapter
- return structured user/agent messages

A session is not a long-lived shell. It is a reusable agent identity plus message history.

### 2.3 Room Layer

The `RoomStore` manages multi-agent group conversations.

Responsibilities:

- create rooms from selected sessions
- keep room members and event history
- append user, agent, and system events
- expose room snapshots
- push room events into SSE

Rooms are the collaboration unit. Sessions are the participants.

### 2.4 SSE Transport

`RoomSSEHub` is the streaming layer for room activity.

Responsibilities:

- maintain subscribers per room
- emit `message` events
- emit `turn.started` events

Why SSE:

- simpler than WebSocket for one-way room activity
- easier to reason about in multi-agent UIs
- fits the current “observe the room” experience well

### 2.5 Agent Invocation Layer

[`lib/cli-adapters.js`](/Users/victorzhou/blue-core/lib/cli-adapters.js) is the boundary between the framework and local CLIs.

Responsibilities:

- invoke `codex` in non-interactive JSON mode
- invoke `claude` in non-interactive prompt mode
- normalize output into plain text

This is the key design choice behind removing PTY support: the framework only deals with structured invocation results, not terminal repaint noise.

### 2.6 Orchestration Layer

[`lib/langgraph-room-runner.mjs`](/Users/victorzhou/blue-core/lib/langgraph-room-runner.mjs) builds a LangGraph turn graph, and `LangGraphAutoplayManager` runs it in loops.

Responsibilities:

- decide the next speaker
- build prompts from room context
- invoke the selected agent
- append the reply back into the room
- stop on manual interrupt or max turn limit

## 3. Request and Event Flows

### 3.1 Direct Session Message

1. Client sends `POST /api/sessions/:id/message`
2. `SessionStore` appends the user message
3. CLI adapter invokes the local agent
4. The agent reply is stored as an agent message
5. The API returns both new messages

### 3.2 Room Message Broadcast

1. Client sends `POST /api/rooms/:id/messages`
2. `RoomStore` appends a room user event
3. The room snapshot is updated
4. SSE subscribers receive the new event

### 3.3 Autoplay Loop

1. Client sends `POST /api/rooms/:id/autoplay/start`
2. `LangGraphAutoplayManager` marks the room as active
3. A seed message may be appended
4. For each turn:
   - emit `turn.started`
   - compile recent room history
   - invoke the selected local agent
   - append the agent reply
   - emit a `message` SSE event
5. The loop stops on:
   - `POST /api/rooms/:id/autoplay/stop`
   - `POST /api/rooms/autoplay/stop-all`
   - max turn limit
   - invocation failure

## 4. Default Templates

Templates are factories that define:

- which sessions to create
- which personas they use
- what room to create
- which seed message starts the room

Current built-in templates:

- `new-father-edu-psych`
- `menti-clone-build`

This template system is the fastest path to building domain-specific multi-agent apps on top of Blue Core.

## 5. Design Principles

### 5.1 No PTY in the Framework

Blue Core intentionally avoids PTY and raw terminal transport because:

- terminal output is noisy and hard to parse reliably
- interactive shell state is difficult to represent cleanly in collaborative UIs
- most app builders want message-level orchestration, not terminal emulation

### 5.2 Local CLI First

The framework assumes local authenticated CLIs are available and uses them as the execution backend.

Benefits:

- reuse local auth state
- avoid forcing API key wiring into every app
- keep the execution model close to local development workflows

### 5.3 Rooms as the Main Abstraction

The primary product concept is a room:

- multiple local agents
- shared instruction
- shared event stream
- observable autoplay

This makes the framework useful both as a runtime and as a UI substrate.

## 6. Current Limitations

- state is in memory only
- no persistent database yet
- no per-room access control
- no queued job execution layer
- no built-in metrics or tracing

## 7. Suggested Next Steps

- add SQLite persistence for sessions, rooms, and events
- expose a pluggable storage interface
- add packaged examples for common app patterns
- publish the framework API more formally
