const RAW_EVENT_TYPES = {
  codex: {
    topLevel: [
      "thread.started",
      "turn.started",
      "turn.completed",
      "turn.failed",
      "item.started",
      "item.updated",
      "item.completed",
      "error",
    ],
    itemTypes: [
      "agent_message",
      "reasoning",
      "command_execution",
      "file_change",
      "mcp_tool_call",
      "collab_tool_call",
      "web_search",
      "todo_list",
      "error",
    ],
  },
  claude: {
    topLevel: [
      "user",
      "assistant",
      "result",
      "system",
      "stream_event",
      "rate_limit_event",
      "tool_progress",
      "auth_status",
      "tool_use_summary",
      "prompt_suggestion",
      "streamlined_text",
      "streamlined_tool_use_summary",
    ],
    systemSubtypes: [
      "init",
      "compact_boundary",
      "status",
      "api_retry",
      "local_command_output",
      "hook_started",
      "hook_progress",
      "hook_response",
      "files_persisted",
      "task_notification",
      "task_started",
      "task_progress",
      "elicitation_complete",
    ],
    resultSubtypes: [
      "success",
      "error_during_execution",
      "error_max_turns",
      "error_max_budget_usd",
      "error_max_structured_output_retries",
    ],
  },
  opencode: {
    // `opencode run --format json` emits a compact CLI-facing stream.
    topLevel: ["step_start", "text", "reasoning", "tool_use", "step_finish"],
    // The underlying source model is message/part based.
    sourceEvents: [
      "session.created",
      "session.updated",
      "session.deleted",
      "session.diff",
      "session.error",
      "message.updated",
      "message.removed",
      "message.part.updated",
      "message.part.delta",
      "message.part.removed",
    ],
    partTypes: [
      "text",
      "subtask",
      "reasoning",
      "file",
      "tool",
      "step-start",
      "step-finish",
      "snapshot",
      "patch",
      "agent",
      "retry",
      "compaction",
    ],
  },
};

function tryParseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function parseJsonl(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => ({
      index,
      line,
      record: tryParseJson(line),
    }))
    .filter((entry) => entry.record);
}

function makeEntry(record, index = 0, line = "") {
  return {
    index,
    line,
    record,
  };
}

function phaseFromStatus(status) {
  if (!status) return "updated";
  if (status === "in_progress" || status === "pending" || status === "running") return "started";
  if (status === "completed" || status === "success") return "completed";
  if (status === "failed" || status === "error" || status === "declined") return "failed";
  return "updated";
}

function makeEvent(source, entry, patch) {
  const record = entry.record;
  return {
    id: `${source}:${entry.index}`,
    source,
    rawType: record.type || "unknown",
    rawSubType: record.subtype || null,
    family: "meta",
    phase: "updated",
    ...patch,
    raw: record,
  };
}

function normalizeCodexEvent(entry) {
  const record = entry.record;

  if (record.type === "thread.started") {
    return makeEvent("codex", entry, {
      family: "session",
      phase: "started",
      threadId: record.thread_id,
    });
  }

  if (record.type === "turn.started") {
    return makeEvent("codex", entry, {
      family: "turn",
      phase: "started",
    });
  }

  if (record.type === "turn.completed") {
    return makeEvent("codex", entry, {
      family: "turn",
      phase: "completed",
      usage: record.usage || null,
    });
  }

  if (record.type === "turn.failed") {
    return makeEvent("codex", entry, {
      family: "turn",
      phase: "failed",
      error: record.error?.message || null,
    });
  }

  if (record.type === "error") {
    return makeEvent("codex", entry, {
      family: "error",
      phase: "failed",
      error: record.message || "Unknown codex error",
    });
  }

  const item = record.item;
  const itemType = item?.type;
  const itemState = record.type === "item.started" ? "started" : record.type === "item.completed" ? "completed" : "updated";

  if (!item || !itemType) {
    return makeEvent("codex", entry, {
      family: "meta",
      phase: itemState,
    });
  }

  if (itemType === "agent_message") {
    return makeEvent("codex", entry, {
      family: "message",
      phase: itemState,
      actor: "assistant",
      itemId: item.id,
      text: item.text || "",
    });
  }

  if (itemType === "reasoning") {
    return makeEvent("codex", entry, {
      family: "reasoning",
      phase: itemState,
      itemId: item.id,
      text: item.text || "",
    });
  }

  if (itemType === "todo_list") {
    return makeEvent("codex", entry, {
      family: "plan",
      phase: itemState,
      itemId: item.id,
      plan: Array.isArray(item.items) ? item.items : [],
    });
  }

  if (itemType === "file_change") {
    return makeEvent("codex", entry, {
      family: "file",
      phase: phaseFromStatus(item.status),
      itemId: item.id,
      fileChanges: item.changes || [],
    });
  }

  if (itemType === "error") {
    return makeEvent("codex", entry, {
      family: "error",
      phase: itemState,
      itemId: item.id,
      error: item.message || "Codex surfaced an item error",
    });
  }

  if (itemType === "command_execution") {
    return makeEvent("codex", entry, {
      family: "tool",
      phase: phaseFromStatus(item.status),
      itemId: item.id,
      toolKind: "command",
      toolName: "command_execution",
      command: item.command || "",
      output: item.aggregated_output || "",
      exitCode: item.exit_code ?? null,
    });
  }

  if (itemType === "mcp_tool_call") {
    return makeEvent("codex", entry, {
      family: "tool",
      phase: phaseFromStatus(item.status),
      itemId: item.id,
      toolKind: "mcp",
      toolName: item.tool || "",
      server: item.server || "",
      input: item.arguments || null,
      output: item.result || null,
      error: item.error?.message || null,
    });
  }

  if (itemType === "collab_tool_call") {
    return makeEvent("codex", entry, {
      family: "tool",
      phase: phaseFromStatus(item.status),
      itemId: item.id,
      toolKind: "collab",
      toolName: item.tool || "",
      input: {
        senderThreadId: item.sender_thread_id,
        receiverThreadIds: item.receiver_thread_ids,
        prompt: item.prompt,
      },
      output: item.agents_states || null,
    });
  }

  if (itemType === "web_search") {
    return makeEvent("codex", entry, {
      family: "tool",
      phase: itemState,
      itemId: item.id,
      toolKind: "web_search",
      toolName: "web_search",
      input: {
        query: item.query,
        action: item.action,
      },
    });
  }

  return makeEvent("codex", entry, {
    family: "meta",
    phase: itemState,
    itemId: item.id,
  });
}

