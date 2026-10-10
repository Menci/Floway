import { codePointRangeToIR } from '../../coordinates.ts';
import { unwrapCustomToolInput } from '../../custom-tools.ts';
import type { IRMessageItem, IRReasoningItem } from '../../ir.ts';
import { createIRBuilder, reconcileIRValue, type IRFrame, type IRPath } from '../../stream.ts';
import { usageToIR, type IRWire } from '../../usage.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

interface IRChatTool { item?: number; id?: string; name: string; arguments: string; custom: boolean; wrapped: boolean }
interface IRChatChoice {
  message?: number;
  text?: number;
  refusal?: number;
  audio?: number;
  reasoning?: number;
  tools: Map<number, IRChatTool>;
  annotations: IRWire[];
  closed: Set<number>;
  ended: boolean;
  incomplete: boolean;
}

export const irFromOpenAIChatCompletions = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
  options: { customToolNames?: ReadonlySet<string> } = {},
): AsyncGenerator<IRFrame> {
  const b = createIRBuilder();
  const choices = new Map<number, IRChatChoice>();
  b.assign(['extensions', 'openaiChatCompletions'], {});
  let started = false;
  const closeItem = (index: number, choice: IRChatChoice, item: number): void => {
    if (choice.closed.has(item)) return;
    const value = b.state.choices[index].items[item];
    if (value.type === 'message') for (let p = 0; p < value.content.length; p++) b.event({ type: 'part_end', choice: index, item, part: p });
    b.event({ type: 'item_end', choice: index, item });
    choice.closed.add(item);
  };
  const closeMessage = (index: number, choice: IRChatChoice): void => {
    if (choice.message === undefined) return;
    if (choice.text !== undefined && choice.annotations.length > 0) {
      const item = b.state.choices[index].items[choice.message] as IRMessageItem;
      const text = (item.content[choice.text] as Extract<IRMessageItem['content'][number], { type: 'text' }>).text;
      b.assign(['choices', index, 'items', choice.message, 'content', choice.text, 'annotations'], choice.annotations.map(a => ({ type: 'source_citation', source_kind: 'url', source: a.url_citation.url, source_label: a.url_citation.title, output_text_range: codePointRangeToIR(text, a.url_citation.start_index, a.url_citation.end_index) })));
    }
    closeItem(index, choice, choice.message);
    choice.message = choice.text = choice.refusal = choice.audio = undefined;
    choice.annotations = [];
  };
  const finish = (): IRFrame => {
    if (!started) throw new Error('ChatCompletions stream ended without a response');
    for (const [index, choice] of choices) if (!choice.ended) throw new Error(`ChatCompletions choice ${index} ended without finish_reason`);
    b.event({ type: 'finish', status: [...choices.values()].some(choice => choice.incomplete) ? 'incomplete' : 'completed' });
    return b.drain();
  };
  for await (const frame of frames) {
    if (frame.type === 'done') { yield finish(); return; }
    const chunk = frame.event as unknown as IRWire;
    if (chunk.error !== undefined) { b.event({ type: 'error', error: chunk.error }); yield b.drain(); return; }
    if (!started) { b.event({ type: 'start', id: chunk.id, model: chunk.model, created: chunk.created }); started = true; }
    for (const [key, value] of Object.entries(chunk)) if (!['choices', 'usage', 'object', 'obfuscation'].includes(key)) b.assign(['extensions', 'openaiChatCompletions', key], value);
    if (chunk.usage != null) {
      const usage = usageToIR('openaiChatCompletions', chunk.usage);
      b.assign(['usage'], { ...b.state.usage, ...usage });
    }
    for (const entry of chunk.choices) {
      const index = entry.index as number;
      b.choice(index);
      let choice = choices.get(index);
      if (choice === undefined) { choice = { tools: new Map(), annotations: [], closed: new Set(), ended: false, incomplete: false }; choices.set(index, choice); }
      const delta = entry.delta as IRWire;
      const part = (kind: 'text' | 'refusal' | 'audio'): IRPath => {
        if (choice!.reasoning !== undefined && (b.state.choices[index].items[choice!.reasoning] as IRReasoningItem).encrypted_content != null) closeItem(index, choice!, choice!.reasoning);
        choice!.message ??= b.item(index, { type: 'message', content: [] });
        const item = b.state.choices[index].items[choice!.message] as IRMessageItem;
        if (choice![kind] === undefined) {
          choice![kind] = item.content.length;
          b.append(['choices', index, 'items', choice!.message, 'content'], [kind === 'audio' ? { type: 'audio', audio: { data: '', transcript: '' } } : { type: kind, [kind]: '' }]);
          b.event({ type: 'part_start', choice: index, item: choice!.message, part: choice![kind]! });
        }
        return ['choices', index, 'items', choice!.message, 'content', choice![kind]!];
      };
      for (const key of ['reasoning_text', 'reasoning_content', 'reasoning']) if (typeof delta[key] === 'string' && delta[key] !== '') {
        closeMessage(index, choice);
        choice.reasoning ??= b.item(index, { type: 'reasoning', summary: [''] });
        b.append(['choices', index, 'items', choice.reasoning, 'summary', 0], delta[key]);
        break;
      }
      if (delta.reasoning_opaque != null) {
        choice.reasoning ??= b.item(index, { type: 'reasoning', summary: [''] });
        b.assign(['choices', index, 'items', choice.reasoning, 'encrypted_content'], delta.reasoning_opaque);
      }
      if (delta.reasoning_items?.length) {
        const first = delta.reasoning_items[0];
        const value: IRReasoningItem = { type: 'reasoning', summary: delta.reasoning_items.flatMap((item: IRWire) => (item.summary ?? []).map((p: IRWire) => p.text)) };
        if (choice.reasoning === undefined) choice.reasoning = b.item(index, value);
        else {
          b.assign(['choices', index, 'items', choice.reasoning, 'summary'], value.summary);
        }
        b.assign(['extensions', 'openaiChatCompletions', 'reasoning_items'], delta.reasoning_items);
        if (first.id !== undefined) b.assign(['extensions', 'openaiChatCompletions', 'reasoning_id'], first.id);
      }
      if (typeof delta.content === 'string') b.append([...part('text'), 'text'], delta.content);
      if (typeof delta.refusal === 'string') b.append([...part('refusal'), 'refusal'], delta.refusal);
      if (delta.audio != null) {
        const path = [...part('audio'), 'audio'];
        for (const field of ['data', 'transcript']) if (delta.audio[field] !== undefined) b.append([...path, field], delta.audio[field]);
        const metadata = { ...delta.audio }; delete metadata.data; delete metadata.transcript;
        const extension = b.state.extensions!.openaiChatCompletions as IRWire;
        if (extension.choices === undefined) b.assign(['extensions', 'openaiChatCompletions', 'choices'], []);
        while (extension.choices.length <= index) b.append(['extensions', 'openaiChatCompletions', 'choices'], [{ message: { audio: {} } }]);
        b.assign(['extensions', 'openaiChatCompletions', 'choices', index, 'message', 'audio'], { ...extension.choices[index].message.audio, ...metadata });
      }
      const calls = [...(delta.tool_calls ?? []), ...(delta.function_call === undefined ? [] : [{ index: -1, type: 'function', function: delta.function_call }])];
      for (const call of calls) {
        closeMessage(index, choice);
        if (choice.reasoning !== undefined && (b.state.choices[index].items[choice.reasoning] as IRReasoningItem).encrypted_content != null) closeItem(index, choice, choice.reasoning);
        let tool = choice.tools.get(call.index);
        if (tool === undefined) { tool = { name: '', arguments: '', custom: call.type === 'custom' || call.custom !== undefined, wrapped: false }; choice.tools.set(call.index, tool); }
        const fn = call.custom ?? call.function;
        if (call.id !== undefined) tool.id = call.id;
        if (fn?.name !== undefined) tool.name = fn.name;
        if (fn?.arguments !== undefined) tool.arguments += fn.arguments;
        if (fn?.input !== undefined) tool.arguments += fn.input;
        tool.wrapped = options.customToolNames?.has(tool.name) === true;
        if (tool.item === undefined && tool.name !== '') tool.item = b.item(index, tool.custom || tool.wrapped ? { type: 'custom_tool_call', call_id: tool.id ?? '', name: tool.name, input: tool.wrapped ? '' : tool.arguments } : { type: 'function_call', name: tool.name, ...(tool.id === undefined ? {} : { call_id: tool.id }), arguments: tool.arguments });
        else if (tool.item !== undefined) {
          const path: IRPath = ['choices', index, 'items', tool.item];
          if (tool.id !== undefined) b.assign([...path, 'call_id'], tool.id);
          b.assign([...path, 'name'], tool.name);
          if (!tool.wrapped) reconcileIRValue(b, [...path, tool.custom ? 'input' : 'arguments'], (b.state.choices[index].items[tool.item] as IRWire)[tool.custom ? 'input' : 'arguments'], tool.arguments);
        }
      }
      if (delta.annotations != null) choice.annotations = delta.annotations;
      if (entry.logprobs != null) {
        if (b.state.choices[index].logprobs == null) b.assign(['choices', index, 'logprobs'], []);
        for (const kind of ['content', 'refusal']) if (entry.logprobs[kind] != null) {
          const path = part(kind === 'content' ? 'text' : 'refusal');
          const groups = b.state.choices[index].logprobs!;
          let group = groups.findIndex(g => g.scope === 'text_part' && g.item_index === path[3] && g.content_index === path[5]);
          if (group < 0) { group = groups.length; b.append(['choices', index, 'logprobs'], [{ scope: 'text_part', item_index: path[3], content_index: path[5], tokens: [] }]); }
          b.append(['choices', index, 'logprobs', group, 'tokens'], entry.logprobs[kind]);
        }
      }
      if (entry.finish_reason != null) {
        for (const tool of choice.tools.values()) {
          if (tool.item === undefined) throw new TypeError('Completed tool calls require a name');
          if (tool.wrapped) b.assign(['choices', index, 'items', tool.item, 'input'], unwrapCustomToolInput(tool.arguments));
        }
        closeMessage(index, choice);
        for (let item = 0; item < b.state.choices[index].items.length; item++) closeItem(index, choice, item);
        b.event({ type: 'choice_end', choice: index, finish_reason: entry.finish_reason === 'function_call' ? 'tool_calls' : entry.finish_reason });
        choice.ended = true;
        choice.incomplete = entry.finish_reason === 'length';
      }
    }
    yield b.drain();
  }
  yield finish();
};
