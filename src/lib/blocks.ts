import type { AgentAction, Message, MessageBlock } from "@/lib/types";

/** Append streaming text to the last text block, or create a new text block after an action. */
export function appendTextBlock(blocks: MessageBlock[], delta: string): MessageBlock[] {
  if (!delta) return blocks;
  const last = blocks[blocks.length - 1];
  if (last && last.type === "text") {
    return [...blocks.slice(0, -1), { type: "text", text: last.text + delta }];
  }
  return [...blocks, { type: "text", text: delta }];
}

/** Update an existing action block in-place by ID, or append a new action block at the current timeline point. */
export function upsertActionBlock(blocks: MessageBlock[], action: AgentAction): MessageBlock[] {
  const index = blocks.findIndex((block) => block.type === "action" && block.action.id === action.id);
  if (index !== -1) {
    const next = [...blocks];
    next[index] = { type: "action", action };
    return next;
  }
  return [...blocks, { type: "action", action }];
}

/** Upsert into the flat actions array by ID. */
export function upsertActionList(actions: AgentAction[], action: AgentAction): AgentAction[] {
  const index = actions.findIndex((item) => item.id === action.id);
  if (index !== -1) {
    const next = [...actions];
    next[index] = action;
    return next;
  }
  return [...actions, action];
}

/** Combine all text blocks cleanly for search, copy, and conversation history. */
export function extractContent(blocks: MessageBlock[]): string {
  return blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Extract all actions from blocks in execution order. */
export function extractActions(blocks: MessageBlock[]): AgentAction[] {
  return blocks
    .filter((block): block is { type: "action"; action: AgentAction } => block.type === "action")
    .map((block) => block.action);
}

/** Backwards-compatible block list for both new interleaved messages and legacy DB messages. */
export function normalizeBlocks(message: Pick<Message, "content" | "actions" | "blocks">): MessageBlock[] {
  if (Array.isArray(message.blocks) && message.blocks.length > 0) {
    return message.blocks;
  }
  const fallback: MessageBlock[] = [];
  if (message.content) fallback.push({ type: "text", text: message.content });
  for (const action of message.actions || []) {
    fallback.push({ type: "action", action });
  }
  return fallback;
}
