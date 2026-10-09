import type { IR } from './ir.ts';
import type { IRProjectionResult, IRStringProjection } from './projection.ts';
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

export interface IRIATEntry { path: IRPath; text: string }
export interface IRIAT { entries: IRIATEntry[]; projection?: IRProjectionResult }

export const createIRIAT = (ir: IR): IRIAT => {
  const entries: IRIATEntry[] = [];
  const walk = (value: unknown, path: IRPath): void => {
    if (typeof value === 'string') entries.push({ path, text: value });
    else if (typeof value === 'object' && value !== null) {
      if (path.at(-1) === 'arguments' && !Array.isArray(value)) entries.push({ path, text: JSON.stringify(value) });
      for (const [key, child] of Object.entries(value)) walk(child, [...path, Array.isArray(value) ? Number(key) : key]);
    }
  };
  walk(ir, []);
  return { entries };
};

export const fillIRIAT = (iat: IRIAT, projection: IRProjectionResult): void => { iat.projection = structuredClone(projection); };

export interface IRResolvedIAT { references: (IRReferencePayload | undefined)[]; referencedContents: Uint8Array[] }

export const resolveIRIAT = async (iat: IRIAT, hasher: IRContentHasher = hashIRContent): Promise<IRResolvedIAT> => {
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
  const references: (IRReferencePayload | undefined)[] = [];
  for (const entry of iat.entries) {
    const spans: IRStringProjection[] = projection.projections.filter(p => p.round_trip && JSON.stringify(p.source_path) === JSON.stringify(entry.path)).toSorted((a, b) => a.source_start - b.source_start);
    const payload: IRReferencePayload = [];
    let cursor = 0;
    let valid = true;
    for (const span of spans) {
      if (span.source_start < cursor) continue;
      const target = projection.contents.find(c => c.round_trip && JSON.stringify(c.path) === JSON.stringify(span.target_path));
      if (target === undefined || span.source_start !== cursor || span.source_end_exclusive > entry.text.length || entry.text.slice(span.source_start, span.source_end_exclusive) !== target.text.slice(span.target_start, span.target_end_exclusive)) { valid = false; break; }
      const index = await hashIndex(target.text);
      const part = span.target_start === 0 && span.target_end_exclusive === target.text.length ? index : [index, span.target_start, span.target_end_exclusive] as [number, number, number];
      const previous = payload.at(-1);
      if (Array.isArray(previous) && Array.isArray(part) && previous[0] === part[0] && previous[2] === part[1]) previous[2] = part[2];
      else payload.push(part);
      cursor = span.source_end_exclusive;
    }
    references.push(valid && cursor === entry.text.length && (payload.length > 0 || entry.text === '') ? payload : undefined);
  }
  return { references, referencedContents };
};
