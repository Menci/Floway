import { parseToolArgumentsObject } from '../messages/tool-arguments.ts';
import { responsesReasoningToMessagesBlock, unpackReasoningSignature } from '../messages-and-responses/reasoning.ts';
import type { ChatCompletionsReasoningItem, ChatCompletionsMessage } from '@floway-dev/protocols/chat-completions';
import type { GeminiContent } from '@floway-dev/protocols/gemini';
import type { MessagesAssistantContentBlock, MessagesMessage } from '@floway-dev/protocols/messages';
import type { ResponsesInputItem, ResponsesPayload } from '@floway-dev/protocols/responses';

// Wire `ResponsesPayload.input` is `string | ResponsesInputItem[]`. The
// gateway's canonical internal shape narrows it to array-only: every
// consumer past the wire boundary (HTTP / WS entry canonicalization,
// cross-protocol translation returning this type) sees a real item array.
// The name is owned here because `*-via-responses` translators produce this
// shape directly — their `buildTargetRequest` always constructs an array —
// so the boundary between "wire" and "canonical" naturally sits at the
// translator's return type.
export type CanonicalResponsesPayload = Omit<ResponsesPayload, 'input'> & {
  input: ResponsesInputItem[];
};

// Lifts a wire `ResponsesPayload` to canonical form by wrapping a bare-string
// `input` into a single synthetic user-role message. Called at every wire
// boundary that produces a `ResponsesPayload` destined for internal use — the
// HTTP entry parsing a request body, and the WebSocket entry building a
// payload from a client frame. Cross-protocol translators return
// `CanonicalResponsesPayload` directly and do not need this step.
export const canonicalizeResponsesPayload = (payload: ResponsesPayload): CanonicalResponsesPayload => ({
  ...payload,
  input: typeof payload.input === 'string'
    ? [{ type: 'message', role: 'user', content: payload.input }]
    : payload.input,
});

export type ResponsesItemMapper = (
  item: ResponsesInputItem,
) => ResponsesInputItem | null | Promise<ResponsesInputItem | null>;

export type ResponsesItemVisitor = (item: ResponsesInputItem) => void | Promise<void>;

// A view onto a source protocol that projects Responses items in and out
// of the source's payload. Visit is read-only iteration; map is 1-to-1
// rewrite or 1-to-null drop.
//
// `mapAsResponsesItems` ownership invariant: callers pass items they own —
// the per-attempt `structuredClone` of the payload is the sole isolation —
// so the mapper builds fresh container arrays/objects but reuses input
// elements directly and must not defensively deep-clone them.
//
// The mapped form of a source-items type is always its source minus the
// top-level `readonly`: the view owns the per-attempt payload clone, so it
// hands back a freely-mutable container. The mapped type is therefore derived
// rather than carried as a second generic. Distributing over unions keeps
// `Mutable<string | readonly ResponsesInputItem[]>` equal to
// `string | ResponsesInputItem[]`.
type Mutable<T> = T extends readonly (infer E)[] ? E[] : T;

export interface ResponsesItemsView<TSourceItems> {
  visitAsResponsesItems(sourceItems: TSourceItems, visitor: ResponsesItemVisitor): Promise<void>;
  mapAsResponsesItems(sourceItems: TSourceItems, mapper: ResponsesItemMapper): Promise<Mutable<TSourceItems>>;
}

// ---------------------------------------------------------------------------
// Responses source
// ---------------------------------------------------------------------------

export const responsesItemsView = {
  visitAsResponsesItems: async (
    input: string | readonly ResponsesInputItem[],
    visitor: ResponsesItemVisitor,
  ): Promise<void> => {
    if (typeof input === 'string') return;
    for (const item of input) await visitor(item);
  },
  mapAsResponsesItems: async (
    input: string | readonly ResponsesInputItem[],
    mapper: ResponsesItemMapper,
  ): Promise<string | ResponsesInputItem[]> => {
    if (typeof input === 'string') return input;

    const out: ResponsesInputItem[] = [];
    for (const item of input) {
      const mapped = await mapper(item);
      if (mapped !== null) out.push(mapped);
    }
    return out;
  },
} satisfies ResponsesItemsView<string | readonly ResponsesInputItem[]>;

// ---------------------------------------------------------------------------
// Messages source
// ---------------------------------------------------------------------------

export const messagesViaResponsesItemsView = {
  visitAsResponsesItems: async (
    messages: readonly MessagesMessage[],
    visitor: ResponsesItemVisitor,
  ): Promise<void> => {
    for (const message of messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;

      for (const block of message.content) {
        const carrier = reasoningCarrier(block);
        if (carrier === null) continue;

        await visitor({
          type: 'reasoning',
          id: carrier.id,
          summary: carrier.thinking ? [{ type: 'summary_text', text: carrier.thinking }] : [],
          ...(carrier.encryptedContent ? { encrypted_content: carrier.encryptedContent } : {}),
        });
      }
    }
  },
  mapAsResponsesItems: async (
    messages: readonly MessagesMessage[],
    mapper: ResponsesItemMapper,
  ): Promise<MessagesMessage[]> => {
    const out: MessagesMessage[] = [];
    for (const message of messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) {
        out.push(message);
        continue;
      }

      const content: MessagesAssistantContentBlock[] = [];
      for (const block of message.content) {
        // A `${enc}@${id}` carrier never originates from a native Anthropic
        // Messages model — Anthropic only emits opaque signatures with no `@`.
        // It exists only because our own messages-via-responses translation
        // packed a Responses reasoning id into the signature, or the session
        // previously passed through another gateway using the same interop
        // layout. A foreign gateway's id is not one of our stored ids, so it
        // does not resolve here and the block is forwarded untouched.
        const carrier = reasoningCarrier(block);
        if (carrier === null) {
          content.push(block);
          continue;
        }

        const mapped = await mapper({
          type: 'reasoning',
          id: carrier.id,
          summary: carrier.thinking ? [{ type: 'summary_text', text: carrier.thinking }] : [],
          ...(carrier.encryptedContent ? { encrypted_content: carrier.encryptedContent } : {}),
        });
        if (mapped === null) continue;
        const projected = responsesItemToMessagesAssistantBlock(mapped);
        if (projected !== null) content.push(projected);
      }

      out.push({ role: 'assistant', content });
    }
    return out;
  },
} satisfies ResponsesItemsView<readonly MessagesMessage[]>;

