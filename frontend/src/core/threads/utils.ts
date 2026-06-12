import type { Message } from "@langchain/langgraph-sdk";

import type { AgentThread, AgentThreadContext } from "./types";

type ThreadRouteTarget =
  | string
  | {
      thread_id: string;
      context?: Pick<AgentThreadContext, "agent_name"> | null;
      metadata?: Record<string, unknown> | null;
    };

export function pathOfThread(
  thread: ThreadRouteTarget,
  _context?: Pick<AgentThreadContext, "agent_name"> | null,
) {
  const threadId = typeof thread === "string" ? thread : thread.thread_id;
  return `/workspace/chats/${threadId}`;
}

export function textOfMessage(message: Message) {
  if (typeof message.content === "string") {
    return message.content;
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === "text") {
        return part.text;
      }
    }
  }
  return null;
}

export function titleOfThread(thread: AgentThread) {
  return thread.values?.title ?? "Untitled";
}
