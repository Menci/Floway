import { isContextExceededError } from '../../../anthropic-messages-via/context-window-error.ts';
import type { IRItem, IRJSONObject, IRSourceCitation } from '../../ir.ts';
import { createGeminiGenerateContentReplayCheck, createGeminiGenerateContentSidecarCarrier, type GeminiGenerateContentAssistantTurn } from '../../round-trip/gemini-generate-content.ts';
import { irRangeToUTF8 } from '../../shared/coordinates.ts';
import { isCompleteIRJSONObject, parseIRJSONObject } from '../../shared/json.ts';
import { irOutputMetadata, irServingModel } from '../../shared/metadata.ts';
import { createIRProjection, type IROutputOptions } from '../../shared/projection.ts';
import { createIRTextStream, type IRTextUpdate } from '../../shared/text.ts';
import { usageFromIR, irServiceTier, type IRWire } from '../../shared/usage.ts';
import { consumeIRRecords, type IRFrame, type IRPath } from '../../stream.ts';
import { eventFrame, FAST_SERVICE_TIER, type EventFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

// A failed Responses event has no HTTP status; these are target classifications.
// https://developers.openai.com/api/reference/resources/responses/streaming-events
// https://ai.google.dev/gemini-api/docs/troubleshooting
const irGenerateContentError = (error: IRJSONObject): IRJSONObject => {
  const code = error.code ?? error.type;
  const [status, statusCode] = code === 'rate_limit_exceeded' || code === 'rate_limit_error' ? ['RESOURCE_EXHAUSTED', 429]
    : code === 'invalid_prompt' || code === 'invalid_request_error' || isContextExceededError(error) ? ['INVALID_ARGUMENT', 400]
      : code === 'overloaded_error' ? ['UNAVAILABLE', 503] : ['INTERNAL', 500];
  return { code: statusCode, status, message: error.message };
};

export interface IRGenerateContentOutputOptions extends IROutputOptions { imageMimeType?: string; audioMimeType?: string }

const streamsText = (item: IRItem): boolean => item.type === 'reasoning' || item.type === 'message' && item.content.every(part => part.type === 'text' || part.type === 'refusal');

export const geminiGenerateContentFromIR = async function* (frames: AsyncIterable<IRFrame>, options: IRGenerateContentOutputOptions = {}): AsyncGenerator<EventFrame<GeminiGenerateContentStreamEvent>> {
  let metadata = { id: '', model: '', created: 0 };
  let started = false;
  const projection = createIRProjection();
  const textStream = createIRTextStream();
  const itemStatuses = new Map<string, 'completed' | 'incomplete' | undefined>();
  const completedItems = new Set<string>();
  const parts = new Map<number, IRWire[]>();
  const lastKind = new Map<number, string>();
  const emitted = new Set<string>();
  const terminalCandidates: IRWire[] = [];
  let extension: IRWire = {};
  const emit = (event: IRWire): EventFrame<GeminiGenerateContentStreamEvent> => eventFrame({ ...extension, responseId: metadata.id, modelVersion: metadata.model, ...event } as GeminiGenerateContentStreamEvent);
  const emitPart = (choice: number, part: IRWire): EventFrame<GeminiGenerateContentStreamEvent> => emit({ candidates: [{ index: choice, content: { role: 'model', parts: [part] } }] });
  for await (const { state, record } of consumeIRRecords(frames)) {
    if (record.type === 'operation' && record.operation === 'assign') projection.validateText(state, record.path);
    textStream.update(state);
    if (record.type === 'start') { metadata = irOutputMetadata(record, options); started = true; }
    if (!started && record.type !== 'error') continue;
    metadata.model = irServingModel(state, metadata.model);
    if (record.type === 'item_end') { completedItems.add(`${record.choice}/${record.item}`); itemStatuses.set(`${record.choice}/${record.item}`, record.status); }
    extension = state.extensions?.geminiGenerateContent ?? {};
    if (record.type === 'error' || record.type === 'finish' && record.status === 'failed') {
      if (record.error === undefined) throw new TypeError('Failed IR generation requires an error');
      yield eventFrame({ error: irGenerateContentError(record.error) } as GeminiGenerateContentStreamEvent);
      return;
    }
    if (record.type === 'operation' || record.type === 'item_end' || record.type === 'choice_end' || record.type === 'finish') {
      for (let choice = 0; choice < state.choices.length; choice++) {
        let native = parts.get(choice);
        if (native === undefined) { native = []; parts.set(choice, native); }
        let textRunEnd = 0;
        for (let index = 0; index < state.choices[choice].items.length; index++) {
          const item = state.choices[choice].items[index];
          const source: IRPath = ['choices', choice, 'items', index];
          const closed = completedItems.has(`${choice}/${index}`) || record.type === 'choice_end' && record.choice === choice || record.type === 'finish' || record.type === 'item_end' && record.item === index && record.choice === choice;
          const textDelta = (update: IRTextUpdate, thought: boolean): IRWire | undefined => {
            const kind = thought ? 'thought' : 'text';
            const merge = !thought && lastKind.get(choice) === kind;
            const position = merge ? native!.length - 1 : native!.length;
            const targetPath = ['candidates', choice, 'content', 'parts', position, 'text'];
            const delta = projection.appendText(update, targetPath);
            projection.markRoundTrip(targetPath);
            if (delta === '') return undefined;
            if (merge) native![position].text += delta;
            else native!.push({ text: delta, ...(thought ? { thought: true } : {}) });
            lastKind.set(choice, kind);
            return { text: delta, ...(thought ? { thought: true } : {}) };
          };
          if (streamsText(item) && index >= textRunEnd) {
            textRunEnd = index + 1;
            while (textRunEnd < state.choices[choice].items.length && streamsText(state.choices[choice].items[textRunEnd])) textRunEnd++;
            for (const update of textStream.takeMatching(update => update.path[0] === 'choices' && update.path[1] === choice && (update.path[3] as number) >= index && (update.path[3] as number) < textRunEnd)) {
              const delta = textDelta(update, state.choices[choice].items[update.path[3] as number].type === 'reasoning');
              if (delta !== undefined) yield emitPart(choice, delta);
            }
          }
          if (item.type === 'message' && !streamsText(item)) for (let p = 0; p < item.content.length; p++) {
            const part = item.content[p]; const path = [...source, 'content', p];
            if (part.type === 'text' || part.type === 'refusal') {
              for (const update of textStream.take([...path, part.type === 'text' ? 'text' : 'refusal'])) {
                const delta = textDelta(update, false);
                if (delta !== undefined) yield emitPart(choice, delta);
              }
            } else if (closed) {
              const key = JSON.stringify(path);
              if (emitted.has(key)) continue;
              if (part.type === 'image' || part.type === 'audio' && part.audio.data !== undefined) {
                const media = part.type === 'image' ? part.image : part.audio;
                const mime = media.mime_type ?? (part.type === 'image' ? options.imageMimeType : options.audioMimeType);
                if (mime === undefined) throw new TypeError('GenerateContent inline data requires a MIME type');
                const value: IRWire = { inlineData: { mimeType: mime, data: media.data } };
                const target = ['candidates', choice, 'content', 'parts', native.length, 'inlineData', 'data'];
                projection.assign([...path, part.type === 'image' ? 'image' : 'audio', 'data'], media.data!, target);
                projection.markRoundTrip(target);
                if (part.type === 'audio' && part.audio.transcript !== undefined) {
                  value.audioTranscription = { text: part.audio.transcript };
                  const targetPath = ['candidates', choice, 'content', 'parts', native.length, 'audioTranscription', 'text'];
                  projection.assign([...path, 'audio', 'transcript'], part.audio.transcript, targetPath);
                  projection.markRoundTrip(targetPath);
                }
                native.push(value); lastKind.set(choice, 'media'); yield emitPart(choice, value);
              } else if (part.type === 'audio' && part.audio.transcript !== undefined) {
                for (const update of textStream.take([...path, 'audio', 'transcript'])) {
                  const delta = textDelta(update, false);
                  if (delta !== undefined) yield emitPart(choice, delta);
                }
              }
              emitted.add(key);
            }
          } else if (item.type === 'reasoning') {
            const key = `${choice}/${index}/signature`;
            if (options.roundTrip === undefined && closed && item.encrypted_content != null && !emitted.has(key)) {
              const value = { thoughtSignature: item.encrypted_content };
              projection.assign([...source, 'encrypted_content'], item.encrypted_content, ['candidates', choice, 'content', 'parts', native.length, 'thoughtSignature']);
              native.push(value); lastKind.set(choice, 'signature'); emitted.add(key); yield emitPart(choice, value);
            }
          } else if (item.type === 'function_call' && closed) {
            const key = JSON.stringify(source);
            if (emitted.has(key)) continue;
            const status = itemStatuses.get(`${choice}/${index}`);
            if (status === 'incomplete' || typeof item.arguments === 'string' && options.parseToolArguments === undefined && !isCompleteIRJSONObject(item.arguments)) {
              if (status === 'incomplete' || record.type === 'choice_end' && record.finish_reason === 'length') { emitted.add(key); continue; }
              if (status === undefined && record.type !== 'choice_end' && record.type !== 'finish') break;
            }
            const args: unknown = typeof item.arguments === 'string' ? parseIRJSONObject(item.arguments, options.parseToolArguments) : item.arguments;
            const value = { functionCall: { name: item.name, ...(item.call_id === undefined ? {} : { id: item.call_id }), ...(args === undefined ? {} : { args }) } };
            if (args !== undefined) {
              const targetPath = ['candidates', choice, 'content', 'parts', native.length, 'functionCall', 'args'];
              projection.assign([...source, 'arguments'], JSON.stringify(args), targetPath);
              projection.markRoundTrip(targetPath);
            }
            native.push(value); lastKind.set(choice, 'function'); emitted.add(key); yield emitPart(choice, value);
          }
          if (!closed && !streamsText(item)) break;
        }
      }
    }
    if (record.type === 'choice_end') {
      const native = parts.get(record.choice)!;
      const final = projection.result();
      const chunks: IRWire[] = []; const supports: IRWire[] = [];
      state.choices[record.choice].items.forEach((item, index) => {
        if (item.type !== 'message') return;
        item.content.forEach((part, p) => {
          if (part.type !== 'text') return;
          const maps = final.projections.filter(m => JSON.stringify(m.source_path) === JSON.stringify(['choices', record.choice, 'items', index, 'content', p, 'text']));
          for (const annotation of part.annotations ?? []) {
            const chunk = groundingChunk(annotation);
            const chunkIndex = chunks.length; chunks.push(chunk);
            const outputRange = annotation.output_text_range ?? { start: 0, end_exclusive: part.text.length };
            for (const map of maps) {
              const start = Math.max(map.source_start, outputRange.start); const end = Math.min(map.source_end_exclusive, outputRange.end_exclusive);
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
      const refusal = state.choices[record.choice].refusal;
      terminalCandidates.push({ ...(refusal?.explanation == null ? {} : { finishMessage: refusal.explanation }), index: record.choice, finishReason: record.finish_reason === 'length' ? 'MAX_TOKENS' : record.finish_reason === 'content_filter' ? 'SAFETY' : 'STOP', ...(chunks.length === 0 ? {} : { groundingMetadata: { groundingChunks: chunks, groundingSupports: supports } }), ...(tokens === undefined ? {} : { logprobsResult: { chosenCandidates: tokens.map(t => ({ token: t.token, logProbability: t.logprob })), topCandidates: tokens.map(t => ({ candidates: (t.top_logprobs ?? []).map(a => ({ token: a.token, logProbability: a.logprob })) })) } }) });
      if (options.roundTrip !== undefined) {
        const plannedCarrier = createGeminiGenerateContentSidecarCarrier('');
        const plannedTurn = [{ role: 'model' as const, parts: [...native, plannedCarrier] }] as GeminiGenerateContentAssistantTurn;
        const replayCheck = await createGeminiGenerateContentReplayCheck(plannedTurn);
        const data = await options.roundTrip.prepareSidecar(record.choice, replayCheck!, projection.roundTripResult());
        const carrier = createGeminiGenerateContentSidecarCarrier(data);
        native.push(carrier);
        yield emitPart(record.choice, carrier);
      }
    }
    if (record.type === 'finish') {
      const tier = irServiceTier(state);
      // GenerateContent names its normal lane standard and its accelerated lane priority.
      // https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta
      const serviceTier = tier === 'fast' ? FAST_SERVICE_TIER : tier === 'default' ? 'standard' : tier;
      yield emit({ candidates: terminalCandidates, ...(state.usage === undefined ? {} : { usageMetadata: { ...usageFromIR(state.usage, 'geminiGenerateContent'), ...(serviceTier === undefined ? {} : { serviceTier }) } }) });
    }
  }
};

const groundingChunk = (citation: IRSourceCitation): IRWire => {
  if (citation.source_kind === 'url') return { web: { uri: citation.source, title: citation.source_label } };
  return { retrievedContext: { ...(citation.source == null ? {} : { uri: citation.source }), ...(citation.source_label == null ? {} : { title: citation.source_label }), ...(citation.source_text === undefined ? {} : { text: citation.source_text.text }), ...(citation.source_page_range === undefined ? {} : { pageNumber: citation.source_page_range.start_one_based }) } };
};
