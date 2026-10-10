import { unwrapCustomToolInput } from '../../../openai-responses-via/custom-tool-wrap.ts';
import { registerIAT, type IATSource } from '../../iat.ts';
import type { IRMessageItem } from '../../ir.ts';
import { buildOpenAIChatCompletionsThinAssistantTurn } from '../../round-trip/openai-chat-completions.ts';
import type { IRRoundTripReader } from '../../round-trip/stream.ts';
import { codePointRangeToIR } from '../../shared/coordinates.ts';
import { createIRJSONObjectDraft } from '../../shared/json.ts';
import { usageToIR, type IRWire } from '../../shared/usage.ts';
import { createIRBuilder, getIRValue, reconcileIRValue, type IRFrame, type IRPath } from '../../stream.ts';
import type { IATReference } from '../../thin-types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { createOpenAIChatCompletionsReassembler, type OpenAIChatCompletionsAssistantOutputMessageEx, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

type IRChatReasoningField = 'reasoning_text' | 'reasoning_content' | 'reasoning';
interface IRChatReasoningSources { viewLength: number; sources: IATSource[] }
interface IRChatPendingSource { sourceStart: number; sourceEndExclusive: number; viewStart: number }
interface IRChatTool { item?: number; id?: string; name: string; arguments: string; nativeArgumentViewLength: number; custom: boolean; wrapped: boolean; pendingSources: IRChatPendingSource[]; sources: IATSource[]; draft: ReturnType<typeof createIRJSONObjectDraft> }
interface IRChatChoice {
  message?: number;
  text?: number;
  refusal?: number;
  audio?: number;
  reasoning?: number;
  tools: Map<number, IRChatTool>;
  annotations: IRWire[];
  closed: Set<number>;
  contentSources: IATSource[];
  contentViewLength: number;
  refusalSources: IATSource[];
  refusalViewLength: number;
  reasoningSources: Map<IRChatReasoningField, IRChatReasoningSources>;
  ended: boolean;
  incomplete: boolean;
}

const appendWithSource = (builder: ReturnType<typeof createIRBuilder>, path: IRPath, text: string, sources: IATSource[], viewStart: number): void => {
  const sourceStart = (getIRValue(builder.state, path) as string).length;
  builder.append(path, text);
  sources.push({ path, sourceStart, sourceEndExclusive: sourceStart + text.length, viewStart });
};

