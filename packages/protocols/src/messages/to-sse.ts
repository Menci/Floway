import type { MessagesContentBlockDeltaEvent, MessagesContentBlockStartEvent, MessagesStreamEvent, MessagesTextCitation, MessagesWebSearchResultLocation } from './index.ts';
import { type ProtocolFrame, type SseFrame, sseFrame } from '../common/index.ts';

// Anthropic's Messages SSE wire format renames `search_result_location` fields
// (url -> source, drops the discriminator's typed fields the SDK type
// inherits) but keeps `web_search_result_location` exactly as the SDK shapes
// it. The SSE wire-shape union captures both variants so the to-sse builder
// type-checks against the protocol's serialized form, not the SDK input.
interface MessagesSearchResultLocationSsePayload {
  type: 'search_result_location';
  source: string;
  title: string;
  search_result_index: number;
  start_block_index: number;
  end_block_index: number;
  cited_text?: string;
}

type MessagesSseCitation = MessagesSearchResultLocationSsePayload | MessagesWebSearchResultLocation;

type MessagesSseTextContentBlock = Extract<MessagesContentBlockStartEvent['content_block'], { type: 'text' }>;
type MessagesSseNonTextContentBlock = Exclude<MessagesContentBlockStartEvent['content_block'], { type: 'text' }>;
type MessagesSseTextDelta = Extract<MessagesContentBlockDeltaEvent['delta'], { type: 'text_delta' }>;
type MessagesSseCitationsDelta = Extract<MessagesContentBlockDeltaEvent['delta'], { type: 'citations_delta' }>;
type MessagesSseOtherDelta = Exclude<MessagesContentBlockDeltaEvent['delta'], { type: 'text_delta' } | { type: 'citations_delta' }>;

interface MessagesSseContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block: MessagesSseNonTextContentBlock | (Omit<MessagesSseTextContentBlock, 'citations'> & { citations?: MessagesSseCitation[] });
}

interface MessagesSseContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: MessagesSseOtherDelta | (Omit<MessagesSseTextDelta, 'citations'> & { citations?: MessagesSseCitation[] }) | (Omit<MessagesSseCitationsDelta, 'citation'> & { citation: MessagesSseCitation });
}

type MessagesSseEventPayload = Exclude<MessagesStreamEvent, { type: 'content_block_start' } | { type: 'content_block_delta' }> | MessagesSseContentBlockStartEvent | MessagesSseContentBlockDeltaEvent;

const citationToSsePayload = (citation: MessagesTextCitation): MessagesSseCitation =>
  citation.type === 'search_result_location'
    ? {
        type: citation.type,
        source: citation.url,
        title: citation.title,
        search_result_index: citation.search_result_index,
        start_block_index: citation.start_block_index,
        end_block_index: citation.end_block_index,
        ...(citation.cited_text !== undefined ? { cited_text: citation.cited_text } : {}),
      }
    : citation;

const messagesEventToSsePayload = (event: MessagesStreamEvent): MessagesSseEventPayload => {
  if (event.type === 'content_block_start') {
    const { content_block } = event;
    if (content_block.type !== 'text' || !content_block.citations) return event as MessagesSseEventPayload;
    return {
      ...event,
      content_block: {
        ...content_block,
        citations: content_block.citations.map(citationToSsePayload),
      },
    };
  }

  if (event.type !== 'content_block_delta') return event;

  const { delta } = event;
  if (delta.type === 'citations_delta') {
    return {
      ...event,
      delta: {
        ...delta,
        citation: citationToSsePayload(delta.citation),
      },
    };
  }

  if (delta.type === 'text_delta' && delta.citations) {
    return {
      ...event,
      delta: {
        ...delta,
        citations: delta.citations.map(citationToSsePayload),
      },
    };
  }

  return event as MessagesSseEventPayload;
};

export const messagesProtocolFrameToSSEFrame = (frame: ProtocolFrame<MessagesStreamEvent>): SseFrame | null =>
  frame.type === 'event' ? sseFrame(JSON.stringify(messagesEventToSsePayload(frame.event)), frame.event.type) : null;
