
import { codePointRangeToIR } from './coordinates.ts';
import type { IRMessageItem, IRSourceCitation } from './ir.ts';
import { createIRBuilder, type IRFrame, type IRPath } from './stream.ts';
import { usageToIR, type IRWire } from './usage.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

export const irFromOpenAIChatCompletions = async function* (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>): AsyncGenerator<IRFrame> {
  const b = createIRBuilder();
  const choices = new Map<number, { message?: number; text?: number; refusal?: number; audio?: number; reasoning?: number; tools: Map<number, number>; annotations: IRWire[]; ended: boolean; incomplete: boolean }>();
  b.assign(['extensions', 'openaiChatCompletions'], {});
  let started = false;
  let done = false;
  for await (const frame of frames) {
    if (done) throw new Error('ChatCompletions frame arrived after done');
    if (frame.type === 'done') {
      for (const [index, choice] of choices) if (!choice.ended) throw new Error(`ChatCompletions choice ${index} ended without finish_reason`);
      b.event({ type: 'finish', status: [...choices.values()].some(choice => choice.incomplete) ? 'incomplete' : 'completed' });
      done = true;
      yield b.drain();
      continue;
    }
    const chunk = frame.event as unknown as IRWire;
    if (chunk.error !== undefined) throw new Error('ChatCompletions upstream error', { cause: chunk.error });
    if (!started) {
      b.event({ type: 'start', id: chunk.id, model: chunk.model, created: chunk.created });
      started = true;
    }
    for (const [key, value] of Object.entries(chunk)) if (!['choices', 'usage', 'object', 'obfuscation'].includes(key)) b.assign(['extensions', 'openaiChatCompletions', key], value);
    if (chunk.usage != null) b.assign(['usage'], usageToIR('openaiChatCompletions', chunk.usage));
    for (const entry of chunk.choices) {
      const index = entry.index as number;
      b.choice(index);
      let choice = choices.get(index);
      if (choice === undefined) { choice = { tools: new Map(), annotations: [], ended: false, incomplete: false }; choices.set(index, choice); }
      const delta = entry.delta as IRWire;
      const message = (): number => choice!.message ??= b.item(index, { type: 'message', content: [] });
      const part = (kind: 'text' | 'refusal' | 'audio'): IRPath => {
        const itemIndex = message();
        const item = b.state.choices[index].items[itemIndex] as IRMessageItem;
        if (choice![kind] === undefined) {
          choice![kind] = item.content.length;
          b.append(['choices', index, 'items', itemIndex, 'content'], [kind === 'audio' ? { type: 'audio', audio: { data: '', transcript: '' } } : { type: kind, [kind]: '' }]);
          b.event({ type: 'part_start', choice: index, item: itemIndex, part: choice![kind]! });
        }
        return ['choices', index, 'items', itemIndex, 'content', choice![kind]!];
      };
      if (typeof delta.content === 'string') b.append([...part('text'), 'text'], delta.content);
      if (typeof delta.refusal === 'string') b.append([...part('refusal'), 'refusal'], delta.refusal);
      for (const key of ['reasoning_text', 'reasoning_content', 'reasoning']) if (typeof delta[key] === 'string') {
        choice.reasoning ??= b.item(index, { type: 'reasoning', content: [''] });
        if (!('content' in b.state.choices[index].items[choice.reasoning])) b.assign(['choices', index, 'items', choice.reasoning, 'content'], ['']);
        b.append(['choices', index, 'items', choice.reasoning, 'content', 0], delta[key]);
        break;
      }
      if (delta.reasoning_opaque !== undefined) {
        choice.reasoning ??= b.item(index, { type: 'reasoning' });
        b.assign(['choices', index, 'items', choice.reasoning, 'encrypted_content'], delta.reasoning_opaque);
      }
      if (delta.reasoning_items != null) for (const item of delta.reasoning_items) if (item.type === 'reasoning') b.item(index, {
        type: 'reasoning', ...(item.summary === undefined ? {} : { summary: item.summary.map((p: IRWire) => p.text) }),
        ...(item.content === undefined ? {} : { content: item.content.map((p: IRWire) => p.text) }),
        ...(item.encrypted_content === undefined ? {} : { encrypted_content: item.encrypted_content }),
      });
      if (delta.audio != null) {
        const path = [...part('audio'), 'audio'];
        if (delta.audio.data !== undefined) b.append([...path, 'data'], delta.audio.data);
        if (delta.audio.transcript !== undefined) b.append([...path, 'transcript'], delta.audio.transcript);
        const metadata = { ...delta.audio }; delete metadata.data; delete metadata.transcript;
        const extension = b.state.extensions!.openaiChatCompletions as IRWire;
        if (extension.choices === undefined) b.assign(['extensions', 'openaiChatCompletions', 'choices'], []);
        while (extension.choices.length <= index) b.append(['extensions', 'openaiChatCompletions', 'choices'], [{ message: { audio: {} } }]);
        b.assign(['extensions', 'openaiChatCompletions', 'choices', index, 'message', 'audio'], { ...extension.choices[index].message.audio, ...metadata });
      }
      const calls = [...(delta.tool_calls ?? []), ...(delta.function_call === undefined ? [] : [{ index: -1, type: 'function', function: delta.function_call }])];
      for (const call of calls) {
        let itemIndex = choice.tools.get(call.index);
        if (itemIndex === undefined) {
          const custom = call.type === 'custom' || call.custom !== undefined;
          itemIndex = b.item(index, custom ? { type: 'custom_tool_call', call_id: '', name: '', input: '' } : { type: 'function_call', name: '', arguments: '' });
          choice.tools.set(call.index, itemIndex);
        }
        const path: IRPath = ['choices', index, 'items', itemIndex];
        if (call.id !== undefined) b.assign([...path, 'call_id'], call.id);
        const fn = call.custom ?? call.function;
        if (fn?.name !== undefined) b.assign([...path, 'name'], fn.name);
        if (fn?.arguments !== undefined) b.append([...path, 'arguments'], fn.arguments);
        if (fn?.input !== undefined) b.append([...path, 'input'], fn.input);
      }
      if (delta.annotations != null) choice.annotations = delta.annotations;
      if (entry.logprobs != null) {
        if (b.state.choices[index].logprobs == null) b.assign(['choices', index, 'logprobs'], []);
        for (const kind of ['content', 'refusal']) if (entry.logprobs[kind] != null) {
          const path = part(kind === 'content' ? 'text' : 'refusal');
          const tokens = entry.logprobs[kind];
          const groups = b.state.choices[index].logprobs!;
          let group = groups.findIndex(g => g.scope === 'text_part' && g.item_index === path[3] && g.content_index === path[5]);
          if (group < 0) {
            group = groups.length;
            b.append(['choices', index, 'logprobs'], [{ scope: 'text_part', item_index: path[3], content_index: path[5], tokens: [] }]);
          }
          b.append(['choices', index, 'logprobs', group, 'tokens'], tokens);
        }
      }
      if (entry.finish_reason != null) {
        if (choice.text !== undefined && choice.message !== undefined) {
          const item = b.state.choices[index].items[choice.message] as IRMessageItem;
          const textPart = item.content[choice.text] as Extract<IRMessageItem['content'][number], { type: 'text' }>;
          const text = textPart.text;
          const annotations: IRSourceCitation[] = choice.annotations.map(a => ({ type: 'source_citation', source_kind: 'url', source: a.url_citation.url, source_label: a.url_citation.title, output_text_range: codePointRangeToIR(text, a.url_citation.start_index, a.url_citation.end_index) }));
          if (annotations.length > 0) b.assign(['choices', index, 'items', choice.message, 'content', choice.text, 'annotations'], annotations);
        }
        for (let item = 0; item < b.state.choices[index].items.length; item++) {
          const value = b.state.choices[index].items[item];
          if (value.type === 'message') for (let p = 0; p < value.content.length; p++) b.event({ type: 'part_end', choice: index, item, part: p });
          b.event({ type: 'item_end', choice: index, item });
        }
        b.event({ type: 'choice_end', choice: index, finish_reason: entry.finish_reason === 'function_call' ? 'tool_calls' : entry.finish_reason });
        choice.ended = true;
        choice.incomplete = entry.finish_reason === 'length';
      }
    }
    yield b.drain();
  }
  if (!done) throw new Error('ChatCompletions stream ended without done');
};
