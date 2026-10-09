
import { codePointRangeToIR } from './coordinates.ts';
import type { IRItem, IRSourceCitation } from './ir.ts';
import { createIRBuilder, reconcileIRValue, type IRFrame } from './stream.ts';
import { usageToIR, type IRWire } from './usage.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const responsesItemToIR = (item: IRWire): IRItem | undefined => {
  switch (item.type) {
  case 'message': return {
    type: 'message', content: item.content.flatMap((part: IRWire) => {
      if (part.type === 'refusal') return [{ type: 'refusal', refusal: part.refusal }];
      if (part.type !== 'output_text') return [];
      const annotations: IRSourceCitation[] = (part.annotations ?? []).flatMap((a: IRWire): IRSourceCitation[] => {
        if (a.type === 'url_citation') return [{ type: 'source_citation', source_kind: 'url', source: a.url, source_label: a.title, output_text_range: codePointRangeToIR(part.text, a.start_index, a.end_index) }];
        if (a.type === 'file_citation') return [{ type: 'source_citation', source_kind: 'document', source: a.file_id, source_label: a.filename }];
        if (a.type === 'container_file_citation') return [{ type: 'source_citation', source_kind: 'document', source: a.file_id, source_label: a.filename, output_text_range: codePointRangeToIR(part.text, a.start_index, a.end_index) }];
        if (a.type === 'file_path') return [{ type: 'source_citation', source_kind: 'document', source: a.file_id }];
        return [];
      });
      return [{ type: 'text', text: part.text, ...(part.annotations === undefined ? {} : { annotations }) }];
    }),
  };
  case 'reasoning': return {
    type: 'reasoning',
    ...(item.summary === undefined ? {} : { summary: item.summary.map((p: IRWire) => p.text) }),
    ...(item.content === undefined ? {} : { content: item.content.map((p: IRWire) => p.text) }),
    ...(item.encrypted_content === undefined ? {} : { encrypted_content: item.encrypted_content }),
  };
  case 'function_call': return { type: 'function_call', name: item.name, call_id: item.call_id, arguments: item.arguments };
  case 'custom_tool_call': return { type: 'custom_tool_call', name: item.name, call_id: item.call_id, input: item.input };
  case 'image_generation_call': return item.result == null ? undefined : { type: 'message', content: [{ type: 'image', image: { data: item.result, ...(item.output_format === undefined ? {} : { mime_type: `image/${item.output_format}` }) } }] };
  default: return undefined;
  }
};

