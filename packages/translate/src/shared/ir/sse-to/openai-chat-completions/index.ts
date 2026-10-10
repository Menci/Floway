import type { IRJSONObject } from '../../ir.ts';
import { createOpenAIChatCompletionsReplayCheck, createOpenAIChatCompletionsSidecarCarrier } from '../../round-trip/openai-chat-completions.ts';
import { irRangeToCodePoints } from '../../shared/coordinates.ts';
import { irOutputMetadata, irServingModel } from '../../shared/metadata.ts';
import { createIRProjection, type IROutputOptions } from '../../shared/projection.ts';
import { createIRTextStream } from '../../shared/text.ts';
import { usageFromIR, irServiceTier, type IRWire } from '../../shared/usage.ts';
import { consumeIRRecords, type IRFrame, type IRPath } from '../../stream.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { createOpenAIChatCompletionsReassembler, type OpenAIChatCompletionsAssistantMessageEx, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const irChatError = (error: IRJSONObject): IRJSONObject => ({
  message: error.message,
  type: typeof error.type === 'string' && error.type !== 'error' ? error.type : error.code ?? 'server_error',
  ...(error.code === undefined ? {} : { code: error.code }),
  ...(error.param === undefined ? {} : { param: error.param }),
  ...(error.provider_specific_fields === undefined ? {} : { provider_specific_fields: error.provider_specific_fields }),
});

