import { createIRCollector, type IRCollector } from './collector.ts';
import type { IRRecord } from './records.ts';

// Applies each record to a fresh collector and yields it together with the collector, so a
// writer sees the state as of that record. A well-formed stream is exactly one `start`, then
// records, then `finish` or `error`.
export const consumeIRRecords = async function* (records: AsyncIterable<IRRecord>): AsyncGenerator<{ record: IRRecord; collector: IRCollector }> {
  const collector = createIRCollector();
  let started = false;
  let finished = false;
  for await (const record of records) {
    if (finished) throw new Error('IR record arrived after finish');
    if (record.type === 'write') {
      collector.applyWrite(record);
    } else {
      if (record.type === 'start') {
        if (started) throw new Error('Duplicate IR start');
        started = true;
      } else if (record.type === 'finish') {
        if (!started) throw new Error('IR finish arrived before start');
        finished = true;
      } else if (record.type === 'error') {
        finished = true;
      }
      collector.applyEvent(record);
    }
    yield { record, collector };
  }
  if (!finished) throw new Error('IR stream ended without finish');
};
