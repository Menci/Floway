
import { codePointRangeToIR } from '../../coordinates.ts';
import type { IRAudioPart, IRItem, IRMessageItem, IRSourceCitation } from '../../ir.ts';
import { cloneIRJSON } from '../../json.ts';
import { createIRBuilder, reconcileIRValue, type IRFrame } from '../../stream.ts';
import { usageToIR, type IRWire } from '../../usage.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const responsesItemToIR = (item: IRWire): IRItem | undefined => {
  switch (item.type) {
  case 'message': return {
    type: 'message', content: item.content.flatMap((part: IRWire) => {
      if (part.type === 'refusal') return [{ type: 'refusal', refusal: part.refusal }];
      if (part.type !== 'output_text') return [];
      const annotations: IRSourceCitation[] = (part.annotations ?? []).flatMap((a: IRWire): IRSourceCitation[] => {
        if (a === null) return [];
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
  case 'image_generation_call': return item.result == null ? undefined : { type: 'message', content: [{ type: 'image', image: { data: item.result, ...(item.output_format == null ? {} : { mime_type: `image/${item.output_format}` }) } }] };
  default: throw new TypeError(`Cannot translate Responses output item ${item.type}`);
  }
};

interface IRResponsesNode {
  item: IRWire;
  done: boolean;
  index?: number;
  closedParts: Set<number>;
  sentParts: Set<number>;
  ended: boolean;
}

export const irFromOpenAIResponses = async function* (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>): AsyncGenerator<IRFrame> {
  const b = createIRBuilder();
  b.choice(0);
  b.assign(['extensions', 'openaiResponses'], {});
  const nodes = new Map<number, IRResponsesNode>();
  let started = false;
  let finished = false;
  let audioIndex: number | undefined;
  const audioDone = new Set<string>();
  const replace = (output: number, item: IRWire, done: boolean): void => {
    const node = nodes.get(output);
    if (node === undefined) nodes.set(output, { item: cloneIRJSON(item), done, closedParts: new Set(), sentParts: new Set(), ended: false });
    else { node.item = cloneIRJSON(item); node.done ||= done; }
  };
  const flush = (): void => {
    let expected = 0;
    for (const [outputIndex, node] of [...nodes].toSorted(([a], [c]) => a - c)) {
      if (outputIndex !== expected++) break;
      if (node.item.type === 'image_generation_call' && node.item.result == null && !node.done) break;
      const item = responsesItemToIR(node.item);
      if (item !== undefined) {
        const previous = node.index === undefined ? undefined : b.state.choices[0].items[node.index];
        const count = previous?.type === 'message' ? previous.content.length : 0;
        if (node.index === undefined) {
          node.index = b.state.choices[0].items.length;
          if ((b.state.extensions!.openaiResponses as IRWire).item_ids === undefined) b.assign(['extensions', 'openaiResponses', 'item_ids'], {});
          b.assign(['extensions', 'openaiResponses', 'item_ids', String(node.index)], node.item.id);
          b.item(0, item);
        } else reconcileIRValue(b, ['choices', 0, 'items', node.index], previous, item);
        if (item.type === 'message') for (let part = count; part < item.content.length; part++) b.event({ type: 'part_start', choice: 0, item: node.index, part });
        if (node.item.type === 'message') {
          const groups = (b.state.choices[0].logprobs ?? []).filter(g => g.scope !== 'text_part' || g.item_index !== node.index);
          for (let part = 0; part < node.item.content.length; part++) if (node.item.content[part].logprobs !== undefined) groups.push({ scope: 'text_part', item_index: node.index, content_index: part, tokens: node.item.content[part].logprobs });
          if (groups.length > 0) reconcileIRValue(b, ['choices', 0, 'logprobs'], b.state.choices[0].logprobs, groups);
        }
      }
      if (node.index === undefined) continue;
      const current = b.state.choices[0].items[node.index];
      if (current.type === 'message') for (let part = 0; part < current.content.length; part++) {
        if ((node.done || node.closedParts.has(part)) && !node.sentParts.has(part)) {
          b.event({ type: 'part_end', choice: 0, item: node.index, part }); node.sentParts.add(part);
        }
      }
      if (node.done && !node.ended) { b.event({ type: 'item_end', choice: 0, item: node.index }); node.ended = true; }
    }
  };
  for await (const frame of frames) {
    if (frame.type === 'done') {
      if (!finished) throw new Error('Responses done arrived without a terminal response');
      continue;
    }
    const e = frame.event as unknown as IRWire;
    if (finished) throw new Error('Responses event arrived after terminal response');
    if (e.type === 'error') { b.event({ type: 'error', error: e.error ?? e }); yield b.drain(); return; }
    if (e.type === 'response.failed' && e.response.error?.code !== 'bio_policy' && e.response.error?.code !== 'cyber_policy') {
      b.event({ type: 'error', error: e.response.error }); yield b.drain(); return;
    }
    if (e.response !== undefined) {
      const response = e.response as IRWire;
      if (!started) { b.event({ type: 'start', id: response.id, model: response.model, created: response.created_at }); started = true; }
      for (const [key, value] of Object.entries(response)) if (!['output', 'usage'].includes(key) && value !== undefined) b.assign(['extensions', 'openaiResponses', key], value);
      if (response.usage != null) b.assign(['usage'], usageToIR('openaiResponses', response.usage));
      if (['response.completed', 'response.incomplete', 'response.failed'].includes(e.type)) {
        response.output.forEach((item: IRWire, index: number) => replace(index, item, true));
        flush();
        if (audioIndex !== undefined) {
          const part = (b.state.choices[0].items[audioIndex] as IRMessageItem).content[0] as IRAudioPart;
          for (const field of ['data', 'transcript'] as const) if (part.audio[field] !== undefined && !audioDone.has(field)) throw new Error('Responses audio stream ended without its done event');
          b.event({ type: 'part_end', choice: 0, item: audioIndex, part: 0 });
          b.event({ type: 'item_end', choice: 0, item: audioIndex });
        }
        const policy = response.error?.code === 'cyber_policy' ? 'cyber' : response.error?.code === 'bio_policy' ? 'bio' : undefined;
        if (policy !== undefined) b.assign(['choices', 0, 'refusal'], { category: policy, explanation: response.error.message });
        b.event({ type: 'choice_end', choice: 0, finish_reason: policy !== undefined ? 'content_filter' : e.type === 'response.incomplete' ? response.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'length' : b.state.choices[0].items.some(i => i.type === 'function_call' || i.type === 'custom_tool_call') ? 'tool_calls' : 'stop' });
        b.event({ type: 'finish', status: policy === undefined ? e.type.slice('response.'.length) : 'completed', ...(response.error == null ? {} : { error: response.error }) });
        finished = true;
      }
    } else if (e.type === 'response.output_item.added' || e.type === 'response.output_item.done') {
      replace(e.output_index, e.item, e.type.endsWith('.done')); flush();
    } else if (e.type === 'response.audio.delta' || e.type === 'response.audio.transcript.delta') {
      // These standard events address one response-level stream without item/content indexes.
      // https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/resources/responses/responses.ts#L2033-L2100
      const field = e.type === 'response.audio.delta' ? 'data' : 'transcript';
      if (audioIndex === undefined) {
        audioIndex = b.item(0, { type: 'message', content: [{ type: 'audio', audio: { [field]: '' } }] });
        b.event({ type: 'part_start', choice: 0, item: audioIndex, part: 0 });
      }
      const path = ['choices', 0, 'items', audioIndex, 'content', 0, 'audio'];
      const part = (b.state.choices[0].items[audioIndex] as IRMessageItem).content[0] as IRAudioPart;
      if (part.audio[field] === undefined) b.assign([...path, field], '');
      b.append([...path, field], e.delta);
    } else if (e.type === 'response.audio.done' || e.type === 'response.audio.transcript.done') {
      audioDone.add(e.type === 'response.audio.done' ? 'data' : 'transcript');
    } else if (e.output_index !== undefined) {
      const node = nodes.get(e.output_index);
      if (node === undefined) throw new Error('Responses event arrived before its output item');
      const item = node.item;
      const partIndex = e.content_index ?? e.summary_index;
      if (e.type === 'response.content_part.added' || e.type === 'response.content_part.done') {
        item.content[e.content_index] = cloneIRJSON(e.part);
        if (e.type.endsWith('.done')) node.closedParts.add(e.content_index);
      } else if (e.type === 'response.reasoning_summary_part.added' || e.type === 'response.reasoning_summary_part.done') {
        item.summary[e.summary_index] = cloneIRJSON(e.part);
      } else if (e.type === 'response.output_text.delta' || e.type === 'response.refusal.delta') {
        const field = e.type === 'response.refusal.delta' ? 'refusal' : 'text'; item.content[partIndex][field] += e.delta;
        if (e.logprobs !== undefined) (item.content[partIndex].logprobs ??= []).push(...e.logprobs);
      } else if (e.type === 'response.output_text.done' || e.type === 'response.refusal.done') {
        const field = e.type === 'response.refusal.done' ? 'refusal' : 'text'; item.content[partIndex][field] = e[field];
        if (e.logprobs !== undefined) item.content[partIndex].logprobs = e.logprobs;
      } else if (e.type === 'response.output_text.annotation.added') {
        (item.content[partIndex].annotations ??= [])[e.annotation_index] = cloneIRJSON(e.annotation);
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
      } else if (e.type === 'response.image_generation_call.partial_image') item.result = e.partial_image_b64;
      flush();
    }
    yield b.drain();
    if (finished) return;
  }
  if (!finished) throw new Error('Responses stream ended without a terminal response');
};
