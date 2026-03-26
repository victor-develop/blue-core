# CLI Event Abstraction

This document compares the non-interactive JSON/JSONL outputs exposed by `codex`, `claude`, and `opencode`, then defines the normalized event shape used by Blue Core.

## 1. Raw Event Enums

### 1.1 Codex

Source:

- `openai/codex`
- `codex-rs/exec/src/exec_events.rs`

Top-level `type` values:

- `thread.started`
- `turn.started`
- `turn.completed`
- `turn.failed`
- `item.started`
- `item.updated`
- `item.completed`
- `error`

Nested `item.type` values:

- `agent_message`
- `reasoning`
- `command_execution`
- `file_change`
- `mcp_tool_call`
- `collab_tool_call`
- `web_search`
- `todo_list`
- `error`

Design note:

- Codex is `turn + item` oriented.
- Top-level events describe lifecycle.
- Work details are carried by `item.*` records.

### 1.2 Claude Code

Source:

- local installed bundle `@anthropic-ai/claude-code`
- stream mode: `claude -p --verbose --output-format stream-json`

Top-level `type` values visible in the CLI schema:

- `user`
- `assistant`
- `result`
- `system`
- `stream_event`
- `rate_limit_event`
- `tool_progress`
- `auth_status`
- `tool_use_summary`
- `prompt_suggestion`
- `streamlined_text`
- `streamlined_tool_use_summary`

Observed `system.subtype` values in the bundle schema:

- `init`
- `compact_boundary`
- `status`
- `api_retry`
- `local_command_output`
- `hook_started`
- `hook_progress`
- `hook_response`
- `files_persisted`
- `task_notification`
- `task_started`
- `task_progress`
- `elicitation_complete`

Observed `result.subtype` values:

- `success`
- `error_during_execution`
- `error_max_turns`
- `error_max_budget_usd`
- `error_max_structured_output_retries`

Design note:

- Claude is `session/init + assistant/result + misc system telemetry` oriented.
- `stream_event` is intentionally opaque in the bundled schema, so it should be treated as passthrough.

### 1.3 OpenCode

Sources:

- `anomalyco/opencode`
- `packages/opencode/src/cli/cmd/run.ts`
- `packages/opencode/src/session/message-v2.ts`

`opencode run --format json` top-level `type` values emitted by the CLI formatter:

- `step_start`
- `text`
- `reasoning`
- `tool_use`
- `step_finish`

Underlying message/part source model:

- bus/session events:
  - `session.created`
  - `session.updated`
  - `session.deleted`
  - `session.diff`
  - `session.error`
- message events:
  - `message.updated`
  - `message.removed`
  - `message.part.updated`
  - `message.part.delta`
  - `message.part.removed`
- part `type` values:
  - `text`
  - `subtask`
  - `reasoning`
  - `file`
  - `tool`
  - `step-start`
  - `step-finish`
  - `snapshot`
  - `patch`
  - `agent`
  - `retry`
  - `compaction`

Design note:

- OpenCode is `message + part` oriented.
- The CLI JSON formatter is already a thin projection over the richer source event bus.

## 2. Why The Shapes Differ

- `codex` treats a prompt execution as a turn and emits durable work items inside that turn.
- `claude` treats the stream as a mixed transcript/telemetry channel with separate final `result`.
- `opencode` treats the response as a message made of typed parts and only later projects that into CLI JSON.

These are similar semantically, but they disagree on the unit of progress:

- Codex: turn/item
- Claude: message/result/system
- OpenCode: message/part

## 3. Normalized Event Shape

Blue Core normalizes all three into one event model:

```js
{
  id: "claude:7",
  source: "claude",
  rawType: "assistant",
  rawSubType: null,
  family: "message",
  phase: "completed",
  actor: "assistant",
  sessionId: "uuid-or-session-id",
  messageId: null,
  itemId: null,
  text: "final or partial text",
  usage: null,
  costUsd: null,
  toolKind: null,
  toolName: null,
  command: null,
  input: null,
  output: null,
  error: null,
  status: null,
  fileChanges: null,
  plan: null,
  raw: {}
}
```

Field semantics:

- `family`: the UI bucket
  - `session`, `turn`, `message`, `reasoning`, `tool`, `plan`, `file`, `status`, `task`, `hook`, `rate_limit`, `error`, `stream`, `meta`
- `phase`: normalized lifecycle
  - `started`, `updated`, `completed`, `failed`
- `rawType` / `rawSubType`: preserve source-specific enums for debugging and future UI specialization
- `raw`: full original payload, always preserved

## 4. Cross-Provider Mapping

### 4.1 Final assistant text

- Codex: `item.completed` where `item.type === "agent_message"`
- Claude: `assistant.message.content[*].text`, fallback to `result.result`
- OpenCode: `text.part.text`

### 4.2 Reasoning

- Codex: `reasoning`
- Claude: currently only safely available through opaque `stream_event` or internal streamlined outputs
- OpenCode: `reasoning`

### 4.3 Tool execution

- Codex:
  - `command_execution`
  - `mcp_tool_call`
  - `collab_tool_call`
  - `web_search`
- Claude:
  - `tool_progress`
  - `tool_use_summary`
  - some `stream_event` payloads
- OpenCode:
  - `tool_use` from CLI formatter
  - `tool` parts in source events

### 4.4 Turn boundaries

- Codex:
  - `turn.started`
  - `turn.completed`
  - `turn.failed`
- Claude:
  - no explicit top-level turn start in print mode
  - `result` is the strongest completion boundary
- OpenCode:
  - `step_start`
  - `step_finish`

## 5. Validation Result

The abstraction layer in [`lib/cli-event-normalizer.js`](/Users/victorzhou/blue-core/lib/cli-event-normalizer.js) successfully maps:

- Codex `exec --json`
- Claude Code `--print --verbose --output-format stream-json`
- OpenCode `run --format json`

That means a future process-visualization UI can render one provider-agnostic timeline while still retaining source-native detail in `raw`.

## 6. Streaming API

Blue Core now exposes a streaming-first adapter shape in [`lib/cli-adapters.js`](/Users/victorzhou/blue-core/lib/cli-adapters.js):

- `invokeLocalAgentStream({ model, prompt, cwd })`
  - returns `AsyncGenerator<NormalizedCliEvent>`
- `invokeLocalAgentDetailed({ model, prompt, cwd })`
  - consumes the stream and returns the full aggregated result

This makes the adapter layer fit naturally with:

- CLI stdout JSONL
- server-side SSE fanout
- optional future UI-side reactive wrappers
