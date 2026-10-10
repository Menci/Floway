import { restoreNamespaceOutputItem, type NamespaceToolNames } from '../../../openai-responses-via/namespace-tools.ts';
import type { IRItem } from '../../ir.ts';
import { createOpenAIResponsesReplayCheck, createOpenAIResponsesSidecarCarrier, type OpenAIResponsesAssistantTurn } from '../../round-trip/openai-responses.ts';
import { irRangeToCodePoints } from '../../shared/coordinates.ts';
import { cloneIRJSON, isCompleteIRJSONObject } from '../../shared/json.ts';
import { irOutputMetadata, irServingModel } from '../../shared/metadata.ts';
import { createIRProjection, type IROutputOptions } from '../../shared/projection.ts';
import { usageFromIR, irServiceTier, type IRWire } from '../../shared/usage.ts';
import { consumeIRRecords, type IRFrame, type IRPath } from '../../stream.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { createRandomOpenAIResponsesItemId, openaiResponsesResultToEvents, type OpenAIResponsesOutputItemEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export interface IRResponsesOutputOptions extends IROutputOptions {
  namespaceToolNames?: NamespaceToolNames;
}

export const openaiResponsesFromIR = async function* (frames: AsyncIterable<IRFrame>, options: IRResponsesOutputOptions = {}): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  let metadata = { id: '', model: '', created: 0 };
  let started = false;
  const projection = createIRProjection();
  const output: IRWire[] = [];
  const indices = new Map<string, number>();
  const ended = new Set<string>();
  const closedParts = new Set<string>();
  let sequence = 0;
  let finishReason = 'stop';
  let extension: IRWire = {};
  let sourceIds: IRWire = {};
  const completedItems = new Map<number, 'completed' | 'incomplete'>();
  let choiceEnded = false;
  const emit = (event: IRWire): ProtocolFrame<OpenAIResponsesStreamEventEx> => eventFrame({ ...event, sequence_number: sequence++ } as OpenAIResponsesStreamEventEx);
  const response = (status: string, usage: unknown = null): IRWire => ({ ...extension, id: metadata.id, object: 'response', created_at: metadata.created, model: metadata.model, status, output: cloneIRJSON(output), usage, error: null, incomplete_details: status === 'incomplete' ? extension.incomplete_details ?? { reason: finishReason === 'content_filter' ? 'content_filter' : 'max_output_tokens' } : null });
  let stateChatSource = false;
  const targetItem = (item: IRItem, sourceIndex: number, closed: boolean, partIndex?: number): IRWire | undefined => {
    const id = sourceIds[sourceIndex] ?? createRandomOpenAIResponsesItemId(item.type === 'message' && partIndex !== undefined && item.content[partIndex].type === 'image' ? 'image_generation_call' : item.type);
    if (partIndex !== undefined && item.type === 'message') {
      const part = item.content[partIndex];
      if (part.type === 'image') return { type: 'image_generation_call', id, status: 'in_progress', result: null };
      if (part.type === 'text' || part.type === 'refusal') return { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] };
      return undefined;
    }
    if (item.type === 'message') return undefined;
    if (item.type === 'reasoning') return { type: 'reasoning', id, status: 'in_progress', summary: [], ...(item.content === undefined ? {} : { content: [] }) };
    if ((item.type === 'function_call' || item.type === 'custom_tool_call') && item.name === '') {
      if (closed) throw new TypeError('Completed tool calls require a name');
      return undefined;
    }
    if ((item.type === 'function_call' || item.type === 'custom_tool_call') && stateChatSource && !item.call_id) {
      if (closed) throw new TypeError('Completed tool calls require an id');
      return undefined;
    }
    if (item.type === 'function_call') return { type: 'function_call', id, call_id: item.call_id ?? id, name: item.name, arguments: '', status: 'in_progress' };
    return { type: 'custom_tool_call', id, call_id: item.call_id, name: item.name, input: '', status: 'in_progress' };
  };
  for await (const { state, record } of consumeIRRecords(frames)) {
    if (record.type === 'start') { metadata = irOutputMetadata(record, options); if (!metadata.id.startsWith('resp_')) metadata.id = `resp_${crypto.randomUUID().replace(/-/g, '')}`; started = true; }
    if (record.type === 'choice_end') { finishReason = record.finish_reason; choiceEnded = true; }
    if (record.type === 'item_end') completedItems.set(record.item, record.status ?? 'completed');
    if (!started && record.type !== 'error') continue;
    metadata.model = irServingModel(state, metadata.model);
    extension = { ...state.extensions?.openaiResponses };
    delete extension.item_ids;
    sourceIds = state.extensions?.openaiResponses?.item_ids as IRWire ?? {};
    stateChatSource = state.extensions?.openaiChatCompletions !== undefined;
    const tier = irServiceTier(state);
    if (tier !== undefined) extension.service_tier = tier;
    if (record.type === 'error') {
      yield emit({ type: 'error', message: record.error.message, code: record.error.code ?? record.error.type, ...(record.error.param === undefined ? {} : { param: record.error.param }) });
      return;
    }
    if (state.choices.length > 1) throw new Error('Responses cannot represent multiple choices');
    if (record.type === 'start') {
      const initialUsage = state.usage === undefined ? null : usageFromIR(state.usage, 'openaiResponses');
      yield emit({ type: 'response.created', response: response('in_progress', initialUsage) });
      yield emit({ type: 'response.in_progress', response: response('in_progress', initialUsage) });
    }
    if (record.type === 'operation' || record.type === 'item_end' || record.type === 'part_end' || record.type === 'choice_end' || record.type === 'finish') {
      let startsBlocked = false;
      for (let sourceIndex = 0; sourceIndex < (state.choices[0]?.items.length ?? 0); sourceIndex++) {
        const item = state.choices[0].items[sourceIndex];
        const source: IRPath = ['choices', 0, 'items', sourceIndex];
        const closing = completedItems.has(sourceIndex) || record.type === 'finish';
        if (item.type === 'message') for (let p = 0; p < item.content.length; p++) {
          const part = item.content[p]; if (part.type !== 'audio') continue;
          for (const field of ['data', 'transcript'] as const) if (part.audio[field] !== undefined) {
            const delta = projection.append([...source, 'content', p, 'audio', field], part.audio[field]!, ['audio', field]);
            if (delta !== '') yield emit({ type: field === 'data' ? 'response.audio.delta' : 'response.audio.transcript.delta', delta });
          }
          const key = `${sourceIndex}/${p}/audio`;
          if (closing && !ended.has(key)) {
            if (part.audio.data !== undefined) yield emit({ type: 'response.audio.done' });
            if (part.audio.transcript !== undefined) yield emit({ type: 'response.audio.transcript.done' });
            ended.add(key);
          }
        }
        const parts = item.type === 'message' ? item.content.flatMap((p, index) => p.type === 'audio' ? [] : [index]) : [undefined];
        for (const partIndex of parts) {
          const messagePart = item.type === 'message' && partIndex !== undefined && ['text', 'refusal'].includes(item.content[partIndex].type);
          const group = item.type === 'message' && partIndex !== undefined ? item.content.slice(0, partIndex).filter(p => p.type !== 'text' && p.type !== 'refusal').length : 0;
          const key = `${sourceIndex}/${messagePart ? `message/${group}` : partIndex ?? 'item'}`;
          let index = indices.get(key);
          if (index === undefined) {
            if (startsBlocked) continue;
            const native = targetItem(item, sourceIndex, closing, partIndex);
            if (native === undefined) {
              if ((item.type === 'function_call' || item.type === 'custom_tool_call') && !closing) startsBlocked = true;
              continue;
            }
            index = output.length; indices.set(key, index); output.push(native);
            yield emit({ type: 'response.output_item.added', output_index: index, item: cloneIRJSON(native) });
          }
          const native = output[index];

          const target: IRPath = ['output', index];
          const part = item.type === 'message' ? item.content[partIndex!] : undefined;
          if (part?.type === 'image') {
            native.result = part.image.data;
            // https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/resources/responses/responses.ts#L5805-L5839
            if (part.image.mime_type !== undefined) native.output_format = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' }[part.image.mime_type as 'image/png' | 'image/jpeg' | 'image/webp'];
            const targetPath = [...target, 'result'];
            projection.assign([...source, 'content', partIndex!, 'image', 'data'], part.image.data, targetPath);
            projection.markRoundTrip(targetPath);
          } else if (part?.type === 'text' || part?.type === 'refusal') {
            const original = partIndex!;
            const p = item.type === 'message' ? original - item.content.slice(0, original).findLastIndex(p => p.type !== 'text' && p.type !== 'refusal') - 1 : 0;
            const refusal = part.type === 'refusal';
            const text = refusal ? part.refusal : part.text;
            const field = refusal ? 'refusal' : 'text';
            if (native.content[p] === undefined) {
              native.content[p] = refusal ? { type: 'refusal', refusal: '' } : { type: 'output_text', text: '', annotations: [] };
              yield emit({ type: 'response.content_part.added', item_id: native.id, output_index: index, content_index: p, part: cloneIRJSON(native.content[p]) });
            }
            const path = [...source, 'content', original, field];
            const targetPath = [...target, 'content', p, field];
            const delta = projection.append(path, text, targetPath, true);
            projection.markRoundTrip(targetPath);
            native.content[p][field] = text;
            if (delta !== '') yield emit({ type: refusal ? 'response.refusal.delta' : 'response.output_text.delta', item_id: native.id, output_index: index, content_index: p, delta, ...(refusal ? {} : { logprobs: [] }) });
            if (part.type === 'text') {
              const annotations = (part.annotations ?? []).flatMap((a): IRWire[] => {
                if ((a.source_kind === 'url' || a.source_kind === 'search_result') && a.source != null) {
                  const range = irRangeToCodePoints(text, a.output_text_range ?? { start: 0, end_exclusive: text.length });
                  return [{ type: 'url_citation', url: a.source, title: a.source_label ?? a.source, start_index: range.start, end_index: range.end }];
                }
                if (a.source_kind === 'document' && a.source !== undefined && a.source !== null) return [{ type: 'file_citation', file_id: a.source, filename: a.source_label ?? a.source, index: 0 }];
                return [];
              });
              const oldCount = native.content[p].annotations.length;
              native.content[p].annotations = annotations;
              for (let a = oldCount; !ended.has(key) && a < annotations.length; a++) yield emit({ type: 'response.output_text.annotation.added', item_id: native.id, output_index: index, content_index: p, annotation_index: a, annotation: annotations[a] });
              const group = state.choices[0].logprobs?.find(g => g.scope === 'text_part' && g.item_index === sourceIndex && g.content_index === original);
              if (group !== undefined) native.content[p].logprobs = cloneIRJSON(group.tokens);
            }
          } else if (item.type === 'reasoning') {
            for (const field of ['summary', 'content'] as const) for (let p = 0; p < (item[field]?.length ?? 0); p++) {
              native[field] ??= [];
              if (native[field][p] === undefined) {
                native[field][p] = { type: field === 'summary' ? 'summary_text' : 'reasoning_text', text: '' };
                yield emit({ type: field === 'summary' ? 'response.reasoning_summary_part.added' : 'response.content_part.added', item_id: native.id, output_index: index, ...(field === 'summary' ? { summary_index: p } : { content_index: p }), part: cloneIRJSON(native[field][p]) });
              }
              const text = item[field]![p];
              const targetPath = [...target, field, p, 'text'];
              const delta = projection.append([...source, field, p], text, targetPath, true);
              projection.markRoundTrip(targetPath);
              native[field][p].text = text;
              if (delta !== '') yield emit({ type: field === 'summary' ? 'response.reasoning_summary_text.delta' : 'response.reasoning_text.delta', item_id: native.id, output_index: index, ...(field === 'summary' ? { summary_index: p } : { content_index: p }), delta });
            }
            if (item.encrypted_content !== undefined && options.roundTrip === undefined) {
              native.encrypted_content = item.encrypted_content;
              if (item.encrypted_content !== null) projection.assign([...source, 'encrypted_content'], item.encrypted_content, [...target, 'encrypted_content']);
            }
          } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
            const custom = item.type === 'custom_tool_call';
            const field = custom ? 'input' : 'arguments';
            const value = custom ? item.input : typeof item.arguments === 'object' ? closing ? JSON.stringify(item.arguments) : native[field] : item.arguments ?? '';
            const targetPath = [...target, field];
            const delta = projection.append([...source, field], value, targetPath, true);
            projection.markRoundTrip(targetPath);
            native[field] = value; native.name = item.name;
            if (item.call_id !== undefined) native.call_id = item.call_id;
            if (delta !== '') yield emit({ type: custom ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', item_id: native.id, output_index: index, delta });
          }
          const closingPart = record.type === 'part_end' && record.item === sourceIndex && record.part === partIndex;
          if (native.type === 'message' && (closing || closingPart)) {
            const endingPart = item.type === 'message' && partIndex !== undefined ? partIndex - item.content.slice(0, partIndex).findLastIndex(p => p.type !== 'text' && p.type !== 'refusal') - 1 : undefined;
            for (let p = 0; p < native.content.length; p++) {
              const partKey = `${index}/${p}`;
              if (closedParts.has(partKey) || !closing && p !== endingPart) continue;
              const part = native.content[p];
              yield emit({ type: part.type === 'refusal' ? 'response.refusal.done' : 'response.output_text.done', item_id: native.id, output_index: index, content_index: p, ...(part.type === 'refusal' ? { refusal: part.refusal } : { text: part.text, logprobs: part.logprobs ?? [] }) });
              yield emit({ type: 'response.content_part.done', item_id: native.id, output_index: index, content_index: p, part: cloneIRJSON(part) });
              closedParts.add(partKey);
            }
          }
          const pendingArguments = closing && !ended.has(key) && item.type === 'function_call' && typeof item.arguments === 'string' && !isCompleteIRJSONObject(item.arguments);
          if (closing && !ended.has(key) && (!pendingArguments || choiceEnded || record.type === 'finish')) {
            if (item.type === 'reasoning') for (const field of ['summary', 'content'] as const) for (let p = 0; p < (native[field]?.length ?? 0); p++) {
              yield emit({ type: field === 'summary' ? 'response.reasoning_summary_text.done' : 'response.reasoning_text.done', item_id: native.id, output_index: index, ...(field === 'summary' ? { summary_index: p } : { content_index: p }), text: native[field][p].text });
              yield emit({ type: field === 'summary' ? 'response.reasoning_summary_part.done' : 'response.content_part.done', item_id: native.id, output_index: index, ...(field === 'summary' ? { summary_index: p } : { content_index: p }), part: cloneIRJSON(native[field][p]) });
            }
            if (item.type === 'function_call' || item.type === 'custom_tool_call') {
              const custom = item.type === 'custom_tool_call'; const field = custom ? 'input' : 'arguments';
              yield emit({ type: custom ? 'response.custom_tool_call_input.done' : 'response.function_call_arguments.done', item_id: native.id, output_index: index, [field]: native[field], name: native.name });
            }
            native.status = completedItems.get(sourceIndex) === 'incomplete' || pendingArguments && finishReason === 'length' ? 'incomplete' : 'completed';
            yield emit({ type: 'response.output_item.done', output_index: index, item: cloneIRJSON(native) }); ended.add(key);
          }
        }
      }
    }
    if (record.type === 'finish') {
      const refusal = state.choices[0]?.refusal;
      if (refusal?.category === 'cyber' || refusal?.category === 'bio') {
        // Codex replaces absent/blank biology explanations with an OpenAI enrollment notice.
        // https://github.com/openai/codex/blob/de8fab6d7adfcef8b4ce6f02f3b5c8be4092015a/codex-rs/codex-api/src/sse/responses_error.rs#L59
        const message = refusal.explanation == null || refusal.explanation.trim() === '' ? `The upstream declined this request under the ${refusal.category} policy category.` : refusal.explanation;
        yield emit({ type: 'response.failed', response: { ...response('failed', state.usage === undefined ? null : usageFromIR(state.usage, 'openaiResponses')), error: { code: `${refusal.category}_policy`, message } } });
        return;
      }
      if (record.status === 'failed') {
        yield emit({ type: 'response.failed', response: { ...response('failed', state.usage === undefined ? null : usageFromIR(state.usage, 'openaiResponses')), error: record.error } });
        return;
      }

      if (refusal?.explanation != null) {
        const item = { type: 'message' as const, id: createRandomOpenAIResponsesItemId('message'), role: 'assistant' as const, status: 'completed' as const, content: [{ type: 'refusal' as const, refusal: refusal.explanation }] };
        const index = output.length;
        const targetPath: IRPath = ['output', index, 'content', 0, 'refusal'];
        projection.assign(['choices', 0, 'refusal', 'explanation'], refusal.explanation, targetPath);
        projection.markRoundTrip(targetPath);
        for (const frame of openaiResponsesResultToEvents({ id: metadata.id, object: 'response', model: metadata.model, status: 'completed', output: [item], error: null, incomplete_details: null })) {
          if (frame.type === 'event' && 'output_index' in frame.event) yield emit({ ...frame.event, output_index: index });
        }
        output.push(item);
      }
      if (options.roundTrip !== undefined) {
        const namespaceToolNames = options.namespaceToolNames;
        const nativeOutput = namespaceToolNames === undefined
          ? output
          : output.map(item => restoreNamespaceOutputItem(item as unknown as OpenAIResponsesOutputItemEx, namespaceToolNames, 'completed'));
        const carrierId = createRandomOpenAIResponsesItemId('reasoning');
        const plannedCarrier = { ...createOpenAIResponsesSidecarCarrier(carrierId, ''), status: 'completed' as const };
        const plannedTurn = [...nativeOutput, plannedCarrier] as unknown as OpenAIResponsesAssistantTurn;
        const replayCheck = await createOpenAIResponsesReplayCheck(plannedTurn);
        const data = await options.roundTrip.prepareSidecar(0, replayCheck!, projection.roundTripResult());
        const carrier = { ...plannedCarrier, encrypted_content: data };
        const index = output.length;
        output.push(carrier);
        for (const frame of openaiResponsesResultToEvents({ id: metadata.id, object: 'response', model: metadata.model, status: 'completed', output: [carrier], error: null, incomplete_details: null })) {
          if (frame.type === 'event' && 'output_index' in frame.event) yield emit({ ...frame.event, output_index: index });
        }
      }
      const status = record.status === 'completed' && finishReason === 'content_filter' ? 'incomplete' : record.status;
      yield emit({ type: `response.${status}`, response: { ...response(status, state.usage === undefined ? null : usageFromIR(state.usage, 'openaiResponses')), error: record.error ?? null } });

    }
  }
};
