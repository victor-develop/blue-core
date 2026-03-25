const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const pty = require("node-pty");
const { WebSocketServer } = require("ws");
const { v4: uuidv4 } = require("uuid");
const { invokeLocalAgent } = require("../cli-adapters");

const ROOM_REPLY_PREFIX = "<<<BLUE_CORE_REPLY_";

const DEFAULT_RUNNERS = {
  codex: {
    label: "Codex CLI",
    command: process.env.CODEX_BIN || "codex",
    args: (cwd) => [
      "--dangerously-bypass-approvals-and-sandbox",
      "--no-alt-screen",
      "-C",
      cwd,
    ],
  },
  claude: {
    label: "Claude Code",
    command: process.env.CLAUDE_BIN || "claude",
    args: () => ["--dangerously-skip-permissions"],
  },
};

function createBlueCoreApp({
  rootDir,
  runners = DEFAULT_RUNNERS,
  templates: customTemplates,
  invokeAgent: invokeAgentFn = invokeLocalAgent,
  defaultCwd = rootDir,
  apiPrefix = "/api",
  staticDir = path.join(rootDir, "public"),
  xtermDir = path.join(rootDir, "node_modules/@xterm/xterm"),
  xtermAddonFitDir = path.join(rootDir, "node_modules/@xterm/addon-fit"),
} = {}) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  app.use(express.json());
  app.use(express.static(staticDir));
  app.use("/vendor/xterm", express.static(xtermDir));
  app.use("/vendor/xterm-addon-fit", express.static(xtermAddonFitDir));

  class SessionStore {
    constructor() {
      this.sessions = new Map();
      this.clientsBySession = new Map();
      this.outputListeners = new Set();
      this.exitListeners = new Set();
    }

    onOutput(listener) {
      this.outputListeners.add(listener);
    }

    onExit(listener) {
      this.exitListeners.add(listener);
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

      const sessionId = uuidv4();
      const safeCwd = cwd || rootDir;
      const name = title?.trim() || `${runner.label} Session`;

      const ptyProcess = pty.spawn(runner.command, runner.args(safeCwd), {
        name: "xterm-256color",
        cols: 120,
        rows: 32,
        cwd: safeCwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        },
      });

      const now = new Date().toISOString();
      const session = {
        id: sessionId,
        title: name,
        model,
        cwd: safeCwd,
        status: "running",
        createdAt: now,
        updatedAt: now,
        pid: ptyProcess.pid,
        outputBuffer: "",
        pty: ptyProcess,
        autoTrustHandled: false,
        persona: persona?.trim() || "",
        readyAt: Date.now() + (model === "claude" ? 2600 : 1400),
      };

      if (model === "claude") {
        let attempts = 0;
        session.autoTrustTimer = setInterval(() => {
          attempts += 1;
          this.maybeAutoAcceptTrustPrompt(session, "");
          if (session.autoTrustHandled || attempts >= 40 || session.status !== "running") {
            clearInterval(session.autoTrustTimer);
            session.autoTrustTimer = null;
          }
        }, 250);
      }

      ptyProcess.onData((data) => {
        session.outputBuffer = trimBuffer(session.outputBuffer + data);
        session.updatedAt = new Date().toISOString();
        this.broadcast(session.id, {
          type: "terminal-output",
          sessionId: session.id,
          data,
        });
        this.broadcastMeta(session.id);
        this.maybeAutoAcceptTrustPrompt(session, data);
        for (const listener of this.outputListeners) {
          listener(session, data);
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        if (session.status === "exited") return;
        if (session.autoTrustTimer) {
          clearInterval(session.autoTrustTimer);
          session.autoTrustTimer = null;
        }
        session.status = "exited";
        session.updatedAt = new Date().toISOString();
        session.exitCode = exitCode;
        session.exitSignal = signal;
        this.broadcast(session.id, {
          type: "session-exited",
          sessionId: session.id,
          exitCode,
          signal,
        });
        this.broadcastMeta(session.id);
        for (const listener of this.exitListeners) {
          listener(session, { exitCode, signal });
        }
      });

      this.sessions.set(session.id, session);
      this.resize(session.id, 120, 32);
      this.broadcastGlobal({
        type: "sessions",
        sessions: this.list(),
      });

      return this.serialize(session);
    }

    serialize(session) {
      return {
        id: session.id,
        title: session.title,
        model: session.model,
        cwd: session.cwd,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        pid: session.pid,
        exitCode: session.exitCode ?? null,
        exitSignal: session.exitSignal ?? null,
        persona: session.persona || "",
      };
    }

    snapshot(id) {
      const session = this.sessions.get(id);
      if (!session) return null;

      return {
        type: "session-snapshot",
        session: this.serialize(session),
        buffer: session.outputBuffer,
      };
    }

    write(id, data) {
      const session = this.sessions.get(id);
      if (!session || session.status !== "running") {
        return false;
      }

      session.pty.write(data);
      session.updatedAt = new Date().toISOString();
      this.broadcastMeta(id);
      return true;
    }

    submit(id, content) {
      const session = this.sessions.get(id);
      if (!session || session.status !== "running") {
        return false;
      }

      const delay = Math.max(0, session.readyAt - Date.now());
      setTimeout(() => {
        if (!this.write(id, content)) return;
        setTimeout(() => this.write(id, "\r"), 90);
        setTimeout(() => this.write(id, "\r"), 260);
        session.readyAt = Date.now() + 1200;
      }, delay);

      return true;
    }

    resize(id, cols, rows) {
      const session = this.sessions.get(id);
      if (!session || session.status !== "running") return false;

      session.pty.resize(Math.max(40, cols), Math.max(10, rows));
      return true;
    }

    attachClient(sessionId, ws) {
      this.detachClient(ws);

      if (!this.clientsBySession.has(sessionId)) {
        this.clientsBySession.set(sessionId, new Set());
      }

      this.clientsBySession.get(sessionId).add(ws);
      const snapshot = this.snapshot(sessionId);
      if (snapshot) {
        ws.send(JSON.stringify(snapshot));
      }
      const session = this.sessions.get(sessionId);
      if (session) {
        this.maybeAutoAcceptTrustPrompt(session, "");
      }
    }

    detachClient(ws) {
      for (const subscribers of this.clientsBySession.values()) {
        subscribers.delete(ws);
      }
    }

    broadcast(sessionId, payload) {
      const subscribers = this.clientsBySession.get(sessionId);
      if (!subscribers) return;

      const encoded = JSON.stringify(payload);
      for (const client of subscribers) {
        if (client.readyState === client.OPEN) {
          client.send(encoded);
        }
      }
    }

    broadcastMeta(sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) return;

      this.broadcastGlobal({
        type: "session-updated",
        session: this.serialize(session),
      });
    }

    broadcastGlobal(payload) {
      const encoded = JSON.stringify(payload);
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) {
          client.send(encoded);
        }
      }
    }

    maybeAutoAcceptTrustPrompt(session, chunk) {
      if (session.model !== "claude" || session.autoTrustHandled || session.status !== "running") {
        return;
      }

      const normalized = stripAnsi(`${session.outputBuffer}${chunk}`);
      const compressed = normalized.replace(/\s+/g, "");
      const sawSafetyCheck = compressed.includes("Quicksafetycheck:");
      const sawTrustOption = compressed.includes("Yes,Itrustthisfolder");

      if (!sawSafetyCheck || !sawTrustOption) {
        return;
      }

      session.autoTrustHandled = true;
      session.pty.write("\r");
    }
  }

  class RoomStore {
    constructor(sessionStore) {
      this.sessionStore = sessionStore;
      this.rooms = new Map();
      this.clientsByRoom = new Map();

      this.sessionStore.onOutput((session, chunk) => {
        this.handleSessionOutput(session, chunk);
      });

      this.sessionStore.onExit((session, meta) => {
        this.handleSessionExit(session, meta);
      });
    }

    list() {
      return [...this.rooms.values()]
        .map((room) => this.serialize(room))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    create({ title, instruction, sessionIds, mode = "pty-room" }) {
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
          persona: session.persona || buildDefaultPersona(session),
          streamEventId: null,
          parserBuffer: "",
          expectedReplyStart: null,
          expectedReplyEnd: null,
        };
      });

      const now = new Date().toISOString();
      const room = {
        id: uuidv4(),
        title: title?.trim() || "Blue Core Group",
        instruction: instruction?.trim() || "",
        mode,
        createdAt: now,
        updatedAt: now,
        members,
        events: [
          {
            id: uuidv4(),
            type: "system",
            author: "Blue Core",
            content: `Room created with ${members.length} members.`,
            createdAt: now,
          },
        ],
        autoplay: {
          active: false,
          turnCount: 0,
          maxTurns: 200,
        },
      };

      this.rooms.set(room.id, room);
      this.broadcastGlobal({
        type: "rooms",
        rooms: this.list(),
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
            persona: member.persona,
            status: session?.status || "missing",
            pid: session?.pid ?? null,
          };
        }),
      };
    }

    snapshot(roomId) {
      const room = this.rooms.get(roomId);
      if (!room) return null;

      return {
        type: "room-snapshot",
        room: this.serialize(room),
        events: room.events,
      };
    }

    attachClient(roomId, ws) {
      if (!this.clientsByRoom.has(roomId)) {
        this.clientsByRoom.set(roomId, new Set());
      }

      this.clientsByRoom.get(roomId).add(ws);
      const snapshot = this.snapshot(roomId);
      if (snapshot) {
        ws.send(JSON.stringify(snapshot));
      }
    }

    detachClient(ws) {
      for (const subscribers of this.clientsByRoom.values()) {
        subscribers.delete(ws);
      }
    }

    sendMessage(roomId, { content, author = "You" }) {
      const room = this.rooms.get(roomId);
      if (!room) {
        throw new Error(`Room not found: ${roomId}`);
      }

      const now = new Date().toISOString();
      const userEvent = {
        id: uuidv4(),
        type: "user",
        author,
        content,
        createdAt: now,
      };
      this.appendEvent(room, userEvent);

      if (room.mode === "langgraph-cli") {
        return userEvent;
      }

      for (const member of room.members) {
        const prompt = formatGroupPrompt({
          roomTitle: room.title,
          roomInstruction: room.instruction,
          memberName: member.displayName,
          memberPersona: member.persona,
          userMessage: content,
          replyBoundary: assignReplyBoundary(member),
        });

        member.streamEventId = null;
        member.parserBuffer = "";
        this.sessionStore.submit(member.sessionId, prompt);
      }

      return userEvent;
    }

    handleSessionOutput(session, chunk) {
      for (const room of this.rooms.values()) {
        if (room.mode === "langgraph-cli") continue;
        const member = room.members.find((entry) => entry.sessionId === session.id);
        if (!member) continue;

        const chunks = extractStructuredReplies(member, chunk);
        for (const cleanChunk of chunks) {
          this.appendAgentChunk(room, member, cleanChunk);
          this.maybeRelayToPeers(room, member, cleanChunk);
        }
      }
    }

    handleSessionExit(session, meta) {
      for (const room of this.rooms.values()) {
        const member = room.members.find((entry) => entry.sessionId === session.id);
        if (!member) continue;

        member.streamEventId = null;
        this.appendEvent(room, {
          id: uuidv4(),
          type: "system",
          author: "Blue Core",
          content: `${member.displayName} exited with code ${meta.exitCode ?? "?"}.`,
          createdAt: new Date().toISOString(),
        });
      }
    }

    appendAgentChunk(room, member, chunk) {
      if (!member.streamEventId) {
        const event = {
          id: uuidv4(),
          type: "agent",
          author: member.displayName,
          sessionId: member.sessionId,
          model: member.model,
          content: chunk,
          createdAt: new Date().toISOString(),
        };
        member.streamEventId = event.id;
        this.appendEvent(room, event);
        return;
      }

      this.appendToEvent(room, member.streamEventId, chunk);
    }

    appendEvent(room, event) {
      room.events.push(event);
      if (room.events.length > 400) {
        room.events = room.events.slice(room.events.length - 400);
      }
      room.updatedAt = new Date().toISOString();
      this.broadcastRoom(room.id, {
        type: "room-event",
        roomId: room.id,
        event,
        room: this.serialize(room),
      });
      this.broadcastGlobal({
        type: "room-updated",
        room: this.serialize(room),
      });
    }

    appendToEvent(room, eventId, chunk) {
      const event = room.events.find((entry) => entry.id === eventId);
      if (!event) return;
      event.content += chunk;
      room.updatedAt = new Date().toISOString();
      this.broadcastRoom(room.id, {
        type: "room-event-patch",
        roomId: room.id,
        eventId,
        content: event.content,
        room: this.serialize(room),
      });
      this.broadcastGlobal({
        type: "room-updated",
        room: this.serialize(room),
      });
    }

    maybeRelayToPeers(room, sender, content) {
      if (room.mode === "langgraph-cli") return;
      if (!room.autoplay.active) return;

      room.autoplay.turnCount += 1;
      if (room.autoplay.turnCount > room.autoplay.maxTurns) {
        room.autoplay.active = false;
        this.appendEvent(room, {
          id: uuidv4(),
          type: "system",
          author: "Blue Core",
          content: `Auto chat reached the safety limit of ${room.autoplay.maxTurns} turns and was stopped.`,
          createdAt: new Date().toISOString(),
        });
        return;
      }

      for (const member of room.members) {
        if (member.sessionId === sender.sessionId) continue;

        member.streamEventId = null;
        member.parserBuffer = "";
        const relayPrompt = formatRelayPrompt({
          roomTitle: room.title,
          roomInstruction: room.instruction,
          memberName: member.displayName,
          memberPersona: member.persona,
          sourceName: sender.displayName,
          sourceMessage: content,
          replyBoundary: assignReplyBoundary(member),
        });
        this.sessionStore.submit(member.sessionId, relayPrompt);
      }
    }

    broadcastRoom(roomId, payload) {
      const subscribers = this.clientsByRoom.get(roomId);
      if (!subscribers) return;

      const encoded = JSON.stringify(payload);
      for (const client of subscribers) {
        if (client.readyState === client.OPEN) {
          client.send(encoded);
        }
      }
    }

    broadcastGlobal(payload) {
      const encoded = JSON.stringify(payload);
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) {
          client.send(encoded);
        }
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
      const room = this.roomStore.rooms.get(roomId);
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
            cwd: session?.cwd || rootDir,
            persona: member.persona,
          };
        }),
      };
    }

    async start(roomId, seedMessage = "") {
      const room = this.roomStore.rooms.get(roomId);
      if (!room) {
        throw new Error(`Room not found: ${roomId}`);
      }

      room.autoplay.active = true;
      room.autoplay.turnCount = 0;
      room.mode = "langgraph-cli";

      if (seedMessage?.trim()) {
        this.roomStore.appendEvent(room, {
          id: uuidv4(),
          type: "user",
          author: "Blue Core Seed",
          content: seedMessage.trim(),
          createdAt: new Date().toISOString(),
        });
      }

      if (!this.runners.has(roomId)) {
        this.runners.set(roomId, { stopRequested: false, running: false });
      }
      const runner = this.runners.get(roomId);
      runner.stopRequested = false;

      if (runner.running) {
        return this.roomStore.serialize(room);
      }

      runner.running = true;
      this.runLoop(roomId).catch((error) => {
        const targetRoom = this.roomStore.rooms.get(roomId);
        if (targetRoom) {
          targetRoom.autoplay.active = false;
          this.roomStore.appendEvent(targetRoom, {
            id: uuidv4(),
            type: "system",
            author: "Blue Core",
            content: `Autoplay failed: ${error.message}`,
            createdAt: new Date().toISOString(),
          });
        }
      }).finally(() => {
        runner.running = false;
      });

      return this.roomStore.serialize(room);
    }

    stop(roomId) {
      const room = this.roomStore.rooms.get(roomId);
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
      const room = this.roomStore.rooms.get(roomId);
      if (!room) return;

      let state = {
        roomId,
        turnCount: room.autoplay.turnCount || 0,
        nextSpeakerIndex: 0,
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
        const currentRoom = this.roomStore.rooms.get(roomId);
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
          const event = {
            id: uuidv4(),
            type: "agent",
            author: state.lastMessage.author,
            sessionId: state.lastMessage.sessionId,
            model: state.lastMessage.model,
            content: state.lastMessage.content,
            createdAt: new Date().toISOString(),
          };
          this.roomStore.appendEvent(currentRoom, event);
          this.sseHub.emit(roomId, "message", event);
        }

        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
  }

  const store = new SessionStore();
  const rooms = new RoomStore(store);
  const sseHub = new RoomSSEHub();
  const autoplayManager = new LangGraphAutoplayManager({
    roomStore: rooms,
    sessionStore: store,
    sseHub,
  });

  const templates = customTemplates || createDefaultTemplates(rootDir);

  registerRoutes({
    app,
    rootDir,
    defaultCwd,
    apiPrefix,
    runners,
    store,
    rooms,
    sseHub,
    autoplayManager,
    templates,
  });

  registerSocketHandlers({ wss, store, rooms });

  return {
    app,
    server,
    wss,
    runtime: {
      store,
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
  rootDir,
  defaultCwd,
  apiPrefix,
  runners,
  store,
  rooms,
  sseHub,
  autoplayManager,
  templates,
}) {
  const route = (suffix) => `${apiPrefix}${suffix}`;

  app.get(route("/health"), (_req, res) => {
    res.json({ ok: true });
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
    res.json({
      defaultCwd,
    });
  });

  app.get(route("/sessions"), (_req, res) => {
    res.json({ sessions: store.list() });
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

  app.get(route("/templates"), (_req, res) => {
    res.json({ templates: templates.map(({ id, title, description }) => ({ id, title, description })) });
  });

  app.post(route("/sessions"), (req, res) => {
    try {
      const { model, cwd, title, persona } = req.body || {};
      const session = store.create({ model, cwd, title, persona });
      res.status(201).json({ session });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post(route("/rooms"), (req, res) => {
    try {
      const { title, instruction, sessionIds } = req.body || {};
      const room = rooms.create({ title, instruction, sessionIds });
      res.status(201).json({ room });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post(route("/templates/:id/create"), (req, res) => {
    try {
      const root = req.body?.cwd || defaultCwd;
      const template = templates.find((entry) => entry.id === req.params.id);
      if (!template) {
        throw new Error(`Unknown template: ${req.params.id}`);
      }

      const preset = template.build(root);
      const createdSessions = preset.sessions.map((entry) =>
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
        sessionIds: createdSessions.map((session) => session.id),
        mode: "langgraph-cli",
      });

      autoplayManager.start(room.id, preset.seedMessage).catch(() => {});

      res.status(201).json({
        sessions: createdSessions,
        room: rooms.list().find((entry) => entry.id === room.id) || room,
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post(route("/rooms/:id/messages"), (req, res) => {
    try {
      const event = rooms.sendMessage(req.params.id, {
        content: req.body?.content || "",
        author: req.body?.author || "You",
      });
      res.status(201).json({ event });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post(route("/rooms/:id/autoplay/start"), (req, res) => {
    autoplayManager.start(req.params.id, req.body?.seedMessage || "")
      .then((room) => {
        res.status(200).json({ room });
      })
      .catch((error) => {
        res.status(400).json({ error: error.message });
      });
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

  app.post(route("/sessions/:id/input"), (req, res) => {
    const ok = store.write(req.params.id, req.body?.data || "");
    res.json({ ok });
  });

  app.post(route("/sessions/:id/resize"), (req, res) => {
    const ok = store.resize(req.params.id, Number(req.body?.cols), Number(req.body?.rows));
    res.json({ ok });
  });
}

function registerSocketHandlers({ wss, store, rooms }) {
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "sessions", sessions: store.list() }));
    ws.send(JSON.stringify({ type: "rooms", rooms: rooms.list() }));

    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw));

        if (message.type === "subscribe" && message.sessionId) {
          store.attachClient(message.sessionId, ws);
        }

        if (message.type === "subscribe-room" && message.roomId) {
          rooms.attachClient(message.roomId, ws);
        }

        if (message.type === "input" && message.sessionId) {
          store.write(message.sessionId, message.data || "");
        }

        if (message.type === "resize" && message.sessionId) {
          store.resize(message.sessionId, Number(message.cols), Number(message.rows));
        }
      } catch (error) {
        ws.send(
          JSON.stringify({
            type: "session-error",
            error: error.message,
          }),
        );
      }
    });

    ws.on("close", () => {
      store.detachClient(ws);
      rooms.detachClient(ws);
    });
  });
}

function trimBuffer(text) {
  const MAX_CHARS = 300_000;
  if (text.length <= MAX_CHARS) return text;
  return text.slice(text.length - MAX_CHARS);
}

function stripAnsi(value) {
  return String(value).replace(
    /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g,
    "",
  );
}

function buildDefaultPersona(session) {
  return `${session.model.toUpperCase()} strategist focused on sharp, direct collaboration.`;
}

function assignReplyBoundary(member) {
  const token = uuidv4().replaceAll("-", "");
  member.expectedReplyStart = `${ROOM_REPLY_PREFIX}${token}>>>`;
  member.expectedReplyEnd = `<<<END_BLUE_CORE_REPLY_${token}>>>`;
  return {
    start: member.expectedReplyStart,
    end: member.expectedReplyEnd,
  };
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

function formatGroupPrompt({
  roomTitle,
  roomInstruction,
  memberName,
  memberPersona,
  userMessage,
  replyBoundary,
}) {
  const instructionBlock = roomInstruction
    ? `Shared room instruction:\n${roomInstruction}\n\n`
    : "";

  return [
    `You are participating in a multi-agent group chat room called "${roomTitle}".`,
    `Your visible name in the room is "${memberName}".`,
    `Your persona:\n${memberPersona}`,
    instructionBlock.trim(),
    `A new group message has arrived from the human:\n${userMessage}`,
    `Output the final room-facing reply using exactly this envelope, with each marker on its own line:`,
    `START MARKER: ${replyBoundary.start}`,
    `END MARKER: ${replyBoundary.end}`,
    "Only place the final room message between those two lines.",
    "Do not include prompt text, explanations, or terminal status text between the markers.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatRelayPrompt({
  roomTitle,
  roomInstruction,
  memberName,
  memberPersona,
  sourceName,
  sourceMessage,
  replyBoundary,
}) {
  const instructionBlock = roomInstruction
    ? `Shared room instruction:\n${roomInstruction}\n\n`
    : "";

  return [
    `You are continuing a multi-agent group chat room called "${roomTitle}".`,
    `Your visible name in the room is "${memberName}".`,
    `Your persona:\n${memberPersona}`,
    instructionBlock.trim(),
    `${sourceName} just said:\n${sourceMessage}`,
    `Output the final room-facing reply using exactly this envelope, with each marker on its own line:`,
    `START MARKER: ${replyBoundary.start}`,
    `END MARKER: ${replyBoundary.end}`,
    "Only place the final room message between those two lines.",
    "Respond naturally as if this is a real ongoing group chat.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function extractStructuredReplies(member, chunk) {
  const cleaned = stripAnsi(String(chunk)).replace(/\r/g, "\n").replace(/\u0007/g, "");
  if (!cleaned) return [];

  member.parserBuffer = `${member.parserBuffer}${cleaned}`.slice(-120000);
  const replies = [];
  const startMarker = member.expectedReplyStart;
  const endMarker = member.expectedReplyEnd;

  if (!startMarker || !endMarker) {
    return replies;
  }

  while (true) {
    const start = member.parserBuffer.indexOf(`\n${startMarker}\n`) >= 0
      ? member.parserBuffer.indexOf(`\n${startMarker}\n`) + 1
      : member.parserBuffer.startsWith(`${startMarker}\n`)
        ? 0
        : -1;
    if (start === -1) {
      member.parserBuffer = member.parserBuffer.slice(-(startMarker.length + endMarker.length + 4000));
      break;
    }

    const afterStart = member.parserBuffer.slice(start + startMarker.length);
    const normalizedAfterStart = afterStart.startsWith("\n") ? afterStart.slice(1) : afterStart;
    const end = normalizedAfterStart.indexOf(`\n${endMarker}`);
    if (end === -1) {
      member.parserBuffer = member.parserBuffer.slice(start);
      break;
    }

    const body = normalizedAfterStart
      .slice(0, end)
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trim();

    if (body) {
      replies.push(body);
    }

    member.parserBuffer = normalizedAfterStart.slice(end + 1 + endMarker.length);
    member.expectedReplyStart = null;
    member.expectedReplyEnd = null;
  }

  return replies;
}

module.exports = {
  DEFAULT_RUNNERS,
  createBlueCoreApp,
  createDefaultTemplates,
};