export const irFromOpenAIChatCompletions = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
  options: { customToolNames?: ReadonlySet<string>; roundTrip?: IRRoundTripReader<'openaiChatCompletions'> } = {},
): AsyncGenerator<IRFrame> {
  const b = createIRBuilder();
  const choices = new Map<number, IRChatChoice>();
  const nativeReassembler = options.roundTrip === undefined ? undefined : createOpenAIChatCompletionsReassembler();
  b.assign(['extensions', 'openaiChatCompletions'], {});
  let started = false;
  const closeItem = (index: number, choice: IRChatChoice, item: number, status: 'completed' | 'incomplete' = 'completed'): void => {
    if (choice.closed.has(item)) return;
    const value = b.state.choices[index].items[item];
    if (value.type === 'message') for (let p = 0; p < value.content.length; p++) b.event({ type: 'part_end', choice: index, item, part: p });
    b.event({ type: 'item_end', choice: index, item, status });
    choice.closed.add(item);
  };
  const closeMessage = (index: number, choice: IRChatChoice, status: 'completed' | 'incomplete' = 'completed'): void => {
    if (choice.message === undefined) return;
    if (choice.text !== undefined && choice.annotations.length > 0) {
      const item = b.state.choices[index].items[choice.message] as IRMessageItem;
      const text = (item.content[choice.text] as Extract<IRMessageItem['content'][number], { type: 'text' }>).text;
      b.assign(['choices', index, 'items', choice.message, 'content', choice.text, 'annotations'], choice.annotations.map(a => ({ type: 'source_citation', source_kind: 'url', source: a.url_citation.url, source_label: a.url_citation.title, output_text_range: codePointRangeToIR(text, a.url_citation.start_index, a.url_citation.end_index) })));
    }
    closeItem(index, choice, choice.message, status);
    choice.message = choice.text = choice.refusal = choice.audio = undefined;
    choice.annotations = [];
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
    const nativeChunk = frame.event as unknown as OpenAIChatCompletionsStreamEvent;
    const chunk = frame.event as unknown as IRWire;
    if (chunk.error !== undefined) { b.event({ type: 'error', error: chunk.error }); yield b.drain(); return; }
    nativeReassembler?.accept(nativeChunk);
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
      if (choice === undefined) { choice = { tools: new Map(), annotations: [], closed: new Set(), contentSources: [], contentViewLength: 0, refusalSources: [], refusalViewLength: 0, reasoningSources: new Map(), ended: false, incomplete: false }; choices.set(index, choice); }
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
        return ['choices', index, 'items', choice!.message, 'content', choice![kind]!];
      };
      let processedReasoningField: IRChatReasoningField | undefined;
      for (const key of ['reasoning_text', 'reasoning_content', 'reasoning']) if (typeof delta[key] === 'string' && delta[key] !== '') {
        closeMessage(index, choice);
        choice.reasoning ??= b.item(index, { type: 'reasoning', summary: [''] });
        const field = key as IRChatReasoningField;
        processedReasoningField = field;
        break;
      }
      for (const key of ['reasoning_text', 'reasoning_content', 'reasoning'] as const) if (typeof delta[key] === 'string' && delta[key] !== '') {
        const field = key as IRChatReasoningField;
        const sources = choice.reasoningSources.get(field) ?? { viewLength: 0, sources: [] };
        if (field === processedReasoningField) {
          const path: IRPath = ['choices', index, 'items', choice.reasoning!, 'summary', 0];
          appendWithSource(b, path, delta[key], sources.sources, sources.viewLength);
        }
        sources.viewLength += delta[key].length;
        choice.reasoningSources.set(field, sources);
      }
      if (delta.reasoning_opaque != null) {
        choice.reasoning ??= b.item(index, { type: 'reasoning', summary: [''] });
        b.assign(['choices', index, 'items', choice.reasoning, 'encrypted_content'], delta.reasoning_opaque);
      }
      if (typeof delta.content === 'string' && delta.content !== '') {
        const path = [...part('text'), 'text'];
        appendWithSource(b, path, delta.content, choice.contentSources, choice.contentViewLength);
        choice.contentViewLength += delta.content.length;
      }
      if (typeof delta.refusal === 'string' && delta.refusal !== '') {
        const path = [...part('refusal'), 'refusal'];
        appendWithSource(b, path, delta.refusal, choice.refusalSources, choice.refusalViewLength);
        choice.refusalViewLength += delta.refusal.length;
      }
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
        let tool = choice.tools.get(call.index);
        const fn = call.custom ?? call.function;
        const argument = fn?.arguments ?? fn?.input ?? '';
        const nativeArgumentParts = [call.function?.arguments, call.custom?.input].filter((value): value is string => typeof value === 'string');
        const nativeArgumentViewStart = (tool?.nativeArgumentViewLength ?? 0) + (call.custom === undefined ? 0 : call.function?.arguments?.length ?? 0);
        if (tool?.item !== undefined && choice.closed.has(tool.item)) {
          tool.nativeArgumentViewLength += nativeArgumentParts.reduce((length, value) => length + value.length, 0);
          console.warn('Ignoring ChatCompletions update for a closed tool call', { choice: index, tool: call.index });
          continue;
        }
        if (tool === undefined) {
          closeMessage(index, choice);
          closeReasoning(index, choice);
          tool = { name: '', arguments: '', nativeArgumentViewLength: 0, custom: call.type === 'custom' || call.custom !== undefined, wrapped: false, pendingSources: [], sources: [], draft: createIRJSONObjectDraft() };
          choice.tools.set(call.index, tool);
        }
        if (call.id !== undefined) tool.id = call.id;
        if (call.index === -1) tool.id ??= `${chunk.id}_${index}_function`;
        if (fn?.name !== undefined) tool.name = fn.name;
        const previousArgumentLength = tool.arguments.length;
        tool.arguments += argument;
        const complete = !tool.custom && tool.draft.append(argument);
        tool.wrapped = !tool.custom && options.customToolNames?.has(tool.name) === true;
        tool.nativeArgumentViewLength += nativeArgumentParts.reduce((length, value) => length + value.length, 0);
        const created = tool.item === undefined && tool.name !== '';
        if (created) tool.item = b.item(index, tool.custom || tool.wrapped ? { type: 'custom_tool_call', call_id: tool.id ?? '', name: tool.name, input: tool.wrapped ? '' : tool.arguments } : { type: 'function_call', name: tool.name, ...(tool.id === undefined ? {} : { call_id: tool.id }), arguments: tool.arguments });
        if (tool.item === undefined && argument.length > 0) {
          tool.pendingSources.push({ sourceStart: previousArgumentLength, sourceEndExclusive: tool.arguments.length, viewStart: nativeArgumentViewStart });
        } else if (tool.item !== undefined && created && !tool.wrapped) {
          const field = tool.custom ? 'input' : 'arguments';
          const argumentPath: IRPath = ['choices', index, 'items', tool.item, field];
          tool.sources.push(...tool.pendingSources.map(source => ({ path: argumentPath, ...source })));
          if (argument.length > 0) tool.sources.push({ path: argumentPath, sourceStart: previousArgumentLength, sourceEndExclusive: tool.arguments.length, viewStart: nativeArgumentViewStart });
          tool.pendingSources = [];
        } else if (tool.item !== undefined && !created) {
          const path: IRPath = ['choices', index, 'items', tool.item];
          if (tool.id !== undefined) b.assign([...path, 'call_id'], tool.id);
          b.assign([...path, 'name'], tool.name);
          if (!tool.wrapped) {
            const field = tool.custom ? 'input' : 'arguments';
            const argumentPath = [...path, field];
            const previousArguments = getIRValue(b.state, argumentPath) as string;
            reconcileIRValue(b, argumentPath, previousArguments, tool.arguments);
            if (tool.arguments.length > previousArguments.length) tool.sources.push({ path: argumentPath, sourceStart: previousArguments.length, sourceEndExclusive: tool.arguments.length, viewStart: nativeArgumentViewStart });
          }
        }
        if (tool.item !== undefined && complete && tool.id !== undefined) {
          if (tool.wrapped) b.assign(['choices', index, 'items', tool.item, 'input'], unwrapCustomToolInput(tool.arguments));
          closeItem(index, choice, tool.item);
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
          if (tool.id === undefined) throw new TypeError('Completed tool calls require an id');
          if (tool.wrapped && !choice.closed.has(tool.item)) b.assign(['choices', index, 'items', tool.item, 'input'], unwrapCustomToolInput(tool.arguments));
        }
        closeMessage(index, choice, entry.finish_reason === 'length' ? 'incomplete' : 'completed');
        for (let item = 0; item < b.state.choices[index].items.length; item++) closeItem(index, choice, item, entry.finish_reason === 'length' ? 'incomplete' : 'completed');
        const roundTrip = options.roundTrip;
        if (roundTrip !== undefined && nativeReassembler !== undefined) {
          const nativeMessage = nativeReassembler.choiceMessage(index) as OpenAIChatCompletionsAssistantOutputMessageEx;
          const referencesByProtocolPath = new Map<string, IATReference>();
          const addTextReference = (nativePath: IRPath, sources: readonly IATSource[], view: string): void => {
            if (view.length === 0 || sources.length === 0) return;
            const iatNativePath: IRPath = ['choices', index, 'message', ...nativePath];
            const reference = registerIAT(roundTrip.iat, iatNativePath, sources, view, view, 'text');
            referencesByProtocolPath.set(JSON.stringify(nativePath), reference);
          };
          if (typeof nativeMessage.content === 'string') addTextReference(['content'], choice.contentSources, nativeMessage.content);
          if (typeof nativeMessage.refusal === 'string') addTextReference(['refusal'], choice.refusalSources, nativeMessage.refusal);
          for (const field of ['reasoning_text', 'reasoning_content', 'reasoning'] as const) {
            const source = choice.reasoningSources.get(field);
            const value = nativeMessage[field];
            if (source !== undefined && typeof value === 'string') addTextReference([field], source.sources, value);
          }
          const orderedTools = [...choice.tools.entries()].filter(([toolIndex]) => toolIndex !== -1).toSorted(([left], [right]) => left - right);
          nativeMessage.tool_calls?.forEach((call, callIndex) => {
            const tool = orderedTools[callIndex]?.[1];
            if (tool === undefined) return;
            const view = call.type === 'function' ? call.function.arguments : call.custom.input;
            const nativePath: IRPath = ['tool_calls', callIndex, call.type === 'function' ? 'function' : 'custom', call.type === 'function' ? 'arguments' : 'input'];
            addTextReference(nativePath, tool.sources, view);
          });
          const legacyFunction = choice.tools.get(-1);
          if (legacyFunction !== undefined && nativeMessage.function_call !== undefined && nativeMessage.function_call !== null) {
            addTextReference(['function_call', 'arguments'], legacyFunction.sources, nativeMessage.function_call.arguments);
          }
          roundTrip.onAssistantTurn(index, buildOpenAIChatCompletionsThinAssistantTurn(nativeMessage, referencesByProtocolPath));
        }
        b.event({ type: 'choice_end', choice: index, finish_reason: entry.finish_reason === 'function_call' ? 'tool_calls' : entry.finish_reason });
        choice.ended = true;
        choice.incomplete = entry.finish_reason === 'length';
      }
    }
    yield b.drain();
  }
  yield finish();
};
