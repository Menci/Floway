
import { irRangeToCodePoints } from './coordinates.ts';
import type { IRItem } from './ir.ts';
import { cloneIRJSON } from './json.ts';
import { consumeIRRecords, createIRProjection, type IROutputOptions } from './projection.ts';
import type { IRFrame, IRPath } from './stream.ts';
import { usageFromIR, type IRWire } from './usage.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const openaiResponsesFromIR = async function* (frames: AsyncIterable<IRFrame>, options: IROutputOptions): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  const projection = createIRProjection();
  const output: IRWire[] = [];
  const indices = new Map<string, number>();
  const ended = new Set<string>();
  const partCounts = new Map<number, number>();
  let sequence = 0;
  let extension: IRWire = {};
  const emit = (event: IRWire): ProtocolFrame<OpenAIResponsesStreamEventEx> => eventFrame({ ...event, sequence_number: sequence++ } as OpenAIResponsesStreamEventEx);
  const response = (status: string, usage: unknown = null): IRWire => ({ ...extension, id: options.id, object: 'response', created_at: options.created, model: options.model, status, output: cloneIRJSON(output), usage, error: null, incomplete_details: status === 'incomplete' ? extension.incomplete_details ?? { reason: 'max_output_tokens' } : null });
  const targetItem = (item: IRItem, sourceIndex: number, partIndex?: number): IRWire | undefined => {
    const id = `${options.id}_${sourceIndex}${partIndex === undefined ? '' : `_${partIndex}`}`;
    if (partIndex !== undefined && item.type === 'message') {
      const part = item.content[partIndex];
      if (part.type === 'image') return { type: 'image_generation_call', id, status: 'in_progress', result: null };
      if (part.type === 'text' || part.type === 'refusal') return { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] };
      return undefined;
    }
    if (item.type === 'message') return undefined;
    if (item.type === 'reasoning') return { type: 'reasoning', id, status: 'in_progress', summary: [], ...(item.content === undefined ? {} : { content: [] }) };
    if ((item.type === 'function_call' || item.type === 'custom_tool_call') && item.name === '') return undefined;
    if (item.type === 'function_call') return { type: 'function_call', id, call_id: item.call_id ?? id, name: item.name, arguments: '', status: 'in_progress' };
    return { type: 'custom_tool_call', id, call_id: item.call_id, name: item.name, input: '', status: 'in_progress' };
  };
  for await (const { state, record } of consumeIRRecords(frames)) {
    extension = state.extensions?.openaiResponses ?? {};
    if (state.choices.length > 1) throw new Error('Responses cannot represent multiple choices');
    if (record.type === 'start') {
      yield emit({ type: 'response.created', response: response('in_progress') });
      yield emit({ type: 'response.in_progress', response: response('in_progress') });
    }
    if (record.type === 'operation' || record.type === 'item_end' || record.type === 'part_end' || record.type === 'finish') {
      for (let sourceIndex = 0; sourceIndex < (state.choices[0]?.items.length ?? 0); sourceIndex++) {
        const item = state.choices[0].items[sourceIndex];
        const source: IRPath = ['choices', 0, 'items', sourceIndex];
        if (item.type === 'message') for (let p = 0; p < item.content.length; p++) {
          const part = item.content[p]; if (part.type !== 'audio') continue;
          for (const field of ['data', 'transcript'] as const) if (part.audio[field] !== undefined) {
            const delta = projection.append([...source, 'content', p, 'audio', field], part.audio[field]!, ['audio', field], false);
            if (delta !== '') yield emit({ type: field === 'data' ? 'response.audio.delta' : 'response.audio.transcript.delta', delta });
          }
          const closing = record.type === 'finish' || record.type === 'item_end' && record.item === sourceIndex;
          const key = `${sourceIndex}/${p}/audio`;
          if (closing && !ended.has(key)) {
            if (part.audio.data !== undefined) yield emit({ type: 'response.audio.done' });
            if (part.audio.transcript !== undefined) yield emit({ type: 'response.audio.transcript.done' });
            ended.add(key);
          }
        }
        const parts = item.type === 'message' ? item.content.flatMap((p, index) => p.type === 'audio' ? [] : [index]) : [undefined];
        for (const partIndex of parts) {
          const key = `${sourceIndex}/${partIndex ?? 'item'}`;
          let index = indices.get(key);
          if (index === undefined) {
            const native = targetItem(item, sourceIndex, partIndex);
            if (native === undefined) continue;
            index = output.length; indices.set(key, index); output.push(native);
            yield emit({ type: 'response.output_item.added', output_index: index, item: cloneIRJSON(native) });
          }
          const native = output[index];
          const target: IRPath = ['output', index];
          const part = item.type === 'message' ? item.content[partIndex!] : undefined;
          if (part?.type === 'image') {
            native.result = part.image.data;
            projection.assign([...source, 'content', partIndex!, 'image', 'data'], part.image.data, [...target, 'result'], true);
          } else if (part?.type === 'text' || part?.type === 'refusal') {
            const original = partIndex!;
            const p = 0;
            const refusal = part.type === 'refusal';
            const text = refusal ? part.refusal : part.text;
            const field = refusal ? 'refusal' : 'text';
            if (native.content[p] === undefined) {
              native.content[p] = refusal ? { type: 'refusal', refusal: '' } : { type: 'output_text', text: '', annotations: [] };
              yield emit({ type: 'response.content_part.added', item_id: native.id, output_index: index, content_index: p, part: cloneIRJSON(native.content[p]) });
            }
            const path = [...source, 'content', original, field];
            const delta = projection.append(path, text, [...target, 'content', p, field], true, true);
            native.content[p][field] = text;
            if (delta !== '') yield emit({ type: refusal ? 'response.refusal.delta' : 'response.output_text.delta', item_id: native.id, output_index: index, content_index: p, delta, ...(refusal ? {} : { logprobs: [] }) });
            if (part.type === 'text') {
              const annotations = (part.annotations ?? []).flatMap((a): IRWire[] => {
                if (a.source_kind === 'url' && a.output_text_range !== undefined) {
                  const range = irRangeToCodePoints(text, a.output_text_range);
                  return [{ type: 'url_citation', url: a.source, title: a.source_label ?? a.source, start_index: range.start, end_index: range.end }];
                }
                if (a.source_kind === 'document' && a.source !== undefined && a.source !== null) return [{ type: 'file_citation', file_id: a.source, filename: a.source_label ?? a.source, index: 0 }];
                return [];
              });
              const oldCount = native.content[p].annotations.length;
              native.content[p].annotations = annotations;
              for (let a = oldCount; a < annotations.length; a++) yield emit({ type: 'response.output_text.annotation.added', item_id: native.id, output_index: index, content_index: p, annotation_index: a, annotation: annotations[a] });
              const group = state.choices[0].logprobs?.find(g => g.scope === 'text_part' && g.item_index === sourceIndex && g.content_index === original);
              if (group !== undefined) native.content[p].logprobs = cloneIRJSON(group.tokens);
            }
          } else if (item.type === 'reasoning') {
            for (const field of ['summary', 'content'] as const) for (let p = 0; p < (item[field]?.length ?? 0); p++) {
              native[field] ??= [];
              if (native[field][p] === undefined) {
                native[field][p] = { type: field === 'summary' ? 'summary_text' : 'reasoning_text', text: '' };
                if (field === 'summary') yield emit({ type: 'response.reasoning_summary_part.added', item_id: native.id, output_index: index, summary_index: p, part: cloneIRJSON(native[field][p]) });
              }
              const text = item[field]![p];
              const delta = projection.append([...source, field, p], text, [...target, field, p, 'text'], true, true);
              native[field][p].text = text;
              if (delta !== '') yield emit({ type: field === 'summary' ? 'response.reasoning_summary_text.delta' : 'response.reasoning_text.delta', item_id: native.id, output_index: index, ...(field === 'summary' ? { summary_index: p } : { content_index: p }), delta });
            }
            if (item.encrypted_content !== undefined) {
              native.encrypted_content = item.encrypted_content;
              if (item.encrypted_content !== null) projection.assign([...source, 'encrypted_content'], item.encrypted_content, [...target, 'encrypted_content'], true);
            }
          } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
            const custom = item.type === 'custom_tool_call';
            const field = custom ? 'input' : 'arguments';
            const closed = record.type === 'finish' || record.type === 'item_end' && record.item === sourceIndex;
            const value = custom ? item.input : typeof item.arguments === 'object' ? closed ? JSON.stringify(item.arguments) : native[field] : item.arguments ?? '';
            const delta = projection.append([...source, field], value, [...target, field], true, true);
            native[field] = value; native.name = item.name;
            if (item.call_id !== undefined) native.call_id = item.call_id;
            if (delta !== '') yield emit({ type: custom ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', item_id: native.id, output_index: index, delta });
          }
          const closing = record.type === 'finish' || record.type === 'item_end' && record.item === sourceIndex;
          const closingPart = record.type === 'part_end' && record.item === sourceIndex && record.part === partIndex;
          if (native.type === 'message' && (closing || closingPart)) {
            const old = partCounts.get(index) ?? 0;
            const end = native.content.length;
            for (let p = old; p < end; p++) {
              const part = native.content[p];
              yield emit({ type: part.type === 'refusal' ? 'response.refusal.done' : 'response.output_text.done', item_id: native.id, output_index: index, content_index: p, ...(part.type === 'refusal' ? { refusal: part.refusal } : { text: part.text, logprobs: part.logprobs ?? [] }) });
              yield emit({ type: 'response.content_part.done', item_id: native.id, output_index: index, content_index: p, part: cloneIRJSON(part) });
            }
            partCounts.set(index, end);
          }
          if (closing && !ended.has(key)) {
            if (item.type === 'reasoning') for (const field of ['summary', 'content'] as const) for (let p = 0; p < (native[field]?.length ?? 0); p++) {
              yield emit({ type: field === 'summary' ? 'response.reasoning_summary_text.done' : 'response.reasoning_text.done', item_id: native.id, output_index: index, ...(field === 'summary' ? { summary_index: p } : { content_index: p }), text: native[field][p].text });
              if (field === 'summary') yield emit({ type: 'response.reasoning_summary_part.done', item_id: native.id, output_index: index, summary_index: p, part: cloneIRJSON(native[field][p]) });
            }
            if (item.type === 'function_call' || item.type === 'custom_tool_call') {
              const custom = item.type === 'custom_tool_call'; const field = custom ? 'input' : 'arguments';
              yield emit({ type: custom ? 'response.custom_tool_call_input.done' : 'response.function_call_arguments.done', item_id: native.id, output_index: index, [field]: native[field], name: native.name });
            }
            native.status = 'completed';
            yield emit({ type: 'response.output_item.done', output_index: index, item: cloneIRJSON(native) }); ended.add(key);
          }
        }
      }
    }
    if (record.type === 'finish') {
      await options.onProjection?.(projection.result());
      yield emit({ type: `response.${record.status}`, response: { ...response(record.status, state.usage === undefined ? null : usageFromIR(state.usage, 'openaiResponses')), error: record.error ?? null } });
      yield doneFrame();
    }
  }
};
