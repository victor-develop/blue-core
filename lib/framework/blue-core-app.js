const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { invokeLocalAgent, invokeLocalAgentStream } = require("../cli-adapters");

const DEFAULT_RUNNERS = {
  codex: {
    label: "Codex CLI",
  },
  claude: {
    label: "Claude Code",
  },
};

function createBlueCoreApp({
  rootDir,
  runners = DEFAULT_RUNNERS,
  templates: customTemplates,
  invokeAgent: invokeAgentFn = invokeLocalAgent,
  invokeAgentStream: invokeAgentStreamFn = invokeLocalAgentStream,
  defaultCwd = rootDir,
  apiPrefix = "/api",
  staticDir = path.join(rootDir, "public"),
} = {}) {
  const app = express();
  const server = http.createServer(app);

  app.use(express.json());
  app.use(express.static(staticDir));

  class SessionSSEHub {
    constructor() {
      this.clientsBySession = new Map();
    }

    attach(sessionId, res) {
      if (!this.clientsBySession.has(sessionId)) {
        this.clientsBySession.set(sessionId, new Set());
      }

      this.clientsBySession.get(sessionId).add(res);
      res.write(`event: ready\ndata: ${JSON.stringify({ sessionId })}\n\n`);
    }

    detach(res) {
      for (const subscribers of this.clientsBySession.values()) {
        subscribers.delete(res);
      }
    }

    emit(sessionId, event, payload) {
      const subscribers = this.clientsBySession.get(sessionId);
      if (!subscribers) return;

      const encoded = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
      for (const res of subscribers) {
        res.write(encoded);
      }
    }
  }

  class SessionStore {
    constructor(sessionSseHubInstance) {
      this.sessions = new Map();
      this.sseHub = sessionSseHubInstance;
    }

    list() {
      return [...this.sessions.values()]
        .map((session) => this.serialize(session))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    get(id) {
      return this.sessions.get(id);
    }

    create({ model, cwd, title, persona }) {
      const runner = runners[model];
      if (!runner) {
        throw new Error(`Unsupported model: ${model}`);
      }

      const now = new Date().toISOString();
      const session = {
        id: uuidv4(),
        title: title?.trim() || `${runner.label} Session`,
        model,
        cwd: cwd || defaultCwd,
        persona: persona?.trim() || buildDefaultPersona(model),
        status: "idle",
        createdAt: now,
        updatedAt: now,
        messages: [],
        processEvents: [],
      };

      this.sessions.set(session.id, session);
      return this.serialize(session);
    }

    serialize(session) {
      return {
        id: session.id,
        title: session.title,
        model: session.model,
        cwd: session.cwd,
        persona: session.persona,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length,
      };
    }

    snapshot(id) {
      const session = this.sessions.get(id);
      if (!session) return null;

      return {
        session: this.serialize(session),
        messages: session.messages,
        processEvents: session.processEvents,
      };
    }

    appendMessage(session, message) {
      session.messages.push(message);
      session.updatedAt = message.createdAt;
      this.sseHub.emit(session.id, "message", {
        message,
        session: this.serialize(session),
      });
    }

    appendProcessEvent(session, processEvent) {
      session.processEvents.push(processEvent);
      if (session.processEvents.length > 400) {
        session.processEvents = session.processEvents.slice(-400);
      }
      session.updatedAt = processEvent.createdAt;
      this.sseHub.emit(session.id, "process", {
        event: processEvent,
        session: this.serialize(session),
      });
    }

    async sendMessage(id, content, author = "You") {
      const session = this.sessions.get(id);
      if (!session) {
        throw new Error(`Session not found: ${id}`);
      }

      const message = String(content || "").trim();
      if (!message) {
        throw new Error("Message content is required.");
      }

      const now = new Date().toISOString();
      const userMessage = {
        id: uuidv4(),
        type: "user",
        author,
        content: message,
        createdAt: now,
      };

      session.status = "working";
      this.appendMessage(session, userMessage);

      const prompt = buildDirectMessagePrompt({
        session,
        message,
      });

      try {
        const processEvents = [];
        if (typeof invokeAgentStreamFn === "function") {
          for await (const event of invokeAgentStreamFn({
            model: session.model,
            prompt,
            cwd: session.cwd,
          })) {
            processEvents.push(event);
            if (shouldCaptureProcessEvent(event)) {
              this.appendProcessEvent(session, {
                id: uuidv4(),
                type: "process",
                family: event.family,
                phase: event.phase,
                author: session.title,
                model: session.model,
                content: summarizeProcessEvent(event),
                createdAt: new Date().toISOString(),
                process: event,
              });
            }
          }
        }

        const reply =
          processEvents.length > 0
            ? extractAssistantTextFromEvents(processEvents)
            : await invokeAgentFn({
                model: session.model,
                prompt,
                cwd: session.cwd,
              });

        const agentMessage = {
          id: uuidv4(),
          type: "agent",
          author: session.title,
          model: session.model,
          content: reply.trim(),
          createdAt: new Date().toISOString(),
        };

        session.status = "idle";
        this.appendMessage(session, agentMessage);

        return {
          session: this.serialize(session),
          messages: [userMessage, agentMessage],
          processEvents: session.processEvents,
        };
      } catch (error) {
        session.status = "error";
        session.updatedAt = new Date().toISOString();
        this.appendProcessEvent(session, {
          id: uuidv4(),
          type: "process",
          family: "error",
          phase: "failed",
          author: session.title,
          model: session.model,
          content: `Agent failed: ${error.message}`,
          createdAt: session.updatedAt,
          process: {
            family: "error",
            phase: "failed",
            error: error.message,
          },
        });
        throw error;
      }
    }
  }

  class RoomSSEHub {
    constructor() {
      this.clientsByRoom = new Map();
    }

    attach(roomId, res) {
      if (!this.clientsByRoom.has(roomId)) {
        this.clientsByRoom.set(roomId, new Set());
      }

      this.clientsByRoom.get(roomId).add(res);
      res.write(`event: ready\ndata: ${JSON.stringify({ roomId })}\n\n`);
    }

    detach(res) {
      for (const subscribers of this.clientsByRoom.values()) {
        subscribers.delete(res);
      }
    }

    emit(roomId, event, payload) {
      const subscribers = this.clientsByRoom.get(roomId);
      if (!subscribers) return;

      const encoded = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
      for (const res of subscribers) {
        res.write(encoded);
      }
    }
  }

  class RoomStore {
    constructor(sessionStore, sseHubInstance) {
      this.sessionStore = sessionStore;
      this.sseHub = sseHubInstance;
      this.rooms = new Map();
    }

    list() {
      return [...this.rooms.values()]
        .map((room) => this.serialize(room))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    get(id) {
      return this.rooms.get(id);
    }

    create({ title, instruction, sessionIds, mode = "langgraph-cli" }) {
      const memberIds = [...new Set((sessionIds || []).filter(Boolean))];
      if (memberIds.length < 2) {
        throw new Error("Pick at least two Codex or Claude sessions for a group room.");
      }

      const members = memberIds.map((sessionId) => {
        const session = this.sessionStore.get(sessionId);
        if (!session) {
          throw new Error(`Session not found: ${sessionId}`);
        }

        return {
          sessionId,
          displayName: session.title,
          model: session.model,
          cwd: session.cwd,
          persona: session.persona,
        };
      });

      const now = new Date().toISOString();
      const room = {
        id: uuidv4(),
        title: title?.trim() || "Blue Core Group",
        instruction: instruction?.trim() || "",
        createdAt: now,
        updatedAt: now,
        mode,
        members,
        events: [],
        autoplay: {
          active: false,
          turnCount: 0,
          maxTurns: 200,
        },
      };

      this.rooms.set(room.id, room);
      this.appendEvent(room, {
        id: uuidv4(),
        type: "system",
        author: "Blue Core",
        content: `Room created with ${members.length} members.`,
        createdAt: now,
      });

      return this.serialize(room);
    }

    serialize(room) {
      return {
        id: room.id,
        title: room.title,
        instruction: room.instruction,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
        memberCount: room.members.length,
        mode: room.mode,
        autoplay: room.autoplay,
        members: room.members.map((member) => {
          const session = this.sessionStore.get(member.sessionId);
          return {
            sessionId: member.sessionId,
            displayName: member.displayName,
            model: member.model,
            cwd: member.cwd,
            persona: member.persona,
            status: session?.status || "missing",
          };
        }),
      };
    }

    snapshot(roomId) {
      const room = this.rooms.get(roomId);
      if (!room) return null;

      return {
        room: this.serialize(room),
        events: room.events,
      };
    }

    appendEvent(room, event) {
      room.events.push(event);
      if (room.events.length > 400) {
        room.events = room.events.slice(-400);
      }
      room.updatedAt = new Date().toISOString();
      this.sseHub.emit(room.id, "message", {
        event,
        room: this.serialize(room),
      });
    }

    sendMessage(roomId, { content, author = "You" }) {
      const room = this.rooms.get(roomId);
      if (!room) {
        throw new Error(`Room not found: ${roomId}`);
      }

      const message = String(content || "").trim();
      if (!message) {
        throw new Error("Message content is required.");
      }

      const event = {
        id: uuidv4(),
        type: "user",
        author,
        content: message,
        createdAt: new Date().toISOString(),
      };

      this.appendEvent(room, event);
      return event;
    }
  }

  class LangGraphAutoplayManager {
    constructor({ roomStore, sessionStore, sseHub }) {
      this.roomStore = roomStore;
      this.sessionStore = sessionStore;
      this.sseHub = sseHub;
      this.runners = new Map();
      this.graphPromise = import("../langgraph-room-runner.mjs").then(({ createRoomTurnGraph }) =>
        createRoomTurnGraph({
          invokeAgent: ({ model, prompt, cwd }) => invokeAgentFn({ model, prompt, cwd }),
          resolveRoom: (roomId) => this.getRuntimeRoom(roomId),
        }),
      );
    }

    getRuntimeRoom(roomId) {
      const room = this.roomStore.get(roomId);
      if (!room) return null;

      return {
        id: room.id,
        title: room.title,
        instruction: room.instruction,
        members: room.members.map((member) => {
          const session = this.sessionStore.get(member.sessionId);
          return {
            sessionId: member.sessionId,
            displayName: member.displayName,
            model: member.model,
            cwd: session?.cwd || member.cwd || defaultCwd,
            persona: member.persona,
          };
        }),
      };
    }

    async start(roomId, seedMessage = "") {
      const room = this.roomStore.get(roomId);
      if (!room) {
        throw new Error(`Room not found: ${roomId}`);
      }

      room.autoplay.active = true;
      room.autoplay.turnCount = room.autoplay.turnCount || 0;

      if (!this.runners.has(roomId)) {
        this.runners.set(roomId, { running: false, stopRequested: false });
      }

      if (seedMessage.trim()) {
        this.roomStore.appendEvent(room, {
          id: uuidv4(),
          type: "user",
          author: "Blue Core Seed",
          content: seedMessage.trim(),
          createdAt: new Date().toISOString(),
        });
      }

      const runner = this.runners.get(roomId);
      runner.stopRequested = false;

      if (!runner.running) {
        runner.running = true;
        this.runLoop(roomId)
          .catch((error) => {
            const currentRoom = this.roomStore.get(roomId);
            if (!currentRoom) return;
            currentRoom.autoplay.active = false;
            this.roomStore.appendEvent(currentRoom, {
              id: uuidv4(),
              type: "system",
              author: "Blue Core",
              content: `Autoplay failed: ${error.message}`,
              createdAt: new Date().toISOString(),
            });
          })
          .finally(() => {
            runner.running = false;
          });
      }

      return this.roomStore.serialize(room);
    }

    stop(roomId) {
      const room = this.roomStore.get(roomId);
      if (!room) {
        throw new Error(`Room not found: ${roomId}`);
      }

      const runner = this.runners.get(roomId);
      if (runner) {
        runner.stopRequested = true;
      }

      room.autoplay.active = false;
      this.roomStore.appendEvent(room, {
        id: uuidv4(),
        type: "system",
        author: "Blue Core",
        content: "Auto chat stopped.",
        createdAt: new Date().toISOString(),
      });
      return this.roomStore.serialize(room);
    }

    async runLoop(roomId) {
      const graph = await this.graphPromise;
      const room = this.roomStore.get(roomId);
      if (!room) return;

      let state = {
        roomId,
        turnCount: room.autoplay.turnCount || 0,
        nextSpeakerIndex: room.autoplay.turnCount % room.members.length,
        history: room.events
          .filter((event) => event.type === "user" || event.type === "agent")
          .map((event) => ({
            author: event.author,
            content: event.content,
            model: event.model || "",
            sessionId: event.sessionId || "",
          })),
        lastMessage: null,
      };

      while (true) {
        const currentRoom = this.roomStore.get(roomId);
        const runner = this.runners.get(roomId);
        if (!currentRoom || !runner || runner.stopRequested || !currentRoom.autoplay.active) {
          break;
        }

        if (currentRoom.autoplay.turnCount >= currentRoom.autoplay.maxTurns) {
          currentRoom.autoplay.active = false;
          this.roomStore.appendEvent(currentRoom, {
            id: uuidv4(),
            type: "system",
            author: "Blue Core",
            content: `Auto chat reached the safety limit of ${currentRoom.autoplay.maxTurns} turns and was stopped.`,
            createdAt: new Date().toISOString(),
          });
          break;
        }

        this.sseHub.emit(roomId, "turn.started", {
          roomId,
          nextSpeakerIndex: state.nextSpeakerIndex,
          turnCount: currentRoom.autoplay.turnCount,
          room: this.roomStore.serialize(currentRoom),
        });

        state.history = currentRoom.events
          .filter((event) => event.type === "user" || event.type === "agent")
          .map((event) => ({
            author: event.author,
            content: event.content,
            model: event.model || "",
            sessionId: event.sessionId || "",
          }));

        state = await graph.invoke(state);
        currentRoom.autoplay.turnCount = state.turnCount;

        if (state.lastMessage) {
          this.roomStore.appendEvent(currentRoom, {
            id: uuidv4(),
            type: "agent",
            author: state.lastMessage.author,
            sessionId: state.lastMessage.sessionId,
            model: state.lastMessage.model,
            content: state.lastMessage.content,
            createdAt: new Date().toISOString(),
          });
        }

        await sleep(400);
      }
    }
  }

  const sessionSseHub = new SessionSSEHub();
  const sseHub = new RoomSSEHub();
  const store = new SessionStore(sessionSseHub);
  const rooms = new RoomStore(store, sseHub);
  const autoplayManager = new LangGraphAutoplayManager({
    roomStore: rooms,
    sessionStore: store,
    sseHub,
  });
  const templates = customTemplates || createDefaultTemplates(rootDir);

  registerRoutes({
    app,
    apiPrefix,
    defaultCwd,
    runners,
    store,
    rooms,
    sseHub,
    autoplayManager,
    templates,
  });

  return {
    app,
    server,
    runtime: {
      store,
      sessionSseHub,
      rooms,
      sseHub,
      autoplayManager,
      runners,
      templates,
    },
  };
}

function registerRoutes({
  app,
  apiPrefix,
  defaultCwd,
  runners,
  store,
  sessionSseHub,
  rooms,
  sseHub,
  autoplayManager,
  templates,
}) {
  const route = (suffix) => `${apiPrefix}${suffix}`;

  app.get(route("/health"), (_req, res) => {
    res.json({ ok: true, transport: "sse" });
  });

  app.get(route("/models"), (_req, res) => {
    res.json({
      models: Object.entries(runners).map(([id, runner]) => ({
        id,
        label: runner.label,
      })),
    });
  });

  app.get(route("/config"), (_req, res) => {
    res.json({ defaultCwd });
  });

  app.get(route("/sessions"), (_req, res) => {
    res.json({ sessions: store.list() });
  });

  app.get(route("/sessions/:id"), (req, res) => {
    const snapshot = store.snapshot(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: `Session not found: ${req.params.id}` });
      return;
    }
    res.json(snapshot);
  });

  app.post(route("/sessions"), (req, res) => {
    try {
      const session = store.create(req.body || {});
      res.status(201).json({ session });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post(route("/sessions/:id/message"), async (req, res) => {
    try {
      const result = await store.sendMessage(req.params.id, req.body?.content || "", req.body?.author || "You");
      res.status(201).json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get(route("/sessions/:id/stream"), (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    sessionSseHub.attach(req.params.id, res);
    req.on("close", () => sessionSseHub.detach(res));
  });

  app.get(route("/rooms"), (_req, res) => {
    res.json({ rooms: rooms.list() });
  });

  app.get(route("/rooms/:id"), (req, res) => {
    const snapshot = rooms.snapshot(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: `Room not found: ${req.params.id}` });
      return;
    }
    res.json(snapshot);
  });

  app.get(route("/rooms/:id/stream"), (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    sseHub.attach(req.params.id, res);
    req.on("close", () => sseHub.detach(res));
  });

  app.post(route("/rooms"), (req, res) => {
    try {
      const room = rooms.create(req.body || {});
      res.status(201).json({ room });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post(route("/rooms/:id/messages"), (req, res) => {
    try {
      const event = rooms.sendMessage(req.params.id, req.body || {});
      res.status(201).json({ event });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post(route("/rooms/:id/autoplay/start"), (req, res) => {
    autoplayManager.start(req.params.id, req.body?.seedMessage || "")
      .then((room) => res.status(200).json({ room }))
      .catch((error) => res.status(400).json({ error: error.message }));
  });

  app.post(route("/rooms/:id/autoplay/stop"), (req, res) => {
    try {
      const room = autoplayManager.stop(req.params.id);
      res.status(200).json({ room });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post(route("/rooms/autoplay/stop-all"), (_req, res) => {
    const stopped = [];
    for (const room of rooms.rooms.values()) {
      if (!room.autoplay?.active) continue;
      autoplayManager.stop(room.id);
      stopped.push(room.id);
    }
    res.status(200).json({
      stopped,
      rooms: rooms.list(),
    });
  });

  app.get(route("/templates"), (_req, res) => {
    res.json({
      templates: templates.map(({ id, title, description }) => ({ id, title, description })),
    });
  });

  app.post(route("/templates/:id/create"), (req, res) => {
    try {
      const root = req.body?.cwd || defaultCwd;
      const template = templates.find((entry) => entry.id === req.params.id);
      if (!template) {
        throw new Error(`Unknown template: ${req.params.id}`);
      }

      const preset = template.build(root);
      const sessions = preset.sessions.map((entry) =>
        store.create({
          model: entry.model,
          cwd: entry.cwd || root,
          title: entry.title,
          persona: entry.persona,
        }),
      );
      const room = rooms.create({
        title: preset.roomTitle,
        instruction: preset.instruction,
        sessionIds: sessions.map((session) => session.id),
        mode: "langgraph-cli",
      });

      autoplayManager.start(room.id, preset.seedMessage).catch(() => {});

      res.status(201).json({
        sessions,
        room: rooms.serialize(rooms.get(room.id)),
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
}

function ensureDirectory(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
  return targetPath;
}

function createDefaultTemplates(rootDir) {
  return [
    {
      id: "new-father-edu-psych",
      title: "New Father + Educational Psychologist",
      description: "A beginner dad casually chatting with an educational psychology expert.",
      build: () => ({
        sessions: [
          {
            model: "codex",
            title: "NewFather",
            persona:
              "你是一个新手爸爸。你会真诚地表达自己的困惑、压力和观察，用生活化语言提问，偶尔会犹豫，需要具体可执行的建议。",
          },
          {
            model: "claude",
            title: "EduPsych",
            persona:
              "你是一位教育心理学专家。你温和、专业、具体，会先共情，再解释孩子行为背后的心理机制，最后给出简单可执行建议。",
          },
        ],
        roomTitle: "育儿咨询",
        instruction:
          "这是一个轻松但持续的育儿闲聊房间。新手爸爸提出真实困惑，教育心理学专家循序渐进地回应，也可以反问以推动对话。",
        seedMessage:
          "请以自然聊天的方式开始这段对话。新手爸爸先抛出一个最近在育儿上遇到的小困惑，教育心理学专家接着回应。",
      }),
    },
    {
      id: "menti-clone-build",
      title: "Menti Clone Build Room",
      description: "Frontend and backend experts collaborate to implement a minimal Mentimeter clone in menti-clone.",
      build: (workspaceRoot) => {
        const projectDir = ensureDirectory(path.join(workspaceRoot || rootDir, "menti-clone"));
        return {
          sessions: [
            {
              model: "claude",
              title: "FrontendLead",
              cwd: projectDir,
              persona:
                "You are a senior frontend engineer. You own product UX, React architecture, interaction design, and fast iterative delivery. You make concrete implementation decisions and keep the UI minimal, modern, and shippable.",
            },
            {
              model: "claude",
              title: "BackendLead",
              cwd: projectDir,
              persona:
                "You are a senior backend engineer. You own API design, data modeling, SQLite integration, project scaffolding, and runtime reliability. You make pragmatic decisions and keep the stack small and maintainable.",
            },
          ],
          roomTitle: "Menti Clone Build",
          instruction:
            "Work together to fully implement a minimal Mentimeter clone inside the working directory. Use SQLite for persistence. If requirements are ambiguous, decide them yourselves and proceed. You should design the app, initialize the codebase, write the code, and run the project when useful. In each turn, do one focused chunk of work and then report what changed so the room stays readable.",
          seedMessage:
            "Start by agreeing on a minimal product scope and stack, split responsibilities, and then begin implementation in the working directory. Keep each reply short and concrete about what you changed.",
        };
      },
    },
  ];
}

function buildDefaultPersona(model) {
  return `${String(model || "agent").toUpperCase()} collaborator focused on clear, concrete progress.`;
}

function buildDirectMessagePrompt({ session, message }) {
  const history = session.messages
    .slice(-8)
    .map((entry) => `${entry.author}: ${entry.content}`)
    .join("\n");

  return [
    `You are "${session.title}".`,
    `Your persona:\n${session.persona}`,
    `Working directory:\n${session.cwd}`,
    "Recent direct chat history:",
    history || "(No prior messages yet)",
    `Latest user message:\n${message}`,
    "Reply directly as a helpful collaborator.",
    "Keep the response concise and practical.",
  ].join("\n\n");
}

function shouldCaptureProcessEvent(event) {
  return event && event.family !== "message" && event.family !== "stream";
}

function extractAssistantTextFromEvents(events) {
  const assistantMessages = events
    .filter((event) => event.family === "message" && event.actor === "assistant" && event.text)
    .map((event) => event.text.trim())
    .filter(Boolean);

  if (assistantMessages.length) {
    return assistantMessages.join("\n").trim();
  }

  const fallback = [...events]
    .reverse()
    .find((event) => event.family === "turn" && typeof event.text === "string" && event.text.trim());
  return fallback?.text?.trim() || "";
}

function summarizeProcessEvent(event) {
  if (event.family === "session") {
    return event.phase === "started" ? "Session started." : `Session ${event.phase}.`;
  }

  if (event.family === "turn") {
    if (event.phase === "started") return "Turn started.";
    if (event.phase === "completed") return "Turn completed.";
    if (event.phase === "failed") return event.error ? `Turn failed: ${event.error}` : "Turn failed.";
  }

  if (event.family === "tool") {
    const label = event.command || event.toolName || event.toolKind || "tool";
    if (event.phase === "started") return `Running ${label}.`;
    if (event.phase === "completed") return `Finished ${label}.`;
    if (event.phase === "failed") return event.error ? `${label} failed: ${event.error}` : `${label} failed.`;
    return `Updated ${label}.`;
  }

  if (event.family === "reasoning") {
    return event.text ? `Reasoning: ${event.text}` : "Reasoning updated.";
  }

  if (event.family === "plan") {
    return `Plan updated with ${Array.isArray(event.plan) ? event.plan.length : 0} steps.`;
  }

  if (event.family === "file") {
    return `File changes ${event.phase}.`;
  }

  if (event.family === "status" || event.family === "task" || event.family === "hook") {
    return event.text || `${event.family} updated.`;
  }

  if (event.family === "rate_limit") {
    return "Rate limit status updated.";
  }

  if (event.family === "error") {
    return event.error || "Agent error.";
  }

  return `${event.family} ${event.phase}.`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  DEFAULT_RUNNERS,
  createBlueCoreApp,
  createDefaultTemplates,
};