function assistantTextFromClaudeMessage(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function normalizeClaudeEvent(entry) {
  const record = entry.record;

  if (record.type === "system" && record.subtype === "init") {
    return makeEvent("claude", entry, {
      family: "session",
      phase: "started",
      sessionId: record.session_id,
      status: {
        cwd: record.cwd,
        model: record.model,
        permissionMode: record.permissionMode,
        tools: record.tools || [],
      },
    });
  }

  if (record.type === "assistant") {
    return makeEvent("claude", entry, {
      family: "message",
      phase: "completed",
      actor: "assistant",
      sessionId: record.session_id,
      text: assistantTextFromClaudeMessage(record.message),
      usage: record.message?.usage || null,
    });
  }

  if (record.type === "user") {
    return makeEvent("claude", entry, {
      family: "message",
      phase: record.isReplay ? "updated" : "completed",
      actor: "user",
      sessionId: record.session_id,
      text: record.message?.content || "",
    });
  }

  if (record.type === "result") {
    return makeEvent("claude", entry, {
      family: "turn",
      phase: record.subtype === "success" ? "completed" : "failed",
      sessionId: record.session_id,
      text: typeof record.result === "string" ? record.result : "",
      usage: record.usage || null,
      costUsd: record.total_cost_usd ?? null,
      error: Array.isArray(record.errors) ? record.errors.join("\n") : null,
    });
  }

  if (record.type === "rate_limit_event") {
    return makeEvent("claude", entry, {
      family: "rate_limit",
      phase: "updated",
      sessionId: record.session_id,
      status: record.rate_limit_info || null,
    });
  }

  if (record.type === "tool_progress") {
    return makeEvent("claude", entry, {
      family: "tool",
      phase: "updated",
      sessionId: record.session_id,
      toolKind: "tool_progress",
      toolName: record.tool_name,
      itemId: record.tool_use_id,
      status: {
        elapsedSeconds: record.elapsed_time_seconds,
        taskId: record.task_id || null,
      },
    });
  }

  if (record.type === "streamlined_text") {
    return makeEvent("claude", entry, {
      family: "message",
      phase: "updated",
      actor: "assistant",
      sessionId: record.session_id,
      text: record.text || "",
    });
  }

  if (record.type === "streamlined_tool_use_summary" || record.type === "tool_use_summary") {
    return makeEvent("claude", entry, {
      family: "tool",
      phase: "updated",
      sessionId: record.session_id,
      toolKind: "summary",
      toolName: "tool_summary",
      text: record.tool_summary || record.summary || "",
    });
  }

  if (record.type === "auth_status") {
    return makeEvent("claude", entry, {
      family: "status",
      phase: "updated",
      sessionId: record.session_id,
      status: {
        isAuthenticating: record.isAuthenticating,
        output: record.output || [],
        error: record.error || null,
      },
    });
  }

  if (record.type === "prompt_suggestion") {
    return makeEvent("claude", entry, {
      family: "meta",
      phase: "updated",
      sessionId: record.session_id,
      text: record.suggestion || "",
    });
  }

  if (record.type === "stream_event") {
    return makeEvent("claude", entry, {
      family: "stream",
      phase: "updated",
      sessionId: record.session_id,
      input: record.event,
      itemId: record.parent_tool_use_id || null,
    });
  }

  if (record.type === "system") {
    const family =
      record.subtype === "task_started" || record.subtype === "task_progress" || record.subtype === "task_notification"
        ? "task"
        : record.subtype && record.subtype.startsWith("hook_")
          ? "hook"
          : "status";

    return makeEvent("claude", entry, {
      family,
      phase:
        record.subtype === "task_notification"
          ? record.status === "completed"
            ? "completed"
            : "failed"
          : "updated",
      sessionId: record.session_id,
      status: {
        subtype: record.subtype,
        payload: record,
      },
      text: record.content || record.summary || record.description || "",
    });
  }

  return makeEvent("claude", entry, {
    family: "meta",
    phase: "updated",
    sessionId: record.session_id,
  });
}

function normalizeOpencodeEvent(entry) {
  const record = entry.record;
  const part = record.part || null;

  if (record.type === "step_start") {
    return makeEvent("opencode", entry, {
      family: "turn",
      phase: "started",
      sessionId: record.sessionID,
      messageId: part?.messageID || null,
      itemId: part?.id || null,
    });
  }

  if (record.type === "step_finish") {
    return makeEvent("opencode", entry, {
      family: "turn",
      phase: "completed",
      sessionId: record.sessionID,
      messageId: part?.messageID || null,
      itemId: part?.id || null,
      usage: part?.tokens || null,
      costUsd: part?.cost ?? null,
      status: {
        reason: part?.reason || null,
        snapshot: part?.snapshot || null,
      },
    });
  }

  if (record.type === "text") {
    return makeEvent("opencode", entry, {
      family: "message",
      phase: "completed",
      actor: "assistant",
      sessionId: record.sessionID,
      messageId: part?.messageID || null,
      itemId: part?.id || null,
      text: part?.text || "",
    });
  }

  if (record.type === "reasoning") {
    return makeEvent("opencode", entry, {
      family: "reasoning",
      phase: "completed",
      sessionId: record.sessionID,
      messageId: part?.messageID || null,
      itemId: part?.id || null,
      text: part?.text || "",
    });
  }

  if (record.type === "tool_use") {
    return makeEvent("opencode", entry, {
      family: "tool",
      phase: phaseFromStatus(part?.state?.status),
      sessionId: record.sessionID,
      messageId: part?.messageID || null,
      itemId: part?.id || null,
      toolKind: "tool",
      toolName: part?.tool || "",
      input: part?.state?.input || null,
      output: part?.state?.output || null,
      error: part?.state?.error || null,
      status: {
        toolState: part?.state?.status || null,
        metadata: part?.state?.metadata || part?.metadata || null,
      },
    });
  }

  return makeEvent("opencode", entry, {
    family: "meta",
    phase: "updated",
    sessionId: record.sessionID,
  });
}

function normalizeCliEvent(source, entry) {
  if (source === "codex") return normalizeCodexEvent(entry);
  if (source === "claude") return normalizeClaudeEvent(entry);
  if (source === "opencode") return normalizeOpencodeEvent(entry);
  throw new Error(`Unsupported CLI source: ${source}`);
}

function normalizeCliRecord(source, record, index = 0, line = "") {
  return normalizeCliEvent(source, makeEntry(record, index, line));
}

function extractFinalText(source, normalizedEvents, stdout) {
  if (source === "codex") {
    const messages = normalizedEvents
      .filter((event) => event.family === "message" && event.actor === "assistant" && event.text)
      .map((event) => event.text.trim())
      .filter(Boolean);
    return messages.join("\n").trim();
  }

  if (source === "claude") {
    const assistantMessages = normalizedEvents
      .filter((event) => event.family === "message" && event.actor === "assistant" && event.text)
      .map((event) => event.text.trim())
      .filter(Boolean);
    if (assistantMessages.length) return assistantMessages.join("\n").trim();

    const resultEvent = [...normalizedEvents]
      .reverse()
      .find((event) => event.family === "turn" && typeof event.text === "string" && event.text.trim());
    return resultEvent?.text?.trim() || "";
  }

  if (source === "opencode") {
    return normalizedEvents
      .filter((event) => event.family === "message" && event.text)
      .map((event) => event.text.trim())
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return stdout.trim();
}

function collectCliOutput(source, stdout) {
  const parsedEntries = parseJsonl(stdout);
  const events = parsedEntries.map((entry) => normalizeCliEvent(source, entry));
  const text = extractFinalText(source, events, stdout);

  return {
    source,
    rawEventCount: parsedEntries.length,
    events,
    text,
  };
}

module.exports = {
  RAW_EVENT_TYPES,
  collectCliOutput,
  normalizeCliEvent,
  normalizeCliRecord,
  extractFinalText,
  tryParseJson,
};
