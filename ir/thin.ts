import { Decoder, Encoder, Tag } from 'cbor-x';

import { hashIRContent, irHashKey, irUTF16Bytes, resolveIRIAT, type IRContentHasher, type IRIAT } from './iat.ts';
import type { IRProtocol } from './ir.ts';
import { cloneIRJSON, irJSON, parseIRJSONObject } from './json.ts';
import type { IRPath } from './stream.ts';
import type { IRReferencePayload, IRReferenceTags, IRReplayItems, IRThinItems } from './thin-types.ts';
import type { IRWire } from './usage.ts';

export class IRPendingReference {
  constructor(readonly entries: number[], readonly original: unknown, readonly json: boolean) {}
}
export interface IRThinEnvelope<P extends IRProtocol = IRProtocol> { protocol: P; referencedContents: Uint8Array[]; items: IRThinItems[P] }
export interface IRPendingThinItems<P extends IRProtocol = IRProtocol> { protocol: P; items: unknown[] }
export type IRThinSourcePath = (path: IRPath, value: unknown) => IRPath | undefined;
type IRRuntimeRule = 'text' | 'json' | readonly [IRRuntimeRule] | { [key: string]: IRRuntimeRule };

const contentRule = (content: unknown): IRRuntimeRule => typeof content === 'string' ? 'text' : [{ text: 'text', refusal: 'text' }];
const ruleFor = (protocol: IRProtocol, item: IRWire): IRRuntimeRule => {
  if (protocol === 'openaiChatCompletions') return { content: contentRule(item.content), refusal: 'text', reasoning: 'text', reasoning_text: 'text', reasoning_content: 'text', reasoning_opaque: 'text', function_call: { arguments: 'text' }, tool_calls: [{ function: { arguments: 'text' }, custom: { input: 'text' } }] };
  if (protocol === 'openaiResponses') {
    switch (item.type) {
    case 'message': return { content: contentRule(item.content) };
    case 'reasoning': return { summary: [{ text: 'text' }], content: [{ text: 'text' }], encrypted_content: 'text' };
    case 'function_call': return { arguments: 'text' };
    case 'custom_tool_call': return { input: 'text' };
    case 'image_generation_call': return { result: 'text' };
    default: return {};
    }
  }
  if (protocol === 'anthropicMessages') {
    switch (item.type) {
    case 'text': return { text: 'text', citations: [{ cited_text: 'text' }] };
    case 'thinking': return { thinking: 'text', signature: 'text' };
    case 'redacted_thinking': return { data: 'text' };
    case 'tool_use': return { input: 'json' };
    default: return {};
    }
  }
  return { parts: [{ text: 'text', thoughtSignature: 'text', inlineData: { data: 'text' }, audioTranscription: { text: 'text' }, functionCall: { args: 'json' } }] };
};

export const createIRPendingThinItems = <P extends IRProtocol>(protocol: P, replay: IRReplayItems[P], iat: IRIAT, sourcePath?: IRThinSourcePath): IRPendingThinItems<P> => {
  const walk = (value: unknown, rule: IRRuntimeRule, path: IRPath): unknown => {
    if (rule === 'text' || rule === 'json') {
      if (rule === 'text' && typeof value !== 'string' || rule === 'json' && (typeof value !== 'object' || value === null || Array.isArray(value) || irJSON.isRawJSON(value))) return value;
      const text = rule === 'json' ? JSON.stringify(value) : value;
      const source = sourcePath?.(path, value);
      const entries = iat.entries.flatMap((entry, index) => entry.text === text && (sourcePath === undefined || source !== undefined && JSON.stringify(entry.path) === JSON.stringify(source)) ? [index] : []);
      return entries.length === 0 ? value : new IRPendingReference(entries, value, rule === 'json');
    }
    if (Array.isArray(value) && Array.isArray(rule)) return value.map((child, index) => walk(child, rule[0], [...path, index]));
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && !Array.isArray(rule)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, Object.hasOwn(rule, key) ? walk(child, (rule as Record<string, IRRuntimeRule>)[key], [...path, key]) : cloneIRJSON(child)]));
    return cloneIRJSON(value);
  };
  return { protocol, items: replay.map((item, index) => walk(item, ruleFor(protocol, item as IRWire), [index])) };
};

