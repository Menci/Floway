import type { DumpStreamEvent } from "@floway-dev/gateway/dump-types";
import {
  chatCompletionsProtocolFrameToSSEFrame,
  collectChatCompletionsProtocolEventsToResult,
} from "@floway-dev/protocols/chat-completions";
import {
  completionsProtocolFrameToSSEFrame,
  reassembleCompletionsEvents,
  type CompletionsStreamEvent,
} from "@floway-dev/protocols/completions";
import type { ProtocolFrame, SseFrame } from "@floway-dev/protocols/common";
import {
  collectGeminiProtocolEventsToResult,
  geminiProtocolFrameToSSEFrame,
  type GeminiStreamEvent,
} from "@floway-dev/protocols/gemini";
import {
  collectMessagesProtocolEventsToResult,
  messagesProtocolFrameToSSEFrame,
} from "@floway-dev/protocols/messages";
import {
  collectResponsesProtocolEventsToResult,
  responsesProtocolFrameToSSEFrame,
} from "@floway-dev/protocols/responses";

export type CollectKind = "completions" | "chat-completions" | "messages" | "responses" | "gemini";

export interface CollectedStream {
  result: unknown | null;
  error: string | null;
}

export interface RenderedStreamEvent {
  event: string | null;
  text: string;
  parseError: string | null;
  timestamp: number;
}

export function detectCollectKind(path: string): CollectKind | null {
  if (path.includes("/messages")) return "messages";
  if (path.includes("/responses")) return "responses";
  if (path.includes("/chat/completions")) return "chat-completions";
  if (path.includes("/completions")) return "completions";
  if (path.includes("/v1beta/") || path.includes(":generateContent")) return "gemini";
  return null;
}

export async function collectStream(kind: CollectKind, events: DumpStreamEvent[]): Promise<CollectedStream> {
  try {
    switch (kind) {
      case "chat-completions":
        return { result: await collectChatCompletionsProtocolEventsToResult(frames(events) as never), error: null };
      case "messages":
        return { result: await collectMessagesProtocolEventsToResult(frames(events) as never), error: null };
      case "responses":
        return { result: await collectResponsesProtocolEventsToResult(frames(events) as never), error: null };
      case "gemini":
        return { result: await collectGeminiProtocolEventsToResult(frames(events) as AsyncIterable<ProtocolFrame<GeminiStreamEvent>>), error: null };
      case "completions": {
        const stream = (async function* () {
          for (const { frame } of events) {
            const typed = frame as ProtocolFrame<CompletionsStreamEvent>;
            if (typed.type === "event") yield typed.event;
          }
        })();
        return { result: await reassembleCompletionsEvents(stream), error: null };
      }
    }
  } catch (cause) {
    return { result: null, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export function renderStreamEvents(kind: CollectKind | null, events: DumpStreamEvent[]): RenderedStreamEvent[] {
  return events.map(({ frame, ts }) => {
    const sse = frameToSse(kind, frame);
    if (!sse) return { event: null, text: "", parseError: null, timestamp: ts };
    try {
      return { event: sse.event ?? null, text: JSON.stringify(JSON.parse(sse.data) as unknown, null, 2), parseError: null, timestamp: ts };
    } catch (cause) {
      return { event: sse.event ?? null, text: sse.data, parseError: cause instanceof Error ? cause.message : String(cause), timestamp: ts };
    }
  });
}

export function streamEventsCopyText(kind: CollectKind | null, events: DumpStreamEvent[]): string {
  return events.map(({ frame }) => {
    const sse = frameToSse(kind, frame);
    return sse ? `${sse.event ? `event: ${sse.event}\n` : ""}data: ${sse.data}\n` : "";
  }).filter(Boolean).join("\n");
}

async function* frames(events: DumpStreamEvent[]) {
  for (const event of events) yield event.frame;
}

function frameToSse(kind: CollectKind | null, frame: ProtocolFrame<unknown>): SseFrame | null {
  try {
    switch (kind) {
      case "chat-completions": return chatCompletionsProtocolFrameToSSEFrame(frame as never, { includeUsageChunk: true });
      case "completions": return completionsProtocolFrameToSSEFrame(frame as never);
      case "messages": return messagesProtocolFrameToSSEFrame(frame as never);
      case "responses": return responsesProtocolFrameToSSEFrame(frame as never);
      case "gemini": return geminiProtocolFrameToSSEFrame(frame as never);
      default: return null;
    }
  } catch (cause) {
    return { type: "sse", event: "serialize_error", data: cause instanceof Error ? cause.message : String(cause) };
  }
}
