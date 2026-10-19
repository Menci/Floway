import type { AnthropicMessagesAssistantState } from './assistant-turn.ts';
import { type AnthropicMessagesInputCounts, usageToIR } from './usage.ts';
import { createIRBuilder, type IRItemHandle, type IRPartHandle, type IRRecord } from '../../../ir/stream.ts';
import type { IRSourceCitation } from '../../../ir/types.ts';
import { appendField, createFieldState, type FieldState, type FieldStates } from '../../../round-trip/reference/reference-builder.ts';
import type { RoundTripReader } from '../../../round-trip/stream.ts';
import { requireJSONObject } from '../../../shared/json/object.ts';
import { unwrapCustomToolInput } from '../../openai-responses/common/custom-tool-wrap.ts';
import {
  type AnthropicMessagesAssistantContentBlock,
  type AnthropicMessagesStreamEventEx,
  type AnthropicMessagesTextCitation,
  type AnthropicMessagesUsageDeltaEx,
  createAnthropicMessagesEventAccumulator,
} from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

const messagesCitationToIR = (citation: AnthropicMessagesTextCitation): IRSourceCitation | undefined => {
  const isSearchLocation = citation.type === 'web_search_result_location' || citation.type === 'search_result_location';
  const source = citation.type === 'web_search_result_location' ? citation.url
    : citation.type === 'search_result_location' ? citation.source : citation.file_id ?? undefined;
  const label = isSearchLocation ? citation.title : citation.document_title;
  const citedText = typeof citation.cited_text === 'string' && citation.cited_text !== '' ? citation.cited_text : undefined;
  if (source === undefined && citedText === undefined) return undefined;
  return {
    type: 'source_citation',
    source_kind: citation.type === 'web_search_result_location' ? 'url' : citation.type === 'search_result_location' ? 'search_result' : 'document',
    ...(source === undefined ? {} : { source }),
    ...(label == null ? {} : { source_label: label }),
    ...(citedText === undefined ? {} : { source_text: citedText }),
    ...(citation.type === 'page_location'
      ? { source_page_range: { start_one_based: citation.start_page_number, end_one_based_exclusive: citation.end_page_number } }
      : {}),
  } as IRSourceCitation;
};

// Blocks that open no IR item; their content is not translated.
const UNTRANSLATED_BLOCK_TYPES: readonly string[] = [
  'redacted_thinking',
  'server_tool_use',
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'tool_search_tool_result',
  'container_upload',
];

type MessagesBlockFieldState = NonNullable<NonNullable<AnthropicMessagesAssistantState<FieldStates>['content']>[number]>;

interface MessagesBlockState {
  readonly item?: IRItemHandle;
  readonly part?: IRPartHandle;
  readonly custom: boolean;
  annotationCount?: number;
  textField?: FieldState<'text'>;
  jsonField?: FieldState<'json'>;
  fieldState?: MessagesBlockFieldState;
  wrappedInput: string;
}

