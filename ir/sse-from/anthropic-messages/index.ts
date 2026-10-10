import type { IRItem, IRSourceCitation } from '../../ir.ts';
import { cloneIRJSON, parseIRJSONObject } from '../../json.ts';
import { createIRBuilder, reconcileIRValue, type IRFrame } from '../../stream.ts';
import { usageToIR, type IRWire } from '../../usage.ts';
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
  case 'thinking': return { type: 'reasoning', content: [block.thinking], encrypted_content: block.signature };
  case 'redacted_thinking': return { type: 'reasoning', encrypted_content: block.data };
  case 'tool_use': return { type: 'function_call', call_id: block.id, name: block.name, arguments: block.inputJson === undefined ? block.input : block.inputJson };
  default: return undefined;
  }
};

export const irFromAnthropicMessages = async function* (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>): AsyncGenerator<IRFrame> {
  const b = createIRBuilder();
  b.choice(0);
  b.assign(['extensions', 'anthropicMessages'], {});
  const blocks = new Map<number, IRWire>();
  const indices = new Map<number, number>();
  let usage: IRWire | undefined;
  let finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' = 'stop';
  let finished = false;
  const sync = (index: number, block: IRWire): void => {
    const item = messagesBlockToIR(block);
    if (item === undefined) return;
    const mapped = indices.get(index);
    if (mapped === undefined) {
      const position = b.item(0, item);
      indices.set(index, position);
      if (item.type === 'message') b.event({ type: 'part_start', choice: 0, item: position, part: 0 });
    } else reconcileIRValue(b, ['choices', 0, 'items', mapped], b.state.choices[0].items[mapped], item);
  };
  for await (const frame of frames) {
    if (frame.type === 'done') { if (!finished) throw new Error('Messages done arrived without message_stop'); continue; }
    if (finished) throw new Error('Messages event arrived after message_stop');
    const e = frame.event as unknown as IRWire;
    switch (e.type) {
    case 'message_start':
      if (usage !== undefined) throw new Error('Duplicate Messages message_start');
      b.event({ type: 'start', id: e.message.id, model: e.message.model });
      for (const [key, value] of Object.entries(e.message)) if (!['content', 'usage'].includes(key)) b.assign(['extensions', 'anthropicMessages', key], value);
      usage = cloneIRJSON(e.message.usage);
      b.assign(['usage'], usageToIR('anthropicMessages', usage!));
      break;
    case 'content_block_start':
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
      case 'compaction_delta': block.content = d.content; if (d.encrypted_content !== undefined) block.encrypted_content = d.encrypted_content; break;
      }
      sync(e.index, block); break;
    }
    case 'content_block_stop': {
      const block = blocks.get(e.index);
      if (block === undefined) throw new Error('Messages content_block_stop arrived before content_block_start');
      if (block.type === 'tool_use' && block.inputJson !== undefined) {
        const parsed = parseIRJSONObject(block.inputJson);
        block.input = parsed; delete block.inputJson; sync(e.index, block);
      }
      const index = indices.get(e.index);
      if (index !== undefined) {
        if (b.state.choices[0].items[index].type === 'message') b.event({ type: 'part_end', choice: 0, item: index, part: 0 });
        b.event({ type: 'item_end', choice: 0, item: index });
      }
      break;
    }
    case 'message_delta':
      if (usage === undefined) throw new Error('Messages message_delta arrived before message_start');
      for (const [key, value] of Object.entries(e.usage)) if (value != null) usage[key] = value;
      b.assign(['usage'], usageToIR('anthropicMessages', usage));
      for (const [key, value] of Object.entries(e.delta)) b.assign(['extensions', 'anthropicMessages', key], value);
      if (e.delta.stop_reason != null) finishReason = e.delta.stop_reason === 'max_tokens' || e.delta.stop_reason === 'model_context_window_exceeded' ? 'length' : e.delta.stop_reason === 'tool_use' ? 'tool_calls' : e.delta.stop_reason === 'refusal' ? 'content_filter' : 'stop';
      break;
    case 'message_stop':
      if (usage === undefined) throw new Error('Messages message_stop arrived before message_start');
      b.event({ type: 'choice_end', choice: 0, finish_reason: finishReason });
      b.event({ type: 'finish', status: finishReason === 'length' ? 'incomplete' : 'completed' }); finished = true; break;
    case 'error': throw new Error('Messages upstream error', { cause: e.error });
    case 'ping': b.event({ type: 'ping' }); break;
    }
    yield b.drain();
  }
  if (!finished) throw new Error('Messages stream ended without message_stop');
};
