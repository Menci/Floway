import type { IR, IRProtocol } from './ir.ts';
import { applyIROperation, type IRFrame, type IRPath, type IRRecord } from './stream.ts';

export interface IRStringProjection {
  source_path: IRPath;
  source_start: number;
  source_end_exclusive: number;
  target_path: IRPath;
  target_start: number;
  target_end_exclusive: number;
  round_trip: boolean;
}
export interface IRProjectedContent { path: IRPath; text: string; round_trip: boolean }
export interface IRProjectionResult { contents: IRProjectedContent[]; projections: IRStringProjection[] }
export interface IROutputOptions {
  id: string;
  model: string;
  created: number;
  onProjection?: (result: IRProjectionResult) => void;
}

export const createIRProjection = () => {
  const previous = new Map<string, string>();
  const contents = new Map<string, IRProjectedContent>();
  const projections: IRStringProjection[] = [];
  const append = (source: IRPath, text: string, target: IRPath, roundTrip: boolean, allowReplacement = false): string => {
    const sourceKey = JSON.stringify(source);
    const old = previous.get(sourceKey) ?? '';
    if (!text.startsWith(old)) {
      if (allowReplacement) { assign(source, text, target, roundTrip); previous.set(sourceKey, text); return ''; }
      if (source.at(-1) === 'arguments') {
        const parsed: unknown = JSON.parse(old);
        if (JSON.stringify(parsed) === text) return '';
      }
      throw new Error(`Downstream SSE cannot replace emitted text at ${sourceKey}`);
    }
    const delta = text.slice(old.length);
    previous.set(sourceKey, text);
    const key = JSON.stringify(target);
    let content = contents.get(key);
    if (content === undefined) { content = { path: target, text: '', round_trip: roundTrip }; contents.set(key, content); }
    if (delta !== '') {
      projections.push({ source_path: source, source_start: old.length, source_end_exclusive: text.length, target_path: target, target_start: content.text.length, target_end_exclusive: content.text.length + delta.length, round_trip: roundTrip });
      content.text += delta;
    }
    return delta;
  };
  const assign = (source: IRPath, text: string, target: IRPath, roundTrip: boolean): void => {
    const key = JSON.stringify(target);
    contents.set(key, { path: target, text, round_trip: roundTrip });
    for (let i = projections.length - 1; i >= 0; i--) if (JSON.stringify(projections[i].target_path) === key) projections.splice(i, 1);
    projections.push({ source_path: source, source_start: 0, source_end_exclusive: text.length, target_path: target, target_start: 0, target_end_exclusive: text.length, round_trip: roundTrip });
  };
  const result = (): IRProjectionResult => structuredClone({ contents: [...contents.values()], projections });
  return { append, assign, result };
};

export const consumeIRRecords = async function* (frames: AsyncIterable<IRFrame>): AsyncGenerator<{ state: IR; record: IRRecord }> {
  const state: IR = { choices: [], extensions: {} };
  let started = false;
  let finished = false;
  for await (const frame of frames) for (const record of frame.records) {
    if (finished) throw new Error('IR record arrived after finish');
    if (record.type === 'operation') applyIROperation(state, record);
    else if (record.type === 'start') {
      if (started) throw new Error('Duplicate IR start');
      started = true;
    } else if (record.type === 'finish') {
      if (!started) throw new Error('IR finish arrived before start');
      finished = true;
    } else if (record.type === 'error') throw new Error('IR upstream error', { cause: record.error });
    yield { state, record };
  }
  if (!finished) throw new Error('IR stream ended without finish');
};

export const irProtocolExtension = (state: IR, protocol: IRProtocol): Record<string, unknown> => state.extensions?.[protocol] ?? {};