export const irFromOpenAIResponses = async function* (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>): AsyncGenerator<IRFrame> {
  const b = createIRBuilder();
  b.choice(0);
  b.assign(['extensions', 'openaiResponses'], {});
  const items = new Map<number, IRWire>();
  const indices = new Map<number, number>();
  const ended = new Set<number>();
  let started = false;
  let finished = false;
  let audioIndex: number | undefined;
  let audioEnded = false;
  const sync = (output: number): void => {
    const raw = items.get(output);
    if (raw === undefined) throw new Error('Responses delta arrived before its output item');
    const item = responsesItemToIR(raw);
    if (item === undefined) return;
    let index = indices.get(output);
    if (index === undefined) {
      index = b.item(0, item);
      indices.set(output, index);
      if (item.type === 'message') item.content.forEach((_, part) => b.event({ type: 'part_start', choice: 0, item: index!, part }));
    } else {
      const previous = b.state.choices[0].items[index];
      const count = previous.type === 'message' ? previous.content.length : 0;
      reconcileIRValue(b, ['choices', 0, 'items', index], previous, item);
      if (item.type === 'message') for (let part = count; part < item.content.length; part++) b.event({ type: 'part_start', choice: 0, item: index, part });
    }
    if (raw.type === 'message') {
      const groups = (b.state.choices[0].logprobs ?? []).filter(g => g.scope !== 'text_part' || g.item_index !== index);
      for (let part = 0; part < raw.content.length; part++) if (raw.content[part].logprobs !== undefined) groups.push({ scope: 'text_part', item_index: index, content_index: part, tokens: raw.content[part].logprobs });
      if (groups.length > 0) b.assign(['choices', 0, 'logprobs'], groups);
    }
  };
  const end = (output: number): void => {
    if (ended.has(output)) return;
    const index = indices.get(output);
    if (index !== undefined) {
      const item = b.state.choices[0].items[index];
      if (item.type === 'message') item.content.forEach((_, part) => b.event({ type: 'part_end', choice: 0, item: index, part }));
      b.event({ type: 'item_end', choice: 0, item: index });
    }
    ended.add(output);
  };
  for await (const frame of frames) {
    if (frame.type === 'done') {
      if (!finished) throw new Error('Responses done arrived without a terminal response');
      continue;
    }
    const e = frame.event as unknown as IRWire;
    if (finished) throw new Error('Responses event arrived after terminal response');
    if (e.type === 'error') throw new Error('Responses upstream error', { cause: e });
    if (e.response !== undefined) {
      const response = e.response as IRWire;
      if (!started) { b.event({ type: 'start', id: response.id, model: response.model, created: response.created_at }); started = true; }
      for (const [key, value] of Object.entries(response)) if (!['output', 'usage'].includes(key)) b.assign(['extensions', 'openaiResponses', key], value);
      if (response.usage != null) b.assign(['usage'], usageToIR('openaiResponses', response.usage));
      if (['response.completed', 'response.incomplete', 'response.failed'].includes(e.type)) {
        response.output.forEach((item: IRWire, index: number) => { items.set(index, structuredClone(item)); sync(index); end(index); });
        b.event({ type: 'choice_end', choice: 0, finish_reason: e.type === 'response.incomplete' ? 'length' : b.state.choices[0].items.some(i => i.type === 'function_call' || i.type === 'custom_tool_call') ? 'tool_calls' : 'stop' });
        b.event({ type: 'finish', status: e.type.slice('response.'.length), ...(response.error == null ? {} : { error: response.error }) });
        finished = true;
      }
    } else if (e.type === 'response.output_item.added' || e.type === 'response.output_item.done') {
      items.set(e.output_index, structuredClone(e.item));
      sync(e.output_index);
      if (e.type.endsWith('.done')) end(e.output_index);
    } else if (e.type === 'response.audio.delta' || e.type === 'response.audio.transcript.delta') {
      // These standard events address one response-level stream without item/content indexes.
      // https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/resources/responses/responses.ts#L2033-L2100
      audioIndex ??= b.item(0, { type: 'message', content: [{ type: 'audio', audio: { data: '', transcript: '' } }] });
      b.append(['choices', 0, 'items', audioIndex, 'content', 0, 'audio', e.type === 'response.audio.delta' ? 'data' : 'transcript'], e.delta);
    } else if (e.type === 'response.audio.done' || e.type === 'response.audio.transcript.done') {
      audioEnded = true;
    } else if (e.output_index !== undefined && items.has(e.output_index)) {
      const item = items.get(e.output_index)!;
      const partIndex = e.content_index ?? e.summary_index;
      if (e.type === 'response.content_part.added' || e.type === 'response.content_part.done') {
        item.content[e.content_index] = structuredClone(e.part);
      } else if (e.type === 'response.reasoning_summary_part.added' || e.type === 'response.reasoning_summary_part.done') {
        item.summary[e.summary_index] = structuredClone(e.part);
      } else if (e.type === 'response.output_text.delta' || e.type === 'response.refusal.delta') {
        const field = e.type === 'response.refusal.delta' ? 'refusal' : 'text';
        item.content[partIndex][field] += e.delta;
        if (e.logprobs !== undefined) (item.content[partIndex].logprobs ??= []).push(...e.logprobs);
      } else if (e.type === 'response.output_text.done' || e.type === 'response.refusal.done') {
        const field = e.type === 'response.refusal.done' ? 'refusal' : 'text';
        item.content[partIndex][field] = e[field];
        if (e.logprobs !== undefined) item.content[partIndex].logprobs = e.logprobs;
      } else if (e.type === 'response.output_text.annotation.added') {
        (item.content[partIndex].annotations ??= [])[e.annotation_index] = structuredClone(e.annotation);
      } else if (e.type === 'response.function_call_arguments.delta' || e.type === 'response.custom_tool_call_input.delta') {
        item[e.type.includes('arguments') ? 'arguments' : 'input'] += e.delta;
      } else if (e.type === 'response.function_call_arguments.done' || e.type === 'response.custom_tool_call_input.done') {
        const key = e.type.includes('arguments') ? 'arguments' : 'input'; item[key] = e[key];
      } else if (e.type === 'response.reasoning_summary_text.delta' || e.type === 'response.reasoning_text.delta') {
        const array = e.type.includes('summary') ? 'summary' : 'content';
        (item[array] ??= [])[partIndex] ??= { type: array === 'summary' ? 'summary_text' : 'reasoning_text', text: '' };
        item[array][partIndex].text += e.delta;
      } else if (e.type === 'response.reasoning_summary_text.done' || e.type === 'response.reasoning_text.done') {
        const array = e.type.includes('summary') ? 'summary' : 'content'; item[array][partIndex].text = e.text;
      } else if (e.type === 'response.image_generation_call.partial_image') {
        item.result = e.partial_image_b64;
      }
      sync(e.output_index);
    }
    if (finished && audioIndex !== undefined) {
      if (!audioEnded) throw new Error('Responses audio stream ended without an audio done event');
      const last = b.drain();
      const finish = last.records.pop()!;
      last.records.push({ type: 'part_end', choice: 0, item: audioIndex, part: 0 }, { type: 'item_end', choice: 0, item: audioIndex }, finish);
      yield last;
      continue;
    }
    yield b.drain();
  }
  if (!finished) throw new Error('Responses stream ended without a terminal response');
};