export const finalizeIRThinItems = async <P extends IRProtocol>(pending: IRPendingThinItems<P>, iat: IRIAT, tags: IRReferenceTags, hasher: IRContentHasher = hashIRContent): Promise<IRThinEnvelope<P>> => {
  const entryIndices: number[] = [];
  const findReferences = (value: unknown): void => {
    if (value instanceof IRPendingReference) entryIndices.push(...value.entries);
    else if (Array.isArray(value)) value.forEach(findReferences);
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(findReferences);
  };
  findReferences(pending.items);
  const resolved = await resolveIRIAT(iat, entryIndices, hasher);
  const walk = (value: unknown): unknown => {
    if (irJSON.isRawJSON(value)) return value;
    if (value instanceof IRPendingReference) {
      const reference = value.entries.map(index => resolved.references.get(index)).find(payload => payload !== undefined);
      return reference === undefined ? cloneIRJSON(value.original) : new Tag(reference, value.json ? tags.json : tags.text);
    }
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)]));
    return value;
  };
  return { protocol: pending.protocol, referencedContents: resolved.referencedContents, items: walk(pending.items) as IRThinItems[P] };
};

export const buildIRReplayItems = <P extends IRProtocol>(protocol: P, result: unknown): IRReplayItems[P] => {
  const output = cloneIRJSON(result) as IRWire;
  let items: IRWire[];
  if (protocol === 'openaiChatCompletions') items = output.choices.map((choice: IRWire) => {
    const { annotations: _annotations, ...message } = choice.message;
    if (message.audio != null) message.audio = { id: message.audio.id };
    return message;
  });
  else if (protocol === 'openaiResponses') items = output.output.map((item: IRWire) => {
    if (item.type === 'web_search_call') delete item.results;
    if (item.type === 'message' && Array.isArray(item.content)) item.content = item.content.map((part: IRWire) => {
      const { annotations: _annotations, logprobs: _logprobs, ...content } = part; return content;
    });
    return item;
  });
  else if (protocol === 'anthropicMessages') items = output.content.map((block: IRWire) => {
    if (block.type === 'text' && block.citations != null) block.citations = block.citations.map((citation: IRWire) => {
      if (['char_location', 'page_location', 'content_block_location'].includes(citation.type)) delete citation.file_id;
      return citation;
    });
    return block;
  });
  else items = output.candidates.map((candidate: IRWire) => candidate.content);
  return items as IRReplayItems[P];
};

