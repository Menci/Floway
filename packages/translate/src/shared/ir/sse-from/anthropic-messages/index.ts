import { unwrapCustomToolInput } from '../../../openai-responses-via/custom-tool-wrap.ts';
import type { IRItem, IRSourceCitation } from '../../ir.ts';
import { cloneIRJSON, parseIRJSONObject } from '../../shared/json.ts';
import { createIRBuilder, reconcileIRValue, type IRFrame } from '../../stream.ts';
import { usageToIR, type IRWire } from '../../shared/usage.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

export const messagesCitationToIR = (citation: IRWire): IRSourceCitation => ({
  type: 'source_citation',
  source_kind: citation.type === 'web_search_result_location' ? 'url' : citation.type === 'search_result_location' ? 'search_result' : 'document',
  ...(citation.url !== undefined ? { source: citation.url } : citation.source !== undefined ? { source: citation.source } : citation.file_id != null ? { source: citation.file_id } : {}),
  ...(citation.title != null || citation.document_title != null ? { source_label: citation.title ?? citation.document_title } : {}),
  source_text: { text: citation.cited_text, granularity: 'exact_quote' },
  ...(citation.type === 'page_location' ? { source_page_range: { start_one_based: citation.start_page_number, end_one_based_exclusive: citation.end_page_number } } : {}),
});

export const messagesBlockToIR = (block: IRWire): IRItem | undefined => {
  switch (block.type) {
  case 'text': return { type: 'message', content: [{ type: 'text', text: block.text, ...(block.citations === undefined ? {} : { annotations: block.citations === null ? null : block.citations.map(messagesCitationToIR) }) }] };
  case 'thinking': return { type: 'reasoning', summary: [block.thinking], encrypted_content: block.signature };
  case 'redacted_thinking': return { type: 'reasoning', encrypted_content: block.data };
  case 'tool_use': return { type: 'function_call', call_id: block.id, name: block.name, arguments: block.inputJson === undefined ? block.input : block.inputJson };
  case 'fallback':
  case 'server_tool_use':
  case 'web_search_tool_result':
  case 'web_fetch_tool_result':
  case 'code_execution_tool_result':
  case 'bash_code_execution_tool_result':
  case 'text_editor_code_execution_tool_result':
  case 'tool_search_tool_result':
  case 'container_upload': return undefined;
  default: throw new TypeError(`Cannot translate Messages content block ${block.type}`);
  }
};

