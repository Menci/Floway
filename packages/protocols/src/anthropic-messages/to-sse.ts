import type { AnthropicMessagesContentBlockDeltaEvent, AnthropicMessagesContentBlockStartEvent, AnthropicMessagesStreamEvent, AnthropicMessagesTextCitation, AnthropicMessagesWebSearchResultLocation } from './index.ts';
import { type ProtocolFrame, type SseFrame, sseFrame } from '../common/index.ts';

// Anthropic's Anthropic Messages SSE wire format renames `search_result_location` fields
// (url -> source, drops the discriminator's typed fields the SDK type
// inherits) but keeps `web_search_result_location` exactly as the SDK shapes
// it. The SSE wire-shape union captures both variants so the to-sse builder
// type-checks against the protocol's serialized form, not the SDK input.
interface AnthropicMessagesSearchResultLocationSsePayload {
  type: 'search_result_location';
  source: string;
  title: string;
  search_result_index: number;
  start_block_index: number;
  end_block_index: number;
  cited_text?: string;
}

type AnthropicMessagesSseCitation = AnthropicMessagesSearchResultLocationSsePayload | AnthropicMessagesWebSearchResultLocation;

type AnthropicMessagesSseTextContentBlock = Extract<AnthropicMessagesContentBlockStartEvent['content_block'], { type: 'text' }>;
type AnthropicMessagesSseNonTextContentBlock = Exclude<AnthropicMessagesContentBlockStartEvent['content_block'], { type: 'text' }>;
type AnthropicMessagesSseTextDelta = Extract<AnthropicMessagesContentBlockDeltaEvent['delta'], { type: 'text_delta' }>;
type AnthropicMessagesSseCitationsDelta = Extract<AnthropicMessagesContentBlockDeltaEvent['delta'], { type: 'citations_delta' }>;
type AnthropicMessagesSseOtherDelta = Exclude<AnthropicMessagesContentBlockDeltaEvent['delta'], { type: 'text_delta' } | { type: 'citations_delta' }>;

interface AnthropicMessagesSseContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block: AnthropicMessagesSseNonTextContentBlock | (Omit<AnthropicMessagesSseTextContentBlock, 'citations'> & { citations?: AnthropicMessagesSseCitation[] });
}

interface AnthropicMessagesSseContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: AnthropicMessagesSseOtherDelta | (Omit<AnthropicMessagesSseTextDelta, 'citations'> & { citations?: AnthropicMessagesSseCitation[] }) | (Omit<AnthropicMessagesSseCitationsDelta, 'citation'> & { citation: AnthropicMessagesSseCitation });
}

type AnthropicMessagesSseEventPayload = Exclude<AnthropicMessagesStreamEvent, { type: 'content_block_start' } | { type: 'content_block_delta' }> | AnthropicMessagesSseContentBlockStartEvent | AnthropicMessagesSseContentBlockDeltaEvent;

const citationToSsePayload = (citation: AnthropicMessagesTextCitation): AnthropicMessagesSseCitation =>
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

const anthropicMessagesEventToSsePayload = (event: AnthropicMessagesStreamEvent): AnthropicMessagesSseEventPayload => {
  if (event.type === 'content_block_start') {
    const { content_block } = event;
    if (content_block.type !== 'text' || !content_block.citations) return event as AnthropicMessagesSseEventPayload;
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

  return event as AnthropicMessagesSseEventPayload;
};

export const anthropicMessagesProtocolFrameToSSEFrame = (frame: ProtocolFrame<AnthropicMessagesStreamEvent>): SseFrame | null =>
  frame.type === 'event' ? sseFrame(JSON.stringify(anthropicMessagesEventToSsePayload(frame.event)), frame.event.type) : null;