export const irFromAnthropicMessages = async function* (
  frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>,
  options: { customToolNames?: ReadonlySet<string>; roundTrip: RoundTripReader<'anthropicMessages'> },
): AsyncGenerator<IRRecord> {
  const ir = createIRBuilder();
  const blocks = new Map<number, MessagesBlockState>();
  const blockStates = new Map<number, MessagesBlockState>();
  const nativeAccumulator = createAnthropicMessagesEventAccumulator();
  let started = false;
  let finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' = 'stop';
  let finished = false;

  const inputCounts: AnthropicMessagesInputCounts = {};
  const assignUsage = (usage: Partial<AnthropicMessagesUsageDeltaEx> | null | undefined): void => {
    ir.usage(usageToIR(usage, inputCounts));
    const tier = usage?.speed === 'fast' ? 'fast' : usage?.service_tier;
    if (typeof tier === 'string') ir.assign(['service_tier'], tier);
  };

  const openBlock = (index: number, block: AnthropicMessagesAssistantContentBlock): void => {
    if (blocks.has(index)) throw new Error(`Duplicate Messages content_block_start at index ${index}`);
    let item: IRItemHandle | undefined;
    let part: IRPartHandle | undefined;
    let annotationCount: number | undefined;
    let custom = false;
    let textField: FieldState<'text'> | undefined;
    if (block.type === 'fallback') {
      ir.assign(['model'], block.to.model);
    } else if (block.type === 'text') {
      item = ir.item(0, { type: 'message', content: [] });
      const annotations = block.citations === undefined ? undefined : block.citations === null ? null : block.citations.flatMap(citation => {
        const converted = messagesCitationToIR(citation);
        return converted === undefined ? [] : [converted];
      });
      part = item.part({ type: 'text', text: '', ...(annotations === undefined ? {} : { annotations }) });
      annotationCount = Array.isArray(annotations) ? annotations.length : undefined;
      if (block.text !== '') {
        textField = createFieldState('text');
        part.append('text', block.text, [appendField(options.roundTrip.builder, textField, block.text)]);
      }
    } else if (block.type === 'thinking') {
      item = ir.item(0, { type: 'reasoning', summary: [''] });
      if (block.thinking !== '') {
        textField = createFieldState('text');
        item.append(['summary', 0], block.thinking, [appendField(options.roundTrip.builder, textField, block.thinking)]);
      }
    } else if (block.type === 'tool_use') {
      custom = options.customToolNames?.has(block.name) === true;
      item = ir.item(0, custom
        ? { type: 'custom_tool_call', call_id: block.id, name: block.name, input: '' }
        : { type: 'function_call', call_id: block.id, name: block.name, arguments: '' });
    } else if (!UNTRANSLATED_BLOCK_TYPES.includes(block.type)) {
      throw new TypeError(`Cannot translate Messages content block ${block.type}`);
    }
    const state: MessagesBlockState = {
      item, part, custom, annotationCount, wrappedInput: '', textField,
      fieldState: textField === undefined ? undefined : block.type === 'text' ? { text: textField } : { thinking: textField },
    };
    blocks.set(index, state);
    blockStates.set(index, state);
  };

  for await (const frame of frames) {
    if (frame.type === 'done') throw new Error('Messages done arrived without message_stop');
    const e = frame.event;
    if (e.type !== 'error') nativeAccumulator.accept(e);
    switch (e.type) {
    case 'message_start':
      if (started) throw new Error('Duplicate Messages message_start');
      if (typeof e.message.id !== 'string') throw new TypeError('Messages message_start requires an id');
      if (typeof e.message.model !== 'string') throw new TypeError('Messages message_start requires a model');
      ir.choice(0);
      ir.assign(['model'], e.message.model);
      assignUsage(e.message.usage);
      ir.event({ type: 'start', id: e.message.id });
      started = true;
      break;
    case 'content_block_start':
      if (!started) throw new Error('Messages content_block_start arrived before message_start');
      openBlock(e.index, e.content_block);
      break;
    case 'content_block_delta': {
      const block = blocks.get(e.index);
      if (block === undefined) throw new Error('Messages delta arrived before content_block_start');
      const d = e.delta;
      if (block.item === undefined) break;
      switch (d.type) {
      case 'text_delta':
        if (d.text !== '') {
          if (block.textField === undefined) {
            block.textField = createFieldState('text');
            block.fieldState = { text: block.textField };
          }
          const partId = appendField(options.roundTrip.builder, block.textField, d.text);
          if (block.part === undefined) block.item.append(['content', 0, 'text'], d.text, [partId]);
          else block.part.append('text', d.text, [partId]);
        }
        break;
      case 'thinking_delta':
        if (d.thinking !== '') {
          if (block.textField === undefined) {
            block.textField = createFieldState('text');
            block.fieldState = { thinking: block.textField };
          }
          block.item.append(['summary', 0], d.thinking, [appendField(options.roundTrip.builder, block.textField, d.thinking)]);
        }
        break;
      case 'signature_delta': break;
      case 'input_json_delta':
        if (d.partial_json !== '') {
          if (block.jsonField === undefined) {
            block.jsonField = createFieldState('json');
            block.fieldState = { input: block.jsonField };
          }
          const partId = appendField(options.roundTrip.builder, block.jsonField, d.partial_json);
          if (block.custom) block.wrappedInput += d.partial_json;
          else block.item.append('arguments', d.partial_json, [partId]);
        }
        break;
      case 'citations_delta': {
        if (block.part === undefined) throw new TypeError('Messages citation requires a text block');
        const annotation = messagesCitationToIR(d.citation);
        if (annotation === undefined) break;
        if (block.annotationCount === undefined) {
          block.part.assign('annotations', [annotation]);
          block.annotationCount = 1;
        } else {
          block.part.assign(['annotations', block.annotationCount], annotation);
          block.annotationCount++;
        }
        break;
      }
      default: throw new TypeError(`Cannot translate Messages delta ${d.type}`);
      }
      break;
    }
    case 'content_block_stop': {
      const block = blocks.get(e.index);
      if (block === undefined) throw new Error('Messages content_block_stop arrived before content_block_start');
      blocks.delete(e.index);
      if (block.item !== undefined) {
        if (block.custom) {
          const input = unwrapCustomToolInput(block.wrappedInput);
          if (input !== '') block.item.append('input', input);
        }
        block.item.end();
      }
      break;
    }
    case 'message_delta':
      if (!started) throw new Error('Messages message_delta arrived before message_start');
      assignUsage(e.usage);
      if (e.delta.stop_reason === 'compaction') throw new TypeError('Cannot translate Messages compaction stop');
      if (e.delta.stop_reason === 'refusal') {
        ir.choice(0).assign('refusal', {
          category: e.delta.stop_details?.category ?? null,
          explanation: e.delta.stop_details?.explanation ?? null,
        });
      }
      if (e.delta.stop_reason != null) {
        const stopReason = e.delta.stop_reason;
        finishReason = stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded' ? 'length'
          : stopReason === 'tool_use' ? 'tool_calls'
            : stopReason === 'refusal' ? 'content_filter' : 'stop';
      }
      break;
    case 'message_stop': {
      if (!started) throw new Error('Messages message_stop arrived before message_start');
      if (blocks.size > 0) throw new Error('Messages message_stop arrived with open content blocks');
      const nativeResult = nativeAccumulator.result();
      const contentFields: NonNullable<AnthropicMessagesAssistantState<FieldStates>['content']> = [];
      contentFields.length = nativeResult.content.length;
      [...blockStates.entries()].toSorted(([left], [right]) => left - right).forEach(([, block], index) => {
        if (block.fieldState !== undefined) contentFields[index] = block.fieldState;
      });
      const content = nativeResult.content.map(block => block.type === 'tool_use' ? { ...block, input: requireJSONObject(block.input) } : block);
      options.roundTrip.onAssistantTurn(0, { role: 'assistant', content }, { content: contentFields });
      ir.choice(0).end(finishReason);
      ir.event({ type: 'finish', status: finishReason === 'length' ? 'incomplete' : 'completed' });
      finished = true;
      break;
    }
    case 'error':
      ir.event({ type: 'error', error: e.error });
      yield* ir.drain();
      return;
    case 'ping':
      ir.event({ type: 'ping' });
      break;
    }
    yield* ir.drain();
    if (finished) return;
  }
  throw new Error('Messages stream ended without message_stop');
};
