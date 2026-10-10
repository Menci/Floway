import { unwrapCustomToolInput } from '../../../openai-responses-via/custom-tool-wrap.ts';
import type { IRMessageItem } from '../../ir.ts';
import { codePointRangeToIR } from '../../shared/coordinates.ts';
import { createIRJSONObjectDraft } from '../../shared/json.ts';
import { usageToIR, type IRWire } from '../../shared/usage.ts';
import { createIRBuilder, reconcileIRValue, type IRFrame, type IRPath } from '../../stream.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

interface IRChatTool { item?: number; id?: string; name: string; arguments: string; custom: boolean; wrapped: boolean; draft: ReturnType<typeof createIRJSONObjectDraft> }
interface IRChatTextSpan { item: number; part: number; start: number; end: number }
interface IRChatChoice {
  message?: number;
  text?: number;
  refusal?: number;
  audio?: number;
  reasoning?: number;
  tools: Map<number, IRChatTool>;
  annotations: IRWire[];
  contentText: string;
  textSpans: IRChatTextSpan[];
  logprobPaths: Map<string, IRPath>;
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
  const syncAnnotations = (index: number, choice: IRChatChoice): void => {
    const citations = choice.annotations.map(annotation => ({ annotation, range: codePointRangeToIR(choice.contentText, annotation.url_citation.start_index, annotation.url_citation.end_index) }));
    for (const span of choice.textSpans) {
      const annotations = citations.flatMap(({ annotation, range }) => {
        const start = Math.max(range.start, span.start);
        const end = Math.min(range.end_exclusive, span.end);
        return start >= end ? [] : [{ type: 'source_citation', source_kind: 'url', source: annotation.url_citation.url, source_label: annotation.url_citation.title, output_text_range: { start: start - span.start, end_exclusive: end - span.start } }];
      });
      const part = (b.state.choices[index].items[span.item] as IRMessageItem).content[span.part];
      if (part.type !== 'text') throw new TypeError('ChatCompletions citation span requires a text part');
      if (annotations.length > 0 || part.annotations !== undefined) reconcileIRValue(b, ['choices', index, 'items', span.item, 'content', span.part, 'annotations'], part.annotations, annotations);
    }
  };
  const closeItem = (index: number, choice: IRChatChoice, item: number, status: 'completed' | 'incomplete' = 'completed'): void => {
    if (choice.closed.has(item)) return;
    const value = b.state.choices[index].items[item];
    if (value.type === 'message') for (let p = 0; p < value.content.length; p++) b.event({ type: 'part_end', choice: index, item, part: p });
    b.event({ type: 'item_end', choice: index, item, status });
    choice.closed.add(item);
  };
  const closeMessage = (index: number, choice: IRChatChoice, status: 'completed' | 'incomplete' = 'completed'): void => {
    if (choice.message === undefined) return;
    if (choice.annotations.length > 0) syncAnnotations(index, choice);
    closeItem(index, choice, choice.message, status);
    choice.message = choice.text = choice.refusal = choice.audio = undefined;
  };
  const closeReasoning = (index: number, choice: IRChatChoice): void => {
    if (choice.reasoning === undefined) return;
    closeItem(index, choice, choice.reasoning);
    choice.reasoning = undefined;
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
    for (const [key, value] of Object.entries(chunk)) if (!['choices', 'usage', 'object', 'obfuscation'].includes(key)) b.assign(['extensions', 'openaiChatCompletions', key], value);
    if (chunk.usage != null) {
      const usage = usageToIR('openaiChatCompletions', chunk.usage);
      b.assign(['usage'], { ...b.state.usage, ...usage });
    }
    if (!started) { b.event({ type: 'start', id: chunk.id, model: chunk.model, created: chunk.created }); started = true; }
    for (const entry of chunk.choices) {
      const index = entry.index as number;
      b.choice(index);
      let choice = choices.get(index);
      if (choice === undefined) { choice = { tools: new Map(), annotations: [], contentText: '', textSpans: [], logprobPaths: new Map(), closed: new Set(), ended: false, incomplete: false }; choices.set(index, choice); }
      const delta = entry.delta as IRWire;
      const part = (kind: 'text' | 'refusal' | 'audio'): IRPath => {
        closeReasoning(index, choice!);
        choice!.message ??= b.item(index, { type: 'message', content: [] });
        const item = b.state.choices[index].items[choice!.message] as IRMessageItem;
        if (choice![kind] === undefined) {
          choice![kind] = item.content.length;
          b.append(['choices', index, 'items', choice!.message, 'content'], [kind === 'audio' ? { type: 'audio', audio: { data: '', transcript: '' } } : { type: kind, [kind]: '' }]);
          b.event({ type: 'part_start', choice: index, item: choice!.message, part: choice![kind]! });
        }
        const path: IRPath = ['choices', index, 'items', choice!.message, 'content', choice![kind]!];
        if (kind !== 'audio') choice!.logprobPaths.set(kind === 'text' ? 'content' : 'refusal', path);
        return path;
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
      if (typeof delta.content === 'string' && delta.content !== '') {
        const path = part('text');
        const start = choice.contentText.length;
        choice.contentText += delta.content;
        b.append([...path, 'text'], delta.content);
        const span = choice.textSpans.at(-1);
        if (span?.item === path[3] && span.part === path[5]) span.end = choice.contentText.length;
        else choice.textSpans.push({ item: path[3] as number, part: path[5] as number, start, end: choice.contentText.length });
      }
      if (typeof delta.refusal === 'string' && delta.refusal !== '') b.append([...part('refusal'), 'refusal'], delta.refusal);
      if (delta.audio != null) {
        const path = [...part('audio'), 'audio'];
        for (const field of ['data', 'transcript']) if (delta.audio[field] !== undefined) b.append([...path, field], delta.audio[field]);
        const metadata = { ...delta.audio }; delete metadata.data; delete metadata.transcript;
        const extension = b.state.extensions!.openaiChatCompletions as IRWire;
        if (extension.choices === undefined) b.assign(['extensions', 'openaiChatCompletions', 'choices'], []);
        while (extension.choices.length <= index) b.append(['extensions', 'openaiChatCompletions', 'choices'], [{ message: { audio: {} } }]);
        b.assign(['extensions', 'openaiChatCompletions', 'choices', index, 'message', 'audio'], { ...extension.choices[index].message.audio, ...metadata });
      }
      if (delta.annotations != null) { choice.annotations = delta.annotations; syncAnnotations(index, choice); }
      if (entry.logprobs != null) {
        if (b.state.choices[index].logprobs == null) b.assign(['choices', index, 'logprobs'], []);
        for (const kind of ['content', 'refusal']) if (entry.logprobs[kind]?.length > 0) {
          const path = choice.logprobPaths.get(kind);
          if (path === undefined) throw new TypeError('ChatCompletions logprobs require a matching text part');
          const groups = b.state.choices[index].logprobs!;
          let group = groups.findIndex(g => g.scope === 'text_part' && g.item_index === path[3] && g.content_index === path[5]);
          if (group < 0) { group = groups.length; b.append(['choices', index, 'logprobs'], [{ scope: 'text_part', item_index: path[3], content_index: path[5], tokens: [] }]); }
          b.append(['choices', index, 'logprobs', group, 'tokens'], entry.logprobs[kind]);
        }
      }
      const calls = [...(delta.tool_calls ?? []), ...(delta.function_call === undefined ? [] : [{ index: -1, type: 'function', function: delta.function_call }])];
      for (const call of calls) {
        let tool = choice.tools.get(call.index);
        if (tool?.item !== undefined && choice.closed.has(tool.item)) {
          console.warn('Ignoring ChatCompletions update for a closed tool call', { choice: index, tool: call.index });
          continue;
        }
        if (tool === undefined) {
          closeMessage(index, choice);
          closeReasoning(index, choice);
          tool = { name: '', arguments: '', custom: call.type === 'custom' || call.custom !== undefined, wrapped: false, draft: createIRJSONObjectDraft() };
          choice.tools.set(call.index, tool);
        }
        const fn = call.custom ?? call.function;
        if (call.id !== undefined) tool.id = call.id;
        if (call.index === -1) tool.id ??= `${chunk.id}_${index}_function`;
        if (fn?.name !== undefined) tool.name = fn.name;
        const argument = fn?.arguments ?? fn?.input ?? '';
        tool.arguments += argument;
        const complete = !tool.custom && tool.draft.append(argument);
        tool.wrapped = !tool.custom && options.customToolNames?.has(tool.name) === true;
        if (tool.item === undefined && tool.name !== '') tool.item = b.item(index, tool.custom || tool.wrapped ? { type: 'custom_tool_call', call_id: tool.id ?? '', name: tool.name, input: tool.wrapped ? '' : tool.arguments } : { type: 'function_call', name: tool.name, ...(tool.id === undefined ? {} : { call_id: tool.id }), arguments: tool.arguments });
        else if (tool.item !== undefined) {
          const path: IRPath = ['choices', index, 'items', tool.item];
          if (tool.id !== undefined) b.assign([...path, 'call_id'], tool.id);
          b.assign([...path, 'name'], tool.name);
          if (!tool.wrapped) reconcileIRValue(b, [...path, tool.custom ? 'input' : 'arguments'], (b.state.choices[index].items[tool.item] as IRWire)[tool.custom ? 'input' : 'arguments'], tool.arguments);
        }
        if (tool.item !== undefined && complete && tool.id !== undefined) {
          if (tool.wrapped) b.assign(['choices', index, 'items', tool.item, 'input'], unwrapCustomToolInput(tool.arguments));
          closeItem(index, choice, tool.item);
        }
      }
      if (entry.finish_reason != null) {
        for (const tool of choice.tools.values()) {
          if (tool.item === undefined) throw new TypeError('Completed tool calls require a name');
          if (tool.id === undefined) throw new TypeError('Completed tool calls require an id');
          if (tool.wrapped && !choice.closed.has(tool.item)) b.assign(['choices', index, 'items', tool.item, 'input'], unwrapCustomToolInput(tool.arguments));
        }
        closeMessage(index, choice, entry.finish_reason === 'length' ? 'incomplete' : 'completed');
        for (let item = 0; item < b.state.choices[index].items.length; item++) closeItem(index, choice, item, entry.finish_reason === 'length' ? 'incomplete' : 'completed');
        b.event({ type: 'choice_end', choice: index, finish_reason: entry.finish_reason === 'function_call' ? 'tool_calls' : entry.finish_reason });
        choice.ended = true;
        choice.incomplete = entry.finish_reason === 'length';
      }
    }
    yield b.drain();
  }
  yield finish();
};
