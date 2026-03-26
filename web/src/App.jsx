import { useEffect, useMemo, useRef, useState } from "react";

const EMPTY_EVENTS = [];
const EMPTY_MESSAGES = [];

export default function App() {
  const [models, setModels] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [roomEvents, setRoomEvents] = useState(new Map());
  const [roomActivity, setRoomActivity] = useState(new Map());
  const [sessionMessages, setSessionMessages] = useState(new Map());
  const [sessionProcessEvents, setSessionProcessEvents] = useState(new Map());
  const [sessionActivity, setSessionActivity] = useState(new Map());
  const [activeModel, setActiveModel] = useState("codex");
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [activeRoomId, setActiveRoomId] = useState(null);
  const [selectedSessionIds, setSelectedSessionIds] = useState([]);
  const [defaultCwd, setDefaultCwd] = useState("");
  const [composerValue, setComposerValue] = useState("");
  const [launchForm, setLaunchForm] = useState({ cwd: "", title: "", persona: "" });
  const [roomForm, setRoomForm] = useState({ title: "", instruction: "" });
  const [status, setStatus] = useState("Ready.");

  const roomsRef = useRef([]);

  const activeRoom = useMemo(
    () => rooms.find((room) => room.id === activeRoomId) || null,
    [rooms, activeRoomId],
  );
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) || null,
    [sessions, activeSessionId],
  );
  const activeEvents = activeRoom ? roomEvents.get(activeRoom.id) || EMPTY_EVENTS : EMPTY_EVENTS;
  const activeMessages = activeSession ? sessionMessages.get(activeSession.id) || EMPTY_MESSAGES : EMPTY_MESSAGES;
  const activeProcessEvents = activeSession ? sessionProcessEvents.get(activeSession.id) || EMPTY_EVENTS : EMPTY_EVENTS;

  useEffect(() => {
    roomsRef.current = rooms;
  }, [rooms]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      const [modelsRes, configRes, sessionsRes, roomsRes, templatesRes] = await Promise.all([
        fetch("/api/models"),
        fetch("/api/config"),
        fetch("/api/sessions"),
        fetch("/api/rooms"),
        fetch("/api/templates"),
      ]);

      const [{ models: nextModels }, { defaultCwd: cwd }, { sessions: nextSessions }, { rooms: nextRooms }, { templates: nextTemplates }] =
        await Promise.all([
          modelsRes.json(),
          configRes.json(),
          sessionsRes.json(),
          roomsRes.json(),
          templatesRes.json(),
        ]);

      if (cancelled) return;

      setModels(nextModels);
      setActiveModel(nextModels.find((model) => model.id === "codex")?.id || nextModels[0]?.id || "codex");
      setDefaultCwd(cwd);
      setLaunchForm((current) => ({ ...current, cwd }));
      setSessions(nextSessions);
      setRooms(nextRooms);
      setTemplates(nextTemplates);
      if (nextRooms[0]) {
        setActiveRoomId(nextRooms[0].id);
      } else if (nextSessions[0]) {
        setActiveSessionId(nextSessions[0].id);
      }
    }

    bootstrap().catch((error) => setStatus(error.message));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activeRoomId) return undefined;
    let closed = false;

    async function loadSnapshot() {
      const response = await fetch(`/api/rooms/${activeRoomId}`);
      const payload = await response.json();
      if (!response.ok || closed) {
        if (!closed) setStatus(payload.error || "Unable to load room.");
        return;
      }
      setRooms((current) => upsertById(current, payload.room));
      setRoomEvents((current) => {
        const next = new Map(current);
        next.set(activeRoomId, payload.events || []);
        return next;
      });
    }

    loadSnapshot().catch((error) => setStatus(error.message));

    const source = new EventSource(`/api/rooms/${activeRoomId}/stream`);
    source.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);
      if (payload.room) {
        setRooms((current) => upsertById(current, payload.room));
      }
      if (payload.event) {
        setRoomActivity((current) => {
          const next = new Map(current);
          if (payload.event.type === "process") {
            next.set(activeRoomId, payload.event.content || "Agent is working.");
          } else if (payload.event.type === "agent" || payload.event.type === "system") {
            next.delete(activeRoomId);
          }
          return next;
        });
        setRoomEvents((current) => {
          const next = new Map(current);
          const existing = next.get(activeRoomId) || [];
          next.set(activeRoomId, [...existing, payload.event].slice(-400));
          return next;
        });
      }
    });
    source.addEventListener("turn.started", (event) => {
      const payload = JSON.parse(event.data);
      const room = payload.room || roomsRef.current.find((entry) => entry.id === activeRoomId);
      const member = room?.members?.[payload.nextSpeakerIndex];
      setRoomActivity((current) => {
        const next = new Map(current);
        next.set(
          activeRoomId,
          member
            ? `${member.displayName} is taking turn ${Number(payload.turnCount || 0) + 1}.`
            : "An agent is working.",
        );
        return next;
      });
      if (payload.room) {
        setRooms((current) => upsertById(current, payload.room));
      }
    });
    source.onerror = () => {
      if (!closed) setStatus("Room stream disconnected. Reloading the latest snapshot usually fixes it.");
    };

    return () => {
      closed = true;
      source.close();
    };
  }, [activeRoomId]);

  useEffect(() => {
    if (!activeSessionId) return undefined;
    let closed = false;

    loadSession(activeSessionId).catch((error) => setStatus(error.message));

    const source = new EventSource(`/api/sessions/${activeSessionId}/stream`);
    source.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);
      if (payload.session) {
        setSessions((current) => upsertById(current, payload.session));
      }
      if (payload.message) {
        setSessionMessages((current) => {
          const next = new Map(current);
          const existing = next.get(activeSessionId) || [];
          next.set(activeSessionId, [...existing, payload.message].slice(-400));
          return next;
        });
      }
      if (payload.message?.type === "agent") {
        setSessionActivity((current) => {
          const next = new Map(current);
          next.delete(activeSessionId);
          return next;
        });
      }
    });
    source.addEventListener("process", (event) => {
      const payload = JSON.parse(event.data);
      if (payload.session) {
        setSessions((current) => upsertById(current, payload.session));
      }
      if (payload.event) {
        setSessionProcessEvents((current) => {
          const next = new Map(current);
          const existing = next.get(activeSessionId) || [];
          next.set(activeSessionId, [...existing, payload.event].slice(-400));
          return next;
        });
        setSessionActivity((current) => {
          const next = new Map(current);
          next.set(activeSessionId, payload.event.content || "Agent is working.");
          return next;
        });
      }
    });
    source.onerror = () => {
      if (!closed) setStatus("Session stream disconnected. Reloading the latest snapshot usually fixes it.");
    };

    return () => {
      closed = true;
      source.close();
    };
  }, [activeSessionId]);

  const roomStats = activeRoom
    ? [
        activeRoom.mode,
        `${activeRoom.memberCount} members`,
        `${activeRoom.autoplay?.turnCount || 0}/${activeRoom.autoplay?.maxTurns || 0} turns`,
        activeRoom.autoplay?.active ? "Autoplay live" : "Autoplay stopped",
      ]
    : [];
  const activeRoomActivity = activeRoom ? roomActivity.get(activeRoom.id) || "" : "";
  const activeSessionActivity = activeSession ? sessionActivity.get(activeSession.id) || "" : "";
  const activeSessionEntries = activeSession ? mergeEntriesByCreatedAt(activeProcessEvents, activeMessages) : EMPTY_EVENTS;

  async function loadSession(sessionId) {
    const response = await fetch(`/api/sessions/${sessionId}`);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Unable to load session.");
    }
    setSessions((current) => upsertById(current, payload.session));
    setSessionMessages((current) => {
      const next = new Map(current);
      next.set(sessionId, payload.messages || []);
      return next;
    });
    setSessionProcessEvents((current) => {
      const next = new Map(current);
      next.set(sessionId, payload.processEvents || []);
      return next;
    });
  }

  async function refreshRooms() {
    const response = await fetch("/api/rooms");
    const payload = await response.json();
    if (response.ok) {
      setRooms(payload.rooms || []);
    }
  }

  async function handleCreateSession(event) {
    event.preventDefault();
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: activeModel,
        cwd: launchForm.cwd || undefined,
        title: launchForm.title || undefined,
        persona: launchForm.persona || undefined,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setStatus(payload.error || "Unable to create session.");
      return;
    }
    setSessions((current) => upsertById(current, payload.session));
    setActiveRoomId(null);
    setActiveSessionId(payload.session.id);
    setLaunchForm((current) => ({ ...current, title: "", persona: "" }));
  }

  async function handleCreateRoom(event) {
    event.preventDefault();
    if (selectedSessionIds.length < 2) {
      setStatus("Pick at least two sessions.");
      return;
    }
    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: roomForm.title || undefined,
        instruction: roomForm.instruction || undefined,
        sessionIds: selectedSessionIds,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setStatus(payload.error || "Unable to create room.");
      return;
    }
    setRooms((current) => upsertById(current, payload.room));
    setSelectedSessionIds([]);
    setRoomForm({ title: "", instruction: "" });
    setActiveSessionId(null);
    setActiveRoomId(payload.room.id);
  }

  async function handleCreateTemplate(templateId) {
    const response = await fetch(`/api/templates/${templateId}/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: launchForm.cwd || defaultCwd || undefined }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setStatus(payload.error || "Unable to create template room.");
      return;
    }
    setSessions((current) => upsertMany(current, payload.sessions));
    setRooms((current) => upsertById(current, payload.room));
    setActiveSessionId(null);
    setActiveRoomId(payload.room.id);
  }

  async function handleComposerSend() {
    const content = composerValue.trim();
    if (!content) return;

    if (activeRoomId) {
      const response = await fetch(`/api/rooms/${activeRoomId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setStatus(payload.error || "Unable to broadcast message.");
        return;
      }
      setComposerValue("");
      await refreshRooms();
      return;
    }

    if (activeSessionId) {
      const response = await fetch(`/api/sessions/${activeSessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setStatus(payload.error || "Unable to send message.");
        return;
      }
      setSessions((current) => upsertById(current, payload.session));
      setComposerValue("");
      setSessionActivity((current) => {
        const next = new Map(current);
        next.set(activeSessionId, "Agent is working.");
        return next;
      });
    }
  }

  async function handleRoomAction(action) {
    if (!activeRoomId) return;
    const response = await fetch(`/api/rooms/${activeRoomId}/autoplay/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: action === "start" ? JSON.stringify({}) : undefined,
    });
    const payload = await response.json();
    if (!response.ok) {
      setStatus(payload.error || `Unable to ${action} autoplay.`);
      return;
    }
    setRooms((current) => upsertById(current, payload.room));
  }

  async function handleStopAll() {
    const response = await fetch("/api/rooms/autoplay/stop-all", { method: "POST" });
    const payload = await response.json();
    if (!response.ok) {
      setStatus(payload.error || "Unable to stop rooms.");
      return;
    }
    setRooms(payload.rooms || []);
    setStatus(`Stopped ${payload.stopped.length} room(s).`);
  }

  function toggleSessionSelection(id) {
    setSelectedSessionIds((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  }

  return (
    <div className="app-shell">
      <aside className="rail left-rail">
        <section className="hero-card">
          <div>
            <p className="eyebrow">Blue Core</p>
            <h1>Agent Rooms</h1>
          </div>
          <p className="hero-copy">Modern multi-agent workspace powered by local Codex and Claude CLIs over REST and SSE.</p>
          <div className="hero-actions">
            {templates.map((template, index) => (
              <button
                className={index === 0 ? "primary-button" : "ghost-button"}
                key={template.id}
                onClick={() => handleCreateTemplate(template.id)}
                type="button"
              >
                {template.title}
              </button>
            ))}
            <button className="ghost-button" onClick={handleStopAll} type="button">
              Stop All Rooms
            </button>
          </div>
        </section>

        <Panel title="New Session">
          <form className="stack" onSubmit={handleCreateSession}>
            <label className="field">
              <span>Model</span>
              <div className="segment-row">
                {models.map((model) => (
                  <button
                    className={`segment ${model.id === activeModel ? "is-active" : ""}`}
                    key={model.id}
                    onClick={() => setActiveModel(model.id)}
                    type="button"
                  >
                    {model.label}
                  </button>
                ))}
              </div>
            </label>
            <Field label="Workspace" value={launchForm.cwd} onChange={(value) => setLaunchForm({ ...launchForm, cwd: value })} />
            <Field label="Name" value={launchForm.title} onChange={(value) => setLaunchForm({ ...launchForm, title: value })} />
            <Field
              label="Persona"
              textarea
              rows={4}
              value={launchForm.persona}
              onChange={(value) => setLaunchForm({ ...launchForm, persona: value })}
            />
            <button className="primary-button" type="submit">Launch Session</button>
          </form>
        </Panel>

        <Panel title={`Sessions ${sessions.length ? `(${sessions.length})` : ""}`}>
          <div className="list">
            {sessions.map((session) => (
              <button
                className={`list-card ${activeSessionId === session.id ? "is-active" : ""}`}
                key={session.id}
                onClick={() => {
                  setActiveRoomId(null);
                  setActiveSessionId(session.id);
                }}
                type="button"
              >
                <div className="list-card-top">
                  <div>
                    <strong>{session.title}</strong>
                    <div className="list-meta">{session.model}</div>
                  </div>
                  <input
                    checked={selectedSessionIds.includes(session.id)}
                    onChange={() => toggleSessionSelection(session.id)}
                    onClick={(event) => event.stopPropagation()}
                    type="checkbox"
                  />
                </div>
                <p>{session.persona || session.cwd}</p>
              </button>
            ))}
          </div>
        </Panel>

        <Panel title={`New Room (${selectedSessionIds.length})`}>
          <form className="stack" onSubmit={handleCreateRoom}>
            <Field label="Room Name" value={roomForm.title} onChange={(value) => setRoomForm({ ...roomForm, title: value })} />
            <Field
              label="Shared Instruction"
              textarea
              rows={4}
              value={roomForm.instruction}
              onChange={(value) => setRoomForm({ ...roomForm, instruction: value })}
            />
            <button className="primary-button" type="submit">Create Room</button>
          </form>
        </Panel>

        <Panel title={`Rooms ${rooms.length ? `(${rooms.length})` : ""}`}>
          <div className="list">
            {rooms.map((room) => (
              <button
                className={`list-card ${activeRoomId === room.id ? "is-active" : ""}`}
                key={room.id}
                onClick={() => {
                  setActiveSessionId(null);
                  setActiveRoomId(room.id);
                }}
                type="button"
              >
                <div className="list-card-top">
                  <strong>{room.title}</strong>
                  <span className={`status-dot ${room.autoplay?.active ? "is-live" : "is-idle"}`} />
                </div>
                <p>{room.instruction || "Group room"}</p>
                <div className="list-tags">
                  <span>{room.memberCount} members</span>
                  <span>{room.autoplay?.turnCount || 0} turns</span>
                </div>
              </button>
            ))}
          </div>
        </Panel>
      </aside>

      <main className="main-stage">
        <section className="stage-topbar">
          <div>
            <p className="eyebrow">{activeRoom ? "Room" : activeSession ? "Session" : "Idle"}</p>
            <h2>{activeRoom?.title || activeSession?.title || "Select a room or session"}</h2>
            <p className="stage-subtitle">
              {activeRoom?.instruction ||
                activeSession?.persona ||
                "Sessions are direct agent chats. Rooms stream multi-agent activity over SSE."}
            </p>
          </div>
          <div className="toolbar-actions">
            <button className="ghost-button" disabled={!activeRoom || activeRoom.autoplay?.active} onClick={() => handleRoomAction("start")} type="button">
              Start Auto Chat
            </button>
            <button className="ghost-button" disabled={!activeRoom || !activeRoom.autoplay?.active} onClick={() => handleRoomAction("stop")} type="button">
              Stop
            </button>
          </div>
        </section>

        <section className="chat-shell">
          <div className="chat-header">
            <div className="chips">
              {roomStats.map((entry) => (
                <span className="chip" key={entry}>{entry}</span>
              ))}
            </div>
            {activeRoomActivity ? <div className="activity-banner">{activeRoomActivity}</div> : null}
            {!activeRoom && activeSessionActivity ? <div className="activity-banner">{activeSessionActivity}</div> : null}
            {activeRoom ? (
              <div className="member-strip">
                {activeRoom.members.map((member) => (
                  <button
                    className="member-pill"
                    key={member.sessionId}
                    onClick={() => {
                      setActiveRoomId(null);
                      setActiveSessionId(member.sessionId);
                    }}
                    type="button"
                  >
                    <span>{member.displayName}</span>
                    <small>{member.model}</small>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="message-feed">
            {activeRoom ? (
              activeEvents.map((event) => (
                <MessageCard event={event} key={event.id} />
              ))
            ) : activeSession ? (
              activeSessionEntries.length ? activeSessionEntries.map((message) => <MessageCard event={message} key={message.id} />) : (
                <div className="session-placeholder">
                  <p>Session selected.</p>
                  <span>Send a direct message below to have this agent work with you.</span>
                </div>
              )
            ) : (
              <div className="session-placeholder">
                <p>No active target.</p>
                <span>Create a session, open a room, or launch a template.</span>
              </div>
            )}
          </div>
        </section>

        <section className="composer-card">
          <div className="composer-meta">
            <div>
              <h3>{activeRoom ? "Broadcast to Room" : activeSession ? "Direct Message" : "Message"}</h3>
              <p>{status}</p>
            </div>
          </div>
          <div className="composer-row">
            <textarea
              onChange={(event) => setComposerValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  handleComposerSend();
                }
              }}
              placeholder="Enter sends. Shift+Enter inserts newline."
              rows={4}
              value={composerValue}
            />
            <button className="primary-button send-button" onClick={handleComposerSend} type="button">
              {activeRoom ? "Broadcast" : "Send"}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>{title}</h3>
      </div>
      {children}
    </section>
  );
}

function Field({ label, value, onChange, textarea = false, rows = 3 }) {
  return (
    <label className="field">
      <span>{label}</span>
      {textarea ? (
        <textarea onChange={(event) => onChange(event.target.value)} rows={rows} value={value} />
      ) : (
        <input onChange={(event) => onChange(event.target.value)} value={value} />
      )}
    </label>
  );
}

function MessageCard({ event }) {
  return (
    <article className={`message-card ${event.type}`} key={event.id}>
      <div className="message-meta">
        <div className="message-author">
          <strong>{event.author}</strong>
          <span>{event.model || event.type}</span>
        </div>
        <time>{formatTime(event.createdAt)}</time>
      </div>
      <pre>{event.content}</pre>
    </article>
  );
}

function upsertById(list, item) {
  const next = [...list];
  const index = next.findIndex((entry) => entry.id === item.id);
  if (index === -1) next.unshift(item);
  else next[index] = item;
  return next.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

function upsertMany(list, items) {
  return items.reduce((current, item) => upsertById(current, item), list);
}

function mergeEntriesByCreatedAt(processEvents, messages) {
  return [...processEvents, ...messages].sort((left, right) => {
    const leftTime = new Date(left.createdAt || 0).getTime();
    const rightTime = new Date(right.createdAt || 0).getTime();
    if (leftTime === rightTime) {
      return String(left.id || "").localeCompare(String(right.id || ""));
    }
    return leftTime - rightTime;
  });
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