export const openaiChatCompletionsFromIR = async function* (frames: AsyncIterable<IRFrame>, options: IROutputOptions = {}): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  let metadata = { id: '', model: '', created: 0 };
  let started = false;
  const projection = createIRProjection();
  const nativeReassembler = options.roundTrip === undefined ? undefined : createOpenAIChatCompletionsReassembler();
  const textStream = createIRTextStream();
  const opaqueItems = new Map<number, number>();
  const completedItems = new Set<string>();
  const tools = new Map<string, number>();
  const names = new Map<string, string>();
  const logprobLengths = new Map<string, number>();
  const audioMetadata = new Map<number, IRWire>();
  const opaqueChoices = new Set<number>();
  const startedChoices = new Set<number>();
  let extension: IRWire = {};
  const chunk = (choices: IRWire[], fields: IRWire = {}): ProtocolFrame<OpenAIChatCompletionsStreamEvent> => {
    const event = { ...extension, id: metadata.id, object: 'chat.completion.chunk', model: metadata.model, created: metadata.created, choices, ...fields } as OpenAIChatCompletionsStreamEvent;
    nativeReassembler?.accept(event);
    return eventFrame(event);
  };
  const deltaFrame = (choice: number, delta: IRWire): ProtocolFrame<OpenAIChatCompletionsStreamEvent> => chunk([{ index: choice, delta, finish_reason: null }]);
  for await (const { state, record } of consumeIRRecords(frames)) {
    textStream.update(state);
    if (record.type === 'start') { metadata = irOutputMetadata(record, options); started = true; }
    if (!started && record.type !== 'error') continue;
    metadata.model = irServingModel(state, metadata.model);
    if (record.type === 'item_end') completedItems.add(`${record.choice}/${record.item}`);
    extension = { ...state.extensions?.openaiChatCompletions };
    delete extension.reasoning_items; delete extension.reasoning_id;
    const tier = irServiceTier(state);
    if (tier !== undefined) extension.service_tier = tier;
    if (record.type === 'error' || record.type === 'finish' && record.status === 'failed') {
      if (record.error === undefined) throw new TypeError('Failed IR generation requires an error');
      yield eventFrame({ error: irChatError(record.error) } as unknown as OpenAIChatCompletionsStreamEvent);
      return;
    }
    if (record.type === 'operation' || record.type === 'part_end' || record.type === 'item_end' || record.type === 'choice_end' || record.type === 'finish') {
      for (let choice = 0; choice < state.choices.length; choice++) {
        if (state.choices[choice].items.length === 0 && state.usage === undefined && record.type !== 'choice_end' && record.type !== 'finish') continue;
        if (!startedChoices.has(choice)) { yield deltaFrame(choice, { role: 'assistant', content: '' }); startedChoices.add(choice); }
        for (let index = 0; index < state.choices[choice].items.length; index++) {
          const item = state.choices[choice].items[index];
          const path: IRPath = ['choices', choice, 'items', index];
          const target: IRPath = ['choices', choice, 'message'];
          const closed = completedItems.has(`${choice}/${index}`) || record.type === 'finish' || record.type === 'choice_end' && record.choice === choice || record.type === 'item_end' && record.item === index && record.choice === choice;
          if (item.type === 'message') for (let p = 0; p < item.content.length; p++) {
            const part = item.content[p];
            const source = [...path, 'content', p];
            if (part.type === 'text' || part.type === 'refusal') {
              const key = part.type === 'text' ? 'content' : 'refusal';
              projection.markRoundTrip([...target, key]);
              for (const update of textStream.take([...source, part.type === 'text' ? 'text' : 'refusal'])) {
                const delta = projection.appendText(update, [...target, key]);
                if (delta !== '') yield deltaFrame(choice, { [key]: delta });
              }
            } else if (part.type === 'audio') {
              if (part.audio.data === undefined) {
                if (!closed && !(record.type === 'part_end' && record.choice === choice && record.item === index && record.part === p)) continue;
                projection.markRoundTrip([...target, 'content']);
                for (const update of textStream.take([...source, 'audio', 'transcript'])) {
                  const text = projection.appendText(update, [...target, 'content']);
                  if (text !== '') yield deltaFrame(choice, { content: text });
                }
                continue;
              }
              const delta: IRWire = {};
              const metadata: IRWire | undefined = options.audioMetadata?.(choice) ?? (state.extensions?.openaiChatCompletions as IRWire | undefined)?.choices?.[choice]?.message?.audio;
              const sent = audioMetadata.get(choice) ?? {};
              for (const field of ['id', 'expires_at']) if (metadata?.[field] !== undefined && metadata[field] !== sent[field]) { delta[field] = metadata[field]; sent[field] = metadata[field]; }
              audioMetadata.set(choice, sent);
              if (part.audio.transcript === undefined && !('transcript' in sent)) { delta.transcript = ''; sent.transcript = ''; }
              if (part.audio.data !== undefined) {
                const value = projection.append([...source, 'audio', 'data'], part.audio.data, [...target, 'audio', 'data']);
                if (value !== '') delta.data = value;
              }
              for (const update of textStream.take([...source, 'audio', 'transcript'])) {
                const value = projection.appendText(update, [...target, 'audio', 'transcript']);
                if (value !== '') delta.transcript = (delta.transcript ?? '') + value;
              }
              if (Object.keys(delta).length > 0) yield deltaFrame(choice, { audio: delta });
            }
          } else if (item.type === 'reasoning') {
            projection.markRoundTrip([...target, 'reasoning_text']);
            for (const update of textStream.take(path)) {
              const delta = projection.appendText(update, [...target, 'reasoning_text']);
              if (delta !== '') yield deltaFrame(choice, { reasoning_text: delta });
            }
            if (item.encrypted_content !== undefined && !opaqueItems.has(choice)) opaqueItems.set(choice, index);
            if (options.roundTrip === undefined && state.extensions?.anthropicMessages !== undefined && item.encrypted_content != null && closed && opaqueItems.get(choice) === index && !opaqueChoices.has(choice)) {
              yield deltaFrame(choice, { reasoning_opaque: item.encrypted_content });
              opaqueChoices.add(choice);
            }
          } else {
            const key = JSON.stringify(path);
            let toolIndex = tools.get(key);
            if (toolIndex === undefined) { toolIndex = [...tools.keys()].filter(k => JSON.parse(k)[1] === choice).length; tools.set(key, toolIndex); }
            const custom = item.type === 'custom_tool_call';
            const field = custom ? 'input' : 'arguments';
            const namespace = custom ? 'custom' : 'function';
            const argument = custom ? item.input : typeof item.arguments === 'object' ? closed ? JSON.stringify(item.arguments) : '' : item.arguments ?? '';
            projection.markRoundTrip([...target, 'tool_calls', toolIndex, namespace, field]);
            const delta = !custom && typeof item.arguments === 'object' && !closed ? '' : projection.append([...path, field], argument, [...target, 'tool_calls', toolIndex, namespace, field]);
            const name = `${item.call_id ?? ''}\0${item.name}`;
            const changed = names.get(key) !== name;
            if (changed) names.set(key, name);
            if (changed || delta !== '') yield deltaFrame(choice, { tool_calls: [{ index: toolIndex, ...(changed ? { id: item.call_id ?? `${metadata.id}_${choice}_${index}`, type: custom ? 'custom' : 'function' } : {}), [namespace]: { ...(changed ? { name: item.name } : {}), ...(delta !== '' ? { [field]: delta } : {}) } }] });
          }

        }
        for (let group = 0; group < (state.choices[choice].logprobs?.length ?? 0); group++) {
          const value = state.choices[choice].logprobs![group];
          const key = `${choice}/${group}`;
          const length = logprobLengths.get(key) ?? 0;
          if (value.tokens.length > length) {
            let refusal = false;
            if (value.scope === 'text_part') {
              const item = state.choices[choice].items[value.item_index];
              if (item.type !== 'message' || !['text', 'refusal'].includes(item.content[value.content_index].type)) throw new TypeError('Text-part logprobs require a text or refusal owner');
              refusal = item.content[value.content_index].type === 'refusal';
            }
            yield chunk([{ index: choice, delta: {}, logprobs: { content: refusal ? null : value.tokens.slice(length), refusal: refusal ? value.tokens.slice(length) : null } }]);
            logprobLengths.set(key, value.tokens.length);
          }
        }
      }
    }
    if (record.type === 'choice_end') {
      const choice = record.choice;
      if (state.choices[choice].items.some(item => item.type === 'message' && item.content.some(part => part.type === 'audio' && part.audio.data !== undefined))) {
        const metadata = audioMetadata.get(choice);
        if (metadata?.id === undefined || metadata.expires_at === undefined) throw new Error('ChatCompletions audio requires replay ID and expiry metadata');
      }
      const result = projection.result();
      const content = result.contents.find(v => JSON.stringify(v.path) === JSON.stringify(['choices', choice, 'message', 'content']))?.text ?? '';
      const annotations: IRWire[] = [];
      state.choices[choice].items.forEach((item, index) => {
        if (item.type !== 'message') return;
        item.content.forEach((part, p) => {
          if (part.type !== 'text') return;
          const segments = result.projections.filter(v => JSON.stringify(v.source_path) === JSON.stringify(['choices', choice, 'items', index, 'content', p, 'text']));
          for (const annotation of part.annotations ?? []) if ((annotation.source_kind === 'url' || annotation.source_kind === 'search_result') && annotation.source != null) {
            const range = annotation.output_text_range ?? { start: 0, end_exclusive: part.text.length };
            for (const segment of segments) {
              const start = Math.max(range.start, segment.source_start);
              const end = Math.min(range.end_exclusive, segment.source_end_exclusive);
              if (end <= start) continue;
              const offsets = irRangeToCodePoints(content, { start: segment.target_start + start - segment.source_start, end_exclusive: segment.target_start + end - segment.source_start });
              annotations.push({ type: 'url_citation', url_citation: { start_index: offsets.start, end_index: offsets.end, title: annotation.source_label ?? annotation.source, url: annotation.source } });
            }
          }
        });
      });
      if (annotations.length > 0) yield deltaFrame(choice, { annotations });
      const refusal = state.choices[choice].refusal;
      if (refusal?.explanation != null) yield deltaFrame(choice, { refusal: refusal.explanation });
      if (options.roundTrip !== undefined) {
        if (state.extensions?.openaiResponses !== undefined) {
          const ids = state.extensions.openaiResponses.item_ids as IRWire;
          const reasoning = state.choices[choice].items.flatMap((item, index) => item.type === 'reasoning' ? [{ type: 'reasoning', id: ids[index], summary: (item.summary ?? []).map(text => ({ type: 'summary_text', text })) }] : []);
          if (reasoning.length > 0) yield deltaFrame(choice, { reasoning_items: reasoning });
        }
        const assistantTurn = nativeReassembler!.choiceMessage(choice) as OpenAIChatCompletionsAssistantMessageEx;
        const summary = typeof assistantTurn.reasoning_text === 'string' && assistantTurn.reasoning_text !== '' ? assistantTurn.reasoning_text : undefined;
        assistantTurn.reasoning_details = createOpenAIChatCompletionsSidecarCarrier('', summary);
        const replayCheck = await createOpenAIChatCompletionsReplayCheck(assistantTurn);
        const data = await options.roundTrip.prepareSidecar(choice, replayCheck!, projection.roundTripResult());
        yield deltaFrame(choice, { reasoning_details: createOpenAIChatCompletionsSidecarCarrier(data, summary) });
      }
      yield chunk([{ index: choice, delta: {}, finish_reason: record.finish_reason }]);
    }
    if (record.type === 'finish') {
      if (options.roundTrip === undefined && state.extensions?.openaiResponses !== undefined) {
        const ids = state.extensions.openaiResponses.item_ids as IRWire;
        const reasoning = state.choices[0]?.items.flatMap((item, index) => item.type === 'reasoning' ? [{ type: 'reasoning', id: ids[index], summary: (item.summary ?? []).map(text => ({ type: 'summary_text', text })) }] : []);
        if (reasoning?.length) yield deltaFrame(0, { reasoning_items: reasoning });
      }
      if (state.usage !== undefined) yield chunk([], { usage: usageFromIR(state.usage, 'openaiChatCompletions') });

      yield doneFrame();
    }
  }
};
