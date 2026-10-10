import type { IR } from './ir.ts';
import type { IRProjectionResult, IRStringProjection } from './round-trip-projection.ts';
import { cloneIRJSON, irJSON, parseIRJSONObject } from './shared/json.ts';
import type { IRPath } from './stream.ts';
import type { IRReferencePayload } from './thin-types.ts';

export type IRContentHasher = (text: string) => Promise<Uint8Array>;

export const irUTF16Bytes = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
  return bytes;
};

export const hashIRContent: IRContentHasher = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', irUTF16Bytes(text) as Uint8Array<ArrayBuffer>));
export const irHashKey = (hash: Uint8Array): string => Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');

export interface IRIATEntry { path: IRPath; text: string; json?: true }
export interface IRIAT { entries: IRIATEntry[]; projection?: IRProjectionResult }

export const createIRIAT = (ir: IR): IRIAT => {
  const entries: IRIATEntry[] = [];
  const walk = (value: unknown, path: IRPath): void => {
    if (typeof value === 'string') entries.push({ path, text: value });
    else if (typeof value === 'object' && value !== null) {
      if (irJSON.isRawJSON(value)) return;
      if (path.at(-1) === 'arguments' && !Array.isArray(value)) entries.push({ path, text: JSON.stringify(value), json: true });
      for (const [key, child] of Object.entries(value)) walk(child, [...path, Array.isArray(value) ? Number(key) : key]);
    }
  };
  walk(ir, []);
  return { entries };
};

export const fillIRIAT = (iat: IRIAT, projection: IRProjectionResult): void => { iat.projection = cloneIRJSON(projection); };

export interface IRResolvedIAT { references: Map<number, IRReferencePayload>; referencedContents: Uint8Array[] }

export const resolveIRIAT = async (iat: IRIAT, entryIndices: readonly number[], hasher: IRContentHasher = hashIRContent): Promise<IRResolvedIAT> => {
  if (iat.projection === undefined) throw new Error('IAT projection has not been filled');
  const projection = iat.projection;
  const referencedContents: Uint8Array[] = [];
  const hashes = new Map<string, { index: number; text: string }>();
  const hashIndex = async (text: string): Promise<number> => {
    const hash = await hasher(text); const key = irHashKey(hash); const known = hashes.get(key);
    if (known !== undefined) {
      if (known.text !== text) throw new Error('Referenced content hash collision');
      return known.index;
    }
    const index = referencedContents.length;
    referencedContents.push(hash); hashes.set(key, { index, text }); return index;
  };
  const references = new Map<number, IRReferencePayload>();
  for (const entryIndex of new Set(entryIndices)) {
    const entry = iat.entries[entryIndex];
    if (entry === undefined) throw new RangeError('Unknown IAT entry');
    const spans: IRStringProjection[] = projection.projections.filter(p => p.round_trip && JSON.stringify(p.source_path) === JSON.stringify(entry.path)).toSorted((a, b) => a.source_start - b.source_start);
    const segments: { text: string; start: number; end: number }[] = [];
    let cursor = 0;
    for (const span of spans) {
      const target = projection.contents.find(c => c.round_trip && JSON.stringify(c.path) === JSON.stringify(span.target_path));
      if (target === undefined) throw new Error('IAT projection target is missing');
      if (entry.json && JSON.stringify(parseIRJSONObject(target.text)) === entry.text) {
        segments.length = 0; segments.push({ text: target.text, start: 0, end: target.text.length }); cursor = entry.text.length; break;
      }
      if (span.source_start < cursor) continue;
      if (span.source_start !== cursor || span.source_end_exclusive > entry.text.length || entry.text.slice(span.source_start, span.source_end_exclusive) !== target.text.slice(span.target_start, span.target_end_exclusive)) break;
      segments.push({ text: target.text, start: span.target_start, end: span.target_end_exclusive });
      cursor = span.source_end_exclusive;
    }
    if (cursor !== entry.text.length || segments.length === 0) continue;
    const payload: IRReferencePayload = [];
    for (const segment of segments) {
      const index = await hashIndex(segment.text);
      const part = segment.start === 0 && segment.end === segment.text.length ? index : [index, segment.start, segment.end] as [number, number, number];
      const previous = payload.at(-1);
      if (Array.isArray(previous) && Array.isArray(part) && previous[0] === part[0] && previous[2] === part[1]) previous[2] = part[2];
      else payload.push(part);
    }
    references.set(entryIndex, payload);
  }
  return { references, referencedContents };
};
