import type { IRJSONObject } from '../ir.ts';
import { cloneIRJSON } from './json.ts';
import type { IRTextUpdate } from './text.ts';
import type { IRRoundTripWriter } from '../round-trip/stream.ts';
import type { IRProjectionResult as IRRoundTripProjectionResult } from '../round-trip-projection.ts';
import type { IRPath } from '../stream.ts';
import { parseJSONWithRawNumbers } from '@floway-dev/protocols/common';

export interface IRStringProjection {
  source_path: IRPath;
  source_start: number;
  source_end_exclusive: number;
  target_path: IRPath;
  target_start: number;
  target_end_exclusive: number;
}
export interface IRProjectedContent { path: IRPath; text: string }
export interface IRProjectionResult { contents: IRProjectedContent[]; projections: IRStringProjection[] }
export interface IROutputOptions {
  id?: string;
  created?: number;
  audioMetadata?: (choice: number) => { id: string; expires_at: number };
  parseToolArguments?: (text: string) => IRJSONObject;
  roundTrip?: IRRoundTripWriter;
}

export const createIRProjection = () => {
  const previous = new Map<string, string>();
  const contents = new Map<string, IRProjectedContent>();
  const projections: IRStringProjection[] = [];
  const roundTripTargets = new Set<string>();
  const append = (source: IRPath, text: string, target: IRPath, allowReplacement = false): string => {
    const sourceKey = JSON.stringify(source);
    const old = previous.get(sourceKey) ?? '';
    if (!text.startsWith(old)) {
      if (allowReplacement) { assign(source, text, target); previous.set(sourceKey, text); return ''; }
      if (source.at(-1) === 'arguments') {
        const parsed: unknown = parseJSONWithRawNumbers(old);
        if (JSON.stringify(parsed) === text) return '';
      }
      throw new Error(`Downstream SSE cannot replace emitted text at ${sourceKey}`);
    }
    const delta = text.slice(old.length);
    previous.set(sourceKey, text);
    if (delta === '') return '';
    const key = JSON.stringify(target);
    let content = contents.get(key);
    if (content === undefined) { content = { path: target, text: '' }; contents.set(key, content); }
    const previousProjection = projections.at(-1);
    if (previousProjection !== undefined && JSON.stringify(previousProjection.source_path) === sourceKey && JSON.stringify(previousProjection.target_path) === key && previousProjection.source_end_exclusive === old.length && previousProjection.target_end_exclusive === content.text.length) {
      previousProjection.source_end_exclusive = text.length;
      previousProjection.target_end_exclusive += delta.length;
    } else projections.push({ source_path: source, source_start: old.length, source_end_exclusive: text.length, target_path: target, target_start: content.text.length, target_end_exclusive: content.text.length + delta.length });
    content.text += delta;
    return delta;
  };
  const assign = (source: IRPath, text: string, target: IRPath): void => {
    const key = JSON.stringify(target);
    contents.set(key, { path: target, text });
    for (let i = projections.length - 1; i >= 0; i--) if (JSON.stringify(projections[i].target_path) === key) projections.splice(i, 1);
    projections.push({ source_path: source, source_start: 0, source_end_exclusive: text.length, target_path: target, target_start: 0, target_end_exclusive: text.length });
  };
  const result = (): IRProjectionResult => cloneIRJSON({ contents: [...contents.values()], projections });
  const markRoundTrip = (target: IRPath): void => { roundTripTargets.add(JSON.stringify(target)); };
  const roundTripResult = (): IRRoundTripProjectionResult => {
    const current = result();
    return {
      contents: current.contents.map(content => ({ ...content, round_trip: roundTripTargets.has(JSON.stringify(content.path)) })),
      projections: current.projections.map(projection => ({ ...projection, round_trip: roundTripTargets.has(JSON.stringify(projection.target_path)) })),
    };
  };
  const appendText = (update: IRTextUpdate, target: IRPath): string => {
    if (update.replacement) return append(update.path, update.text, target);
    const old = previous.get(JSON.stringify(update.path)) ?? '';
    if (old.length !== update.start) throw new Error('IR text projection received an out-of-order fragment');
    return append(update.path, old + update.text, target);
  };
  return { append, appendText, assign, markRoundTrip, result, roundTripResult };
};
