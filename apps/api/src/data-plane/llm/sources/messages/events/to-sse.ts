import { type ProtocolFrame, type SseFrame, sseFrame } from '@floway-dev/protocols/common';
import type { MessagesContentBlockDeltaEvent, MessagesContentBlockStartEvent, MessagesStreamEventData, MessagesTextCitation, MessagesWebSearchResultLocation } from '@floway-dev/protocols/messages';

// Anthropic's Messages SSE wire format renames `search_result_location` fields
// (url -> source, drops the discriminator's typed fields the SDK type
// inherits) but keeps `web_search_result_location` exactly as the SDK shapes
// it. The SSE wire-shape union captures both variants so the to-sse builder
// type-checks against the protocol's serialized form, not the SDK input.
export interface MessagesSearchResultLocationSsePayload {
  type: 'search_result_location';
  source: string;
  title: string;
  search_result_index: number;
  start_block_index: number;
  end_block_index: number;
  cited_text?: string;
}

export type MessagesSseCitation = MessagesSearchResultLocationSsePayload | MessagesWebSearchResultLocation;

type TextContentBlock = Extract<MessagesContentBlockStartEvent['content_block'], { type: 'text' }>;
type NonTextContentBlock = Exclude<MessagesContentBlockStartEvent['content_block'], { type: 'text' }>;
type TextDelta = Extract<MessagesContentBlockDeltaEvent['delta'], { type: 'text_delta' }>;
type CitationsDelta = Extract<MessagesContentBlockDeltaEvent['delta'], { type: 'citations_delta' }>;
type OtherDelta = Exclude<MessagesContentBlockDeltaEvent['delta'], { type: 'text_delta' } | { type: 'citations_delta' }>;

interface MessagesSseContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block: NonTextContentBlock | (Omit<TextContentBlock, 'citations'> & { citations?: MessagesSseCitation[] });
}

interface MessagesSseContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: OtherDelta | (Omit<TextDelta, 'citations'> & { citations?: MessagesSseCitation[] }) | (Omit<CitationsDelta, 'citation'> & { citation: MessagesSseCitation });
}

export type MessagesSseEventPayload = Exclude<MessagesStreamEventData, { type: 'content_block_start' } | { type: 'content_block_delta' }> | MessagesSseContentBlockStartEvent | MessagesSseContentBlockDeltaEvent;

const citationToSsePayload = (citation: MessagesTextCitation): MessagesSseCitation =>
  citation.type === 'search_result_location'
    ? {
        type: citation.type,
        source: citation.url,
        title: citation.title,
        search_result_index: citation.search_result_index,
        start_block_index: citation.start_block_index,
        end_block_index: citation.end_block_index,
        ...(citation.cited_text ? { cited_text: citation.cited_text } : {}),
      }
    : citation;

const citationsToSsePayload = (citations?: MessagesTextCitation[]): MessagesSseCitation[] | undefined => citations?.map(citationToSsePayload);

const messagesEventToSsePayload = (event: MessagesStreamEventData): MessagesSseEventPayload => {
  if (event.type === 'content_block_start') {
    const { content_block } = event;
    if (content_block.type !== 'text' || !content_block.citations) return event as MessagesSseEventPayload;
    return {
      ...event,
      content_block: {
        ...content_block,
        citations: citationsToSsePayload(content_block.citations),
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
        citations: citationsToSsePayload(delta.citations),
      },
    };
  }

  return event as MessagesSseEventPayload;
};

export const messagesProtocolFrameToSSEFrame = (frame: ProtocolFrame<MessagesStreamEventData>): SseFrame | null =>
  frame.type === 'event' ? sseFrame(JSON.stringify(messagesEventToSsePayload(frame.event)), frame.event.type) : null;
