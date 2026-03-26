import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

const RoomState = Annotation.Root({
  roomId: Annotation({
    reducer: (_, update) => update,
    default: () => "",
  }),
  turnCount: Annotation({
    reducer: (_, update) => update,
    default: () => 0,
  }),
  nextSpeakerIndex: Annotation({
    reducer: (_, update) => update,
    default: () => 0,
  }),
  history: Annotation({
    reducer: (_, update) => update,
    default: () => [],
  }),
  lastMessage: Annotation({
    reducer: (_, update) => update,
    default: () => null,
  }),
});

function buildPrompt({ room, speaker, history }) {
  const recentHistory = history
    .slice(-12)
    .map((entry) => `${entry.author}: ${entry.content}`)
    .join("\n");

  return [
    `You are in a group chat room called "${room.title}".`,
    `Your visible name is "${speaker.displayName}".`,
    `Your persona:\n${speaker.persona}`,
    `Working directory:\n${speaker.cwd}`,
    room.instruction ? `Room instruction:\n${room.instruction}` : "",
    "Recent chat history:",
    recentHistory || "(No prior messages yet)",
    "Continue the conversation naturally.",
    "You may inspect files, edit code, and run commands in the working directory when that helps the room objective.",
    "If you do work, mention concrete files or decisions briefly in your chat reply.",
    "Reply as a chat participant only.",
    "Keep the response concise and human, usually under 140 words.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function createRoomTurnGraph({ invokeAgent, resolveRoom }) {
  return new StateGraph(RoomState)
    .addNode("speakerTurn", async (state) => {
      const room = resolveRoom(state.roomId);
      if (!room) {
        throw new Error(`Room not found: ${state.roomId}`);
      }

      const speaker = room.members[state.nextSpeakerIndex % room.members.length];
      const prompt = buildPrompt({
        room,
        speaker,
        history: state.history,
      });

      const result = await invokeAgent({
        model: speaker.model,
        prompt,
        cwd: speaker.cwd,
        roomId: state.roomId,
        speaker,
      });
      const content = typeof result === "string" ? result : result?.content || "";

      return {
        roomId: state.roomId,
        turnCount: state.turnCount + 1,
        nextSpeakerIndex: (state.nextSpeakerIndex + 1) % room.members.length,
        history: [
          ...state.history,
          {
            author: speaker.displayName,
            content,
            model: speaker.model,
            sessionId: speaker.sessionId,
          },
        ],
        lastMessage: {
          author: speaker.displayName,
          content,
          model: speaker.model,
          sessionId: speaker.sessionId,
        },
      };
    })
    .addEdge(START, "speakerTurn")
    .addEdge("speakerTurn", END)
    .compile();
}