export const createIRThinCodec = (tags: IRReferenceTags) => {
  const encoder = new Encoder({ useRecords: false, pack: true, tagUint8Array: false });
  const decoder = new Decoder({ mapsAsObjects: false });
  const numbers = [tags.text, tags.json, tags.utf16, ...(tags.rawJSON === undefined ? [] : [tags.rawJSON])];
  if (new Set(numbers).size !== numbers.length || numbers.some(n => !Number.isSafeInteger(n) || n < 0)) throw new TypeError('Thin CBOR tags must be distinct nonnegative safe integers');
  for (const tag of numbers) {
    const decoded: unknown = decoder.decode(encoder.encode(new Tag(null, tag)));
    if (!(decoded instanceof Tag) || decoded.tag !== tag) throw new TypeError(`CBOR tag ${tag} conflicts with the codec`);
  }
  const encodeValue = (value: unknown): unknown => {
    if (value instanceof IRPendingReference) throw new TypeError('Cannot encode an unresolved thin reference');
    if (typeof value === 'string' && !value.isWellFormed()) return new Tag(irUTF16Bytes(value), tags.utf16);
    if (irJSON.isRawJSON(value)) {
      if (tags.rawJSON === undefined) throw new TypeError('Raw JSON primitives require a CBOR rawJSON tag');
      return new Tag((value as { rawJSON: string }).rawJSON, tags.rawJSON);
    }
    if (value instanceof Tag) return new Tag(encodeValue(value.value), value.tag);
    if (value instanceof Uint8Array) return value;
    if (Array.isArray(value)) return value.map(encodeValue);
    if (typeof value === 'object' && value !== null) return new Map(Object.entries(value).map(([key, child]) => [encodeValue(key), encodeValue(child)]));
    return value;
  };
  const decodeValue = (value: unknown): unknown => {
    if (value instanceof Tag) {
      if (value.tag === tags.rawJSON) {
        if (typeof value.value !== 'string') throw new TypeError('Invalid raw JSON CBOR value');
        return irJSON.rawJSON(value.value);
      }
      if (value.tag === tags.utf16) {
        if (!(value.value instanceof Uint8Array) || value.value.length % 2 !== 0) throw new TypeError('Invalid UTF-16 CBOR value');
        const bytes = value.value; const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let text = ''; for (let i = 0; i < bytes.length; i += 2) text += String.fromCharCode(view.getUint16(i, true)); return text;
      }
      return new Tag(decodeValue(value.value), value.tag);
    }
    if (value instanceof Uint8Array) return value;
    if (Array.isArray(value)) return value.map(decodeValue);
    if (value instanceof Map) return Object.fromEntries([...value].map(([key, child]) => {
      const field = decodeValue(key);
      if (typeof field !== 'string') throw new TypeError('Thin object keys must decode to strings');
      return [field, decodeValue(child)];
    }));
    return value;
  };
  return {
    encode: (value: IRThinEnvelope): Uint8Array => encoder.encode(encodeValue(value)),
    decode: (bytes: Uint8Array): IRThinEnvelope => {
      const value = decodeValue(decoder.decode(bytes)) as Partial<IRThinEnvelope> | null;
      if (typeof value !== 'object' || value === null || !['openaiChatCompletions', 'openaiResponses', 'anthropicMessages', 'geminiGenerateContent'].includes(value.protocol as string) || !Array.isArray(value.items) || !Array.isArray(value.referencedContents) || !value.referencedContents.every(hash => hash instanceof Uint8Array)) throw new TypeError('Invalid thin envelope');
      return value as IRThinEnvelope;
    },
    restore: async <P extends IRProtocol>(envelope: IRThinEnvelope<P>, contents: readonly string[], hasher: IRContentHasher = hashIRContent): Promise<IRReplayItems[P]> => {
      const lookup = new Map<string, string>();
      for (const text of contents) {
        const key = irHashKey(await hasher(text)); const previous = lookup.get(key);
        if (previous !== undefined && previous !== text) throw new Error('Referenced content hash collision');
        lookup.set(key, text);
      }
      const resolve = (payload: unknown): string => {
        if (!Array.isArray(payload)) throw new TypeError('Invalid reference payload');
        return (payload as IRReferencePayload).map(part => {
          const index = Array.isArray(part) ? part[0] : part;
          if (!Number.isInteger(index) || index < 0 || index >= envelope.referencedContents.length) throw new RangeError('Invalid reference hash index');
          const text = lookup.get(irHashKey(envelope.referencedContents[index]));
          if (text === undefined) throw new Error('Referenced content is missing or its checksum changed');
          if (!Array.isArray(part)) return text;
          if (part.length !== 3 || !Number.isInteger(part[1]) || !Number.isInteger(part[2]) || part[1] < 0 || part[2] < part[1] || part[2] > text.length) throw new RangeError('Invalid UTF-16 reference range');
          return text.slice(part[1], part[2]);
        }).join('');
      };
      const walk = (value: unknown): unknown => {
        if (irJSON.isRawJSON(value)) return value;
        if (value instanceof Tag) {
          if (value.tag === tags.text) return resolve(value.value);
          if (value.tag === tags.json) {
            return parseIRJSONObject(resolve(value.value));
          }
          throw new TypeError(`Unknown thin reference tag ${value.tag}`);
        }
        if (Array.isArray(value)) return value.map(walk);
        if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)]));
        return value;
      };
      return walk(envelope.items) as IRReplayItems[P];
    },
  };
};
