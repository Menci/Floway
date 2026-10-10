import { packReasoningSignature } from '../../../anthropic-messages-and-openai-responses/reasoning.ts';
import { isContextExceededError } from '../../../anthropic-messages-via/context-window-error.ts';
import type { IRJSONObject, IRContentPart, IRItem, IRSourceCitation } from '../../ir.ts';
import { cloneIRJSON, parseIRJSONObject } from '../../shared/json.ts';
import { irOutputMetadata, irServingModel } from '../../shared/metadata.ts';
import { createIRProjection, type IROutputOptions } from '../../shared/projection.ts';
import { usageFromIR, irServiceTier, type IRWire } from '../../shared/usage.ts';
import { consumeIRRecords, type IRFrame, type IRPath } from '../../stream.ts';
import { PROMPT_TOO_LONG_MESSAGE, type AnthropicMessagesStreamEventEx, type AnthropicMessagesTextCitation } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type EventFrame } from '@floway-dev/protocols/common';

const irMessagesError = (error: IRJSONObject): IRJSONObject => isContextExceededError(error)
  ? { type: 'invalid_request_error', message: PROMPT_TOO_LONG_MESSAGE }
  : { type: ['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'rate_limit_error', 'api_error', 'overloaded_error'].includes(error.type as string) ? error.type : 'api_error', message: error.message };

interface IRMessagesUnit { item: number; part?: number; block?: IRWire; index?: number; closed: boolean; citations: number }

export interface IRMessagesOutputOptions extends IROutputOptions {
  // Source document/search-result indexes belong to the translated request context.
  // https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L1286-L1543
  resolveCitation?: (citation: IRSourceCitation) => AnthropicMessagesTextCitation | undefined;
}

export const anthropicMessagesFromIR = async function* (frames: AsyncIterable<IRFrame>, options: IRMessagesOutputOptions = {}): AsyncGenerator<EventFrame<AnthropicMessagesStreamEventEx>> {
  let metadata = { id: '', model: '', created: 0 };
  let started = false;
  const projection = createIRProjection();
  const units: IRMessagesUnit[] = [];
  const keys = new Set<string>();
  let cursor = 0;
  let blockIndex = 0;
  let finishReason = 'end_turn';
  let messageStarted = false;
  let sourceIds: IRWire = {};
  const emit = (event: IRWire): EventFrame<AnthropicMessagesStreamEventEx> => eventFrame(event as AnthropicMessagesStreamEventEx);
  const blockFor = (item: IRItem, part: IRContentPart | undefined, index: number, closed: boolean): IRWire | undefined => {
    if (item.type === 'message') return part?.type === 'text' || part?.type === 'refusal' || part?.type === 'audio' && part.audio.transcript !== undefined ? { type: 'text', text: '', citations: [] } : undefined;
    if (item.type === 'reasoning') {
      const text = [...item.summary ?? [], ...item.content ?? []].join('');
      const signature = sourceIds[index] === undefined ? item.encrypted_content : packReasoningSignature(sourceIds[index], item.encrypted_content ?? '');
      if (text !== '') return { type: 'thinking', thinking: '', signature: '' };
      if (!closed || signature == null) return undefined;
      return { type: 'redacted_thinking', data: signature };
    }
    if (item.type === 'function_call') return item.name === '' ? undefined : { type: 'tool_use', id: item.call_id ?? `${metadata.id}_${index}`, name: item.name, input: {} };
    return undefined;
  };
  for await (const { state, record } of consumeIRRecords(frames)) {
    if (record.type === 'start') { metadata = irOutputMetadata(record, options); started = true; }
    if (!started && record.type !== 'error') continue;
    metadata.model = irServingModel(state, metadata.model);
    if (record.type === 'error' || record.type === 'finish' && record.status === 'failed') {
      if (record.error === undefined) throw new TypeError('Failed IR generation requires an error');
      yield emit({ type: 'error', error: irMessagesError(record.error) });
      return;
    }
    if (state.choices.length > 1) throw new Error('Messages cannot represent multiple choices');
    sourceIds = state.extensions?.openaiResponses?.item_ids as IRWire ?? {};
    const tier = irServiceTier(state);
    const usage = { ...usageFromIR(state.usage ?? {}, 'anthropicMessages'), ...((state.extensions?.anthropicMessages as IRWire | undefined)?.usage ?? {}), ...(tier === undefined ? {} : tier === 'fast' ? { speed: 'fast' } : { service_tier: tier }) };
    if (!messageStarted && (state.choices.some(choice => choice.items.length > 0) || state.usage?.input_tokens_inclusive !== undefined || record.type === 'choice_end' || record.type === 'finish')) {
      yield emit({ type: 'message_start', message: { id: metadata.id, type: 'message', role: 'assistant', model: metadata.model, content: [], stop_reason: null, stop_sequence: null, stop_details: null, container: null, usage } });
      messageStarted = true;
    }
    if (record.type === 'ping') yield emit({ type: 'ping' });
    if (record.type === 'choice_end') finishReason = record.finish_reason === 'length' ? 'max_tokens' : record.finish_reason === 'tool_calls' ? 'tool_use' : record.finish_reason === 'content_filter' ? 'refusal' : 'end_turn';
    state.choices[0]?.items.forEach((item, index) => {
      const parts = item.type === 'message' ? item.content.map((_, p) => p) : [undefined];
      for (const part of parts) {
        const key = `${index}/${part ?? 'item'}`;
        if (!keys.has(key)) { units.push({ item: index, part, closed: false, citations: 0 }); keys.add(key); }
      }
    });
    for (const unit of units) {
      if (record.type === 'finish' || record.type === 'item_end' && record.item === unit.item || record.type === 'part_end' && record.item === unit.item && record.part === unit.part) unit.closed = true;
    }
    while (cursor < units.length) {
      const unit = units[cursor];
      const item = state.choices[0].items[unit.item];
      const part = item.type === 'message' && unit.part !== undefined ? item.content[unit.part] : undefined;
      const source: IRPath = ['choices', 0, 'items', unit.item];
      const block = blockFor(item, part, unit.item, unit.closed);
      if (block === undefined) {
        if (item.type === 'function_call' && item.name === '') {
          if (unit.closed) throw new TypeError('Completed tool calls require a name');
          break;
        }
        if (!unit.closed && (part?.type === 'audio' || item.type === 'reasoning')) break;
        cursor++; continue;
      }
      if (unit.index === undefined) {
        unit.index = blockIndex++; unit.block = block;
        yield emit({ type: 'content_block_start', index: unit.index, content_block: cloneIRJSON(block) });
      }
      const native = unit.block!;
      const target: IRPath = ['content', unit.index];
      const delta = (value: IRWire): EventFrame<AnthropicMessagesStreamEventEx> => emit({ type: 'content_block_delta', index: unit.index, delta: value });
      if (item.type === 'message' && part !== undefined) {
        const text = part.type === 'text' ? part.text : part.type === 'refusal' ? part.refusal : part.type === 'audio' ? part.audio.transcript! : '';
        const field = part.type === 'text' ? ['text'] : part.type === 'refusal' ? ['refusal'] : ['audio', 'transcript'];
        const value = projection.append([...source, 'content', unit.part!, ...field], text, [...target, 'text']);
        if (value !== '') { native.text += value; yield delta({ type: 'text_delta', text: value }); }
        if (part.type === 'text') {
          const citations = (part.annotations ?? []).flatMap(a => {
            const converted = options.resolveCitation?.(a);
            return converted === undefined ? [] : [converted];
          });
          for (let c = unit.citations; c < citations.length; c++) {
            native.citations.push(citations[c]); yield delta({ type: 'citations_delta', citation: citations[c] });
          }
          unit.citations = citations.length;
        }
      } else if (item.type === 'reasoning') {
        if (native.type === 'thinking') {
          const value = projection.append([...source, 'readable_text'], [...item.summary ?? [], ...item.content ?? []].join(''), [...target, 'thinking']);
          if (value !== '') { native.thinking += value; yield delta({ type: 'thinking_delta', thinking: value }); }
        }
        const signature = sourceIds[unit.item] === undefined ? item.encrypted_content : packReasoningSignature(sourceIds[unit.item], item.encrypted_content ?? '');
        if (unit.closed && signature != null) {
          const field = native.type === 'thinking' ? 'signature' : 'data';
          projection.assign([...source, 'encrypted_content'], signature, [...target, field]);
          if (native.type === 'thinking') yield delta({ type: 'signature_delta', signature });
        }
      } else if (item.type === 'function_call') {
        if (typeof item.arguments === 'string' && options.parseToolArguments === undefined || unit.closed) {
          const parsedArguments = unit.closed ? typeof item.arguments === 'string' ? parseIRJSONObject(item.arguments, options.parseToolArguments) : item.arguments ?? {} : undefined;
          const args = typeof item.arguments === 'string' && options.parseToolArguments === undefined ? item.arguments : JSON.stringify(parsedArguments);
          const value = projection.append([...source, 'arguments'], args, [...target, 'input']);
          if (value !== '') yield delta({ type: 'input_json_delta', partial_json: value });
          if (unit.closed) {
            projection.assign([...source, 'arguments'], JSON.stringify(parsedArguments), [...target, 'input']);
          }
        }
      }
      if (!unit.closed) break;
      yield emit({ type: 'content_block_stop', index: unit.index }); cursor++;
    }
    if (messageStarted && record.type === 'operation' && record.path[0] === 'usage') yield emit({ type: 'message_delta', delta: { stop_reason: null, stop_sequence: null, stop_details: null, container: null }, usage });
    if (record.type === 'finish') {
      const extension = state.extensions?.anthropicMessages;
      yield emit({ type: 'message_delta', delta: { stop_reason: finishReason, stop_sequence: extension?.stop_sequence ?? null, stop_details: state.choices[0]?.refusal === undefined ? extension?.stop_details ?? null : { type: 'refusal', ...state.choices[0].refusal }, container: extension?.container ?? null }, usage });

      yield emit({ type: 'message_stop' });
    }
  }
};
