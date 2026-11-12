import { createIRBuilder } from '../../../src/ir/output/builder.ts';
import type { IRRecord } from '../../../src/ir/output/records.ts';
import { consumeIRRecords } from '../../../src/ir/output/stream.ts';
import type { IROutput, IROutputItem } from '../../../src/ir/output/types.ts';

export const completeIR = (value: readonly IROutputItem[]): IRRecord[] => {
  const b = createIRBuilder();
  b.choice(0);
  b.assign(['model'], 'model');
  b.event({ type: 'start', id: 'source' });
  for (const item of value) {
    const index = b.state.choices[0].items.length;
    const path = ['choices', 0, 'items', index] as const;
    if (item.type === 'message') {
      b.initialize(path, { type: 'message', content: [] });
      item.content.forEach((part, partIndex) => {
        const partPath = [...path, 'content', partIndex] as const;
        if (part.type === 'text') {
          b.initialize(partPath, { type: 'text', text: '', ...(part.annotations === undefined ? {} : { annotations: part.annotations }) });
          b.append([...partPath, 'text'], part.text);
        } else if (part.type === 'refusal') {
          b.initialize(partPath, { type: 'refusal', refusal: '' });
          b.append([...partPath, 'refusal'], part.refusal);
        } else if (part.type === 'image') b.initialize(partPath, part);
        else {
          b.initialize(partPath, { type: 'audio', audio: { ...(part.audio.media_type === undefined ? {} : { media_type: part.audio.media_type }) } });
          for (const field of ['data', 'transcript'] as const) if (part.audio[field] !== undefined) {
            const value = part.audio[field];
            if (value === undefined) continue;
            b.initialize([...partPath, 'audio', field], '');
            b.append([...partPath, 'audio', field], value);
          }
        }
        b.event({ type: 'part_end', choice: 0, item: index, part: partIndex });
      });
    } else if (item.type === 'reasoning') {
      b.initialize(path, { type: 'reasoning', ...(item.summary === undefined ? {} : { summary: item.summary.map(() => '') }), ...(item.content === undefined ? {} : { content: item.content.map(() => '') }) });
      item.summary?.forEach((text, part) => b.append([...path, 'summary', part], text));
      item.content?.forEach((text, part) => b.append([...path, 'content', part], text));
    } else if (item.type === 'function_call') {
      b.initialize(path, { type: 'function_call', ...(item.call_id === undefined ? {} : { call_id: item.call_id }), name: item.name, arguments: '' });
      b.append([...path, 'arguments'], item.arguments);
    } else {
      b.initialize(path, { type: 'custom_tool_call', ...(item.call_id === undefined ? {} : { call_id: item.call_id }), name: item.name, input: '' });
      b.append([...path, 'input'], item.input);
    }
    b.event({ type: 'item_end', choice: 0, item: index });
  }
  b.event({ type: 'choice_end', choice: 0, finish_reason: 'stop' });
  b.event({ type: 'finish', status: 'completed' });
  return [...b.drain()];
};

export const collectIR = async (records: AsyncIterable<IRRecord>): Promise<IROutput> => {
  let state: IROutput = { choices: [] };
  for await (const value of consumeIRRecords(records)) {
    state = value.collector.state;
    if (value.record.type === 'error') throw new Error('output IR generation failed', { cause: value.record.error });
  }
  return state;
};