// A reasoning block echoed back by a Messages client carries the packed
// `${encrypted_content}@${id}` value in `thinking.signature` or
// `redacted_thinking.data`. Returns the unpacked id only when the carrier was
// issued by this gateway; a native upstream signature (no `@`) has no
// stored id to rewrite and is left untouched.
const reasoningCarrier = (block: MessagesAssistantContentBlock): { id: string; encryptedContent: string; thinking: string } | null => {
  const carrier = block.type === 'thinking' ? block.signature : block.type === 'redacted_thinking' ? block.data : undefined;
  if (carrier === undefined) return null;

  const { id, encryptedContent } = unpackReasoningSignature(carrier);
  if (id === null) return null;

  return { id, encryptedContent, thinking: block.type === 'thinking' ? block.thinking : '' };
};

const responsesItemToMessagesAssistantBlock = (item: ResponsesInputItem): MessagesAssistantContentBlock | null => {
  switch (item.type) {
  case 'reasoning':
    return responsesReasoningToMessagesBlock(item);
  case 'message': {
    if (item.role !== 'assistant') return null;
    const text = typeof item.content === 'string'
      ? item.content
      : item.content.filter((part): part is Extract<typeof part, { text: string }> => 'text' in part).map(part => part.text).join('');
    return text ? { type: 'text', text } : null;
  }
  case 'function_call':
    return { type: 'tool_use', id: item.call_id, name: item.name, input: parseToolArgumentsObject(item.arguments) };
  case 'custom_tool_call':
    return { type: 'tool_use', id: item.call_id, name: item.name, input: { input: item.input } };
  default:
    throw new Error(`Cannot project Responses ${item.type} item into a Messages assistant content block`);
  }
};

// ---------------------------------------------------------------------------
// Chat Completions source
// ---------------------------------------------------------------------------

export const chatCompletionsViaResponsesItemsView = {
  visitAsResponsesItems: async (
    messages: readonly ChatCompletionsMessage[],
    visitor: ResponsesItemVisitor,
  ): Promise<void> => {
    for (const message of messages) {
      if (message.role !== 'assistant' || !message.reasoning_items?.length) continue;

      for (const item of message.reasoning_items) {
        if (!item.id) continue;
        await visitor({ type: 'reasoning', id: item.id, summary: item.summary ?? [] });
      }
    }
  },
  mapAsResponsesItems: async (
    messages: readonly ChatCompletionsMessage[],
    mapper: ResponsesItemMapper,
  ): Promise<ChatCompletionsMessage[]> => {
    const out: ChatCompletionsMessage[] = [];
    for (const message of messages) {
      if (message.role !== 'assistant' || !message.reasoning_items?.length) {
        out.push(message);
        continue;
      }

      const reasoningItems: ChatCompletionsReasoningItem[] = [];
      for (const item of message.reasoning_items) {
        if (!item.id) {
          reasoningItems.push(item);
          continue;
        }
        const mapped = await mapper({ type: 'reasoning', id: item.id, summary: item.summary ?? [] });
        if (mapped === null) continue;
        if (mapped.type !== 'reasoning') throw new Error(`Cannot project Responses ${mapped.type} item into Chat reasoning_items`);
        reasoningItems.push({ type: 'reasoning', id: mapped.id, summary: mapped.summary });
      }

      out.push({
        ...message,
        reasoning_items: reasoningItems.length > 0 ? reasoningItems : null,
      });
    }
    return out;
  },
} satisfies ResponsesItemsView<readonly ChatCompletionsMessage[]>;

// ---------------------------------------------------------------------------
// Gemini source
// ---------------------------------------------------------------------------

// Placeholder view. Gemini does not yet have a reasoning-id / signature
// carrier in its protocol, so there is nothing to project. The empty
// implementations let `gemini/serve.ts` go through the uniform stored-items
// ceremony without branching on protocol; when Gemini gains signature
// support, fill these in and the rest of the pipeline keeps working.
export const geminiViaResponsesItemsView = {
  visitAsResponsesItems: async (
    _contents: readonly GeminiContent[],
    _visitor: ResponsesItemVisitor,
  ): Promise<void> => {},
  mapAsResponsesItems: async (
    contents: readonly GeminiContent[],
    _mapper: ResponsesItemMapper,
  ): Promise<GeminiContent[]> => [...contents],
} satisfies ResponsesItemsView<readonly GeminiContent[]>;