export const irFromAnthropicMessages = async function* (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>, options: { customToolNames?: ReadonlySet<string> } = {}): AsyncGenerator<IRFrame> {
  const b = createIRBuilder();
  b.choice(0);
  b.assign(['extensions', 'anthropicMessages'], {});
  const blocks = new Map<number, IRWire>();
  const indices = new Map<number, number>();
  let usage: IRWire | undefined;
  let finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' = 'stop';
  let finished = false;
  const sync = (index: number, block: IRWire, closed = false): void => {
    const item = block.type === 'tool_use' && options.customToolNames?.has(block.name) ? { type: 'custom_tool_call' as const, call_id: block.id, name: block.name, input: closed ? unwrapCustomToolInput(JSON.stringify(block.input)) : '' } : messagesBlockToIR(block);
    if (item === undefined) return;
    const mapped = indices.get(index);
    if (mapped === undefined) {
      const position = b.item(0, item);
      indices.set(index, position);
      if (item.type === 'message') b.event({ type: 'part_start', choice: 0, item: position, part: 0 });
    } else reconcileIRValue(b, ['choices', 0, 'items', mapped], b.state.choices[0].items[mapped], item);
  };
  for await (const frame of frames) {
    if (frame.type === 'done') throw new Error('Messages done arrived without message_stop');
    const e = frame.event as unknown as IRWire;
    switch (e.type) {
    case 'message_start':
      if (usage !== undefined) throw new Error('Duplicate Messages message_start');
      b.event({ type: 'start', id: e.message.id, model: e.message.model });
      for (const [key, value] of Object.entries(e.message)) if (!['content', 'usage'].includes(key)) b.assign(['extensions', 'anthropicMessages', key], value);
      usage = cloneIRJSON(e.message.usage);
      b.assign(['usage'], usageToIR('anthropicMessages', usage!));
      b.assign(['extensions', 'anthropicMessages', 'usage'], usage);
      break;
    case 'content_block_start':
      if (e.content_block.type === 'fallback') b.assign(['extensions', 'anthropicMessages', 'model'], e.content_block.to.model);
      blocks.set(e.index, cloneIRJSON(e.content_block)); sync(e.index, blocks.get(e.index)!); break;
    case 'content_block_delta': {
      const block = blocks.get(e.index);
      if (block === undefined) throw new Error('Messages delta arrived before content_block_start');
      const d = e.delta;
      switch (d.type) {
      case 'text_delta': block.text += d.text; break;
      case 'thinking_delta': block.thinking += d.thinking; break;
      case 'signature_delta': block.signature = d.signature; break;
      case 'input_json_delta': block.inputJson = (block.inputJson ?? '') + d.partial_json; break;
      case 'citations_delta': (block.citations ??= []).push(cloneIRJSON(d.citation)); break;
      default: throw new TypeError(`Cannot translate Messages delta ${d.type}`);
      }
      sync(e.index, block); break;
    }
    case 'content_block_stop': {
      const block = blocks.get(e.index);
      if (block === undefined) throw new Error('Messages content_block_stop arrived before content_block_start');
      if (block.type === 'tool_use' && block.inputJson !== undefined) {
        const parsed = parseIRJSONObject(block.inputJson);
        block.input = parsed; delete block.inputJson;
      } else if (block.type === 'tool_use') parseIRJSONObject(JSON.stringify(block.input));
      if (block.type === 'tool_use') sync(e.index, block, true);
      const index = indices.get(e.index);
      if (index !== undefined) {
        if (b.state.choices[0].items[index].type === 'message') b.event({ type: 'part_end', choice: 0, item: index, part: 0 });
        b.event({ type: 'item_end', choice: 0, item: index });
      }
      break;
    }
    case 'message_delta':
      if (usage === undefined) throw new Error('Messages message_delta arrived before message_start');
      for (const [key, value] of Object.entries(e.usage)) if (value != null) usage[key] = key === 'cache_creation' ? { ...usage.cache_creation, ...value as IRWire } : value;
      b.assign(['usage'], usageToIR('anthropicMessages', usage));
      b.assign(['extensions', 'anthropicMessages', 'usage'], usage);
      if (e.delta.stop_reason === 'compaction') throw new TypeError('Cannot translate Messages compaction stop');
      if (e.delta.stop_reason === 'refusal') b.assign(['choices', 0, 'refusal'], { category: e.delta.stop_details?.category ?? null, explanation: e.delta.stop_details?.explanation ?? null });
      for (const [key, value] of Object.entries(e.delta)) b.assign(['extensions', 'anthropicMessages', key], value);
      if (e.delta.stop_reason != null) finishReason = e.delta.stop_reason === 'max_tokens' || e.delta.stop_reason === 'model_context_window_exceeded' ? 'length' : e.delta.stop_reason === 'tool_use' ? 'tool_calls' : e.delta.stop_reason === 'refusal' ? 'content_filter' : 'stop';
      break;
    case 'message_stop':
      if (usage === undefined) throw new Error('Messages message_stop arrived before message_start');
      b.event({ type: 'choice_end', choice: 0, finish_reason: finishReason });
      b.event({ type: 'finish', status: finishReason === 'length' ? 'incomplete' : 'completed' }); finished = true; break;
    case 'error': b.event({ type: 'error', error: e.error }); yield b.drain(); return;
    case 'ping': b.event({ type: 'ping' }); break;
    }
    yield b.drain();
    if (finished) return;
  }
  throw new Error('Messages stream ended without message_stop');
};
