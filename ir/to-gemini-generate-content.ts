
import { irRangeToUTF8 } from './coordinates.ts';
import type { IRSourceCitation } from './ir.ts';
import { consumeIRRecords, createIRProjection, type IROutputOptions } from './projection.ts';
import type { IRFrame, IRPath } from './stream.ts';
import { usageFromIR, type IRWire } from './usage.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

export interface IRGenerateContentOutputOptions extends IROutputOptions { imageMimeType?: string; audioMimeType?: string }

export const geminiGenerateContentFromIR = async function* (frames: AsyncIterable<IRFrame>, options: IRGenerateContentOutputOptions): AsyncGenerator<ProtocolFrame<GeminiGenerateContentStreamEvent>> {
  const projection = createIRProjection();
  const parts = new Map<number, IRWire[]>();
  const lastKind = new Map<number, string>();
  const emitted = new Set<string>();
  const terminalCandidates: IRWire[] = [];
  let extension: IRWire = {};
  const emit = (event: IRWire): ProtocolFrame<GeminiGenerateContentStreamEvent> => eventFrame({ ...extension, responseId: options.id, modelVersion: options.model, ...event } as GeminiGenerateContentStreamEvent);
  const emitPart = (choice: number, part: IRWire): ProtocolFrame<GeminiGenerateContentStreamEvent> => emit({ candidates: [{ index: choice, content: { role: 'model', parts: [part] } }] });
  for await (const { state, record } of consumeIRRecords(frames)) {
    extension = state.extensions?.geminiGenerateContent ?? {};
    if (record.type === 'finish' && record.status === 'failed') throw new Error('IR generation failed', { cause: record.error });
    if (record.type === 'operation' || record.type === 'item_end' || record.type === 'finish') {
      for (let choice = 0; choice < state.choices.length; choice++) {
        let native = parts.get(choice);
        if (native === undefined) { native = []; parts.set(choice, native); }
        for (let index = 0; index < state.choices[choice].items.length; index++) {
          const item = state.choices[choice].items[index];
          const source: IRPath = ['choices', choice, 'items', index];
          const closed = record.type === 'finish' || record.type === 'item_end' && record.item === index && record.choice === choice;
          const textDelta = (path: IRPath, value: string, thought: boolean): IRWire | undefined => {
            const kind = thought ? 'thought' : 'text';
            const merge = !thought && lastKind.get(choice) === kind;
            const position = merge ? native!.length - 1 : native!.length;
            const delta = projection.append(path, value, ['candidates', choice, 'content', 'parts', position, 'text'], !thought);
            if (delta === '') return undefined;
            if (merge) native![position].text += delta;
            else native!.push({ text: delta, ...(thought ? { thought: true } : {}) });
            lastKind.set(choice, kind);
            return { text: delta, ...(thought ? { thought: true } : {}) };
          };
          if (item.type === 'message') for (let p = 0; p < item.content.length; p++) {
            const part = item.content[p]; const path = [...source, 'content', p];
            if (part.type === 'text' || part.type === 'refusal') {
              const delta = textDelta([...path, part.type === 'text' ? 'text' : 'refusal'], part.type === 'text' ? part.text : part.refusal, false);
              if (delta !== undefined) yield emitPart(choice, delta);
            } else if (closed) {
              const key = JSON.stringify(path);
              if (emitted.has(key)) continue;
              if (part.type === 'image' || part.type === 'audio' && part.audio.data !== undefined) {
                const media = part.type === 'image' ? part.image : part.audio;
                const mime = media.mime_type ?? (part.type === 'image' ? options.imageMimeType : options.audioMimeType);
                if (mime === undefined) throw new TypeError('GenerateContent inline data requires a MIME type');
                const value: IRWire = { inlineData: { mimeType: mime, data: media.data } };
                const target = ['candidates', choice, 'content', 'parts', native.length, 'inlineData', 'data'];
                projection.assign([...path, part.type === 'image' ? 'image' : 'audio', 'data'], media.data!, target, true);
                if (part.type === 'audio' && part.audio.transcript !== undefined) {
                  value.audioTranscription = { text: part.audio.transcript };
                  projection.assign([...path, 'audio', 'transcript'], part.audio.transcript, ['candidates', choice, 'content', 'parts', native.length, 'audioTranscription', 'text'], false);
                }
                native.push(value); lastKind.set(choice, 'media'); yield emitPart(choice, value);
              } else if (part.type === 'audio' && part.audio.transcript !== undefined) {
                const delta = textDelta([...path, 'audio', 'transcript'], part.audio.transcript, false);
                if (delta !== undefined) yield emitPart(choice, delta);
              }
              emitted.add(key);
            }
          } else if (item.type === 'reasoning') {
            for (const field of ['summary', 'content'] as const) for (let p = 0; p < (item[field]?.length ?? 0); p++) {
              const delta = textDelta([...source, field, p], item[field]![p], true);
              if (delta !== undefined) yield emitPart(choice, delta);
            }
            const key = `${choice}/${index}/signature`;
            if (closed && item.encrypted_content != null && !emitted.has(key)) {
              const value = { thoughtSignature: item.encrypted_content };
              projection.assign([...source, 'encrypted_content'], item.encrypted_content, ['candidates', choice, 'content', 'parts', native.length, 'thoughtSignature'], true);
              native.push(value); lastKind.set(choice, 'signature'); emitted.add(key); yield emitPart(choice, value);
            }
          } else if (item.type === 'function_call' && closed) {
            const key = JSON.stringify(source);
            if (emitted.has(key)) continue;
            const args: unknown = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments;
            if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) throw new TypeError('GenerateContent function args must be a JSON object');
            const value = { functionCall: { name: item.name, ...(item.call_id === undefined ? {} : { id: item.call_id }), ...(args === undefined ? {} : { args }) } };
            if (args !== undefined) projection.assign([...source, 'arguments'], JSON.stringify(args), ['candidates', choice, 'content', 'parts', native.length, 'functionCall', 'args'], true);
            native.push(value); lastKind.set(choice, 'function'); emitted.add(key); yield emitPart(choice, value);
          }
        }
      }
    }
    if (record.type === 'choice_end') {
      const native = parts.get(record.choice) ?? [];
      const final = projection.result();
      const chunks: IRWire[] = []; const supports: IRWire[] = [];
      state.choices[record.choice].items.forEach((item, index) => {
        if (item.type !== 'message') return;
        item.content.forEach((part, p) => {
          if (part.type !== 'text') return;
          const maps = final.projections.filter(m => JSON.stringify(m.source_path) === JSON.stringify(['choices', record.choice, 'items', index, 'content', p, 'text']));
          for (const annotation of part.annotations ?? []) {
            const chunk = groundingChunk(annotation); if (chunk === undefined) continue;
            const chunkIndex = chunks.length; chunks.push(chunk);
            if (annotation.output_text_range === undefined) continue;
            for (const map of maps) {
              const start = Math.max(map.source_start, annotation.output_text_range.start); const end = Math.min(map.source_end_exclusive, annotation.output_text_range.end_exclusive);
              if (end <= start) continue;
              const position = map.target_path[4] as number; const text = native[position].text as string;
              const range = { start: map.target_start + start - map.source_start, end_exclusive: map.target_start + end - map.source_start };
              const bytes = irRangeToUTF8(text, range);
              supports.push({ groundingChunkIndices: [chunkIndex], segment: { partIndex: position, startIndex: bytes.start, endIndex: bytes.end, text: text.slice(range.start, range.end_exclusive) } });
            }
          }
        });
      });
      const tokens = state.choices[record.choice].logprobs?.flatMap(group => group.tokens);
      terminalCandidates.push({ index: record.choice, finishReason: record.finish_reason === 'length' ? 'MAX_TOKENS' : record.finish_reason === 'content_filter' ? 'SAFETY' : 'STOP', ...(chunks.length === 0 ? {} : { groundingMetadata: { groundingChunks: chunks, groundingSupports: supports } }), ...(tokens === undefined ? {} : { logprobsResult: { chosenCandidates: tokens.map(t => ({ token: t.token, logProbability: t.logprob })), topCandidates: tokens.map(t => ({ candidates: (t.top_logprobs ?? []).map(a => ({ token: a.token, logProbability: a.logprob })) })) } }) });
    }
    if (record.type === 'finish') {
      yield emit({ candidates: terminalCandidates, ...(state.usage === undefined ? {} : { usageMetadata: usageFromIR(state.usage, 'geminiGenerateContent') }) });
      options.onProjection?.(projection.result());
    }
  }
};

const groundingChunk = (citation: IRSourceCitation): IRWire | undefined => {
  if (citation.source_kind === 'url') return { web: { uri: citation.source, title: citation.source_label } };
  return { retrievedContext: { ...(citation.source == null ? {} : { uri: citation.source }), ...(citation.source_label == null ? {} : { title: citation.source_label }), ...(citation.source_text === undefined ? {} : { text: citation.source_text.text }), ...(citation.source_page_range === undefined ? {} : { pageNumber: citation.source_page_range.start_one_based }) } };
};
