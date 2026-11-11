import { type InputAssistantTurnStateFor, type ReferenceableInputAssistantTurnFor } from './assistant-turn-types.ts';
import { createFieldReferencer, isReadFieldState, pairedChildren, type EmittedFieldId, type ReadFieldState, type ReadFieldStates, type ReferenceBuilder } from './reference-builder.ts';
import { ContentReference, type ContentReferenceSegment } from './types.ts';
import type { IRJSONObject } from '../../ir/common/json.ts';
import { requireJSONObject } from '../../shared/json/object.ts';
import { rawJSON } from '../../shared/json/raw-json.ts';
import type { InputAssistantTurnByProtocol, InputAssistantTurnFor } from '../input-assistant-turn.ts';
import type { TextPlacement } from '../text-groups.ts';

interface ReferencedAssistantTurn<Turn> {
  readonly targetTurn: Turn;
  readonly referencedContentHashes?: Uint8Array[];
}

interface ReferenceCandidate {
  readonly field: ReadFieldState;
  readonly reference: ContentReference;
  readonly hashes: number[];
  readonly savings: number;
}

// Deliberately coarse budgets keep selection independent of the injected codec.
// Shared hashes are charged once; indices and ranges use fixed generous costs.
const REFERENCE_OVERHEAD = 8;
const HASH_COST_ESTIMATE = 16;
const HASH_TABLE_COST_ESTIMATE = 32;

const estimateReferenceCost = (reference: ContentReference): number => REFERENCE_OVERHEAD
  + reference.parts.reduce<number>((cost, part) => cost + (typeof part === 'number' ? 4 : 16), 0);

const estimateJSONLiteralCost = (value: unknown, ancestors = new Set<object>()): number => {
  if (rawJSON.isRawJSON(value)) return value.rawJSON.length;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return 1;
  if (typeof value === 'string') return value.length;
  if (typeof value !== 'object') throw new TypeError('JSON reference cost requires a JSON value');
  if (ancestors.has(value)) throw new TypeError('JSON reference cost requires an acyclic value');
  ancestors.add(value);
  const cost = Array.isArray(value)
    ? value.reduce((sum, child) => sum + estimateJSONLiteralCost(child, ancestors), 0)
    : Object.entries(value).reduce((sum, [key, child]) => sum + key.length + estimateJSONLiteralCost(child, ancestors), 0);
  ancestors.delete(value);
  return cost;
};

export const referenceAssistantTurn = async <Protocol extends keyof InputAssistantTurnByProtocol>(
  turn: InputAssistantTurnFor<Protocol>,
  fieldState: InputAssistantTurnStateFor<Protocol, ReadFieldStates>,
  builder: ReferenceBuilder,
  emittedFieldPlacements: ReadonlyMap<EmittedFieldId, TextPlacement>,
): Promise<ReferencedAssistantTurn<ReferenceableInputAssistantTurnFor<Protocol, ContentReference>>> => {
  const referencer = createFieldReferencer(builder, emittedFieldPlacements);
  const minimumReferenceCost = REFERENCE_OVERHEAD + 4;
  const candidates: ReferenceCandidate[] = [];
  const collect = async (value: unknown, state: unknown): Promise<void> => {
    if (isReadFieldState(state)) {
      let original: string | IRJSONObject;
      if (state.kind === 'text') {
        if (typeof value !== 'string') throw new TypeError('Text field state does not match its assistant turn');
        original = value;
      } else original = requireJSONObject(value);
      const literalCost = typeof original === 'string' ? original.length : estimateJSONLiteralCost(original);
      if (literalCost <= minimumReferenceCost) return;
      const reference = await referencer.referenceField(original, state);
      if (reference instanceof ContentReference) {
        const savings = literalCost - estimateReferenceCost(reference);
        if (savings > 0) candidates.push({ field: state, reference, hashes: [...new Set(reference.parts.map(part => Array.isArray(part) ? part[0] : part))], savings });
      }
      return;
    }
    for (const [, childValue, childState] of pairedChildren(value, state)) await collect(childValue, childState);
  };
  await collect(turn, fieldState);
  if (candidates.length === 0) return { targetTurn: turn };

  const savingsByHash = referencer.referencedContentHashes.map(() => 0);
  for (const candidate of candidates) for (const hash of candidate.hashes) savingsByHash[hash] += candidate.savings / candidate.hashes.length;
  const selected = new Map<ReadFieldState, ContentReference>();
  const selectedHashes = new Set<number>();
  let savings = 0;
  for (const candidate of candidates) {
    if (candidate.hashes.some(hash => savingsByHash[hash] <= HASH_COST_ESTIMATE)) continue;
    selected.set(candidate.field, candidate.reference);
    savings += candidate.savings;
    for (const hash of candidate.hashes) selectedHashes.add(hash);
  }
  // Rejected atomic fields may have contributed to a surviving hash's estimate.
  // Check the selected set again so those contributions cannot fund its table.
  if (savings <= HASH_TABLE_COST_ESTIMATE + selectedHashes.size * HASH_COST_ESTIMATE) return { targetTurn: turn };

  const referencedContentHashes: Uint8Array[] = [];
  const compactIndices: number[] = [];
  for (const [index, hash] of referencer.referencedContentHashes.entries()) {
    if (!selectedHashes.has(index)) continue;
    compactIndices[index] = referencedContentHashes.length;
    referencedContentHashes.push(hash);
  }

  for (const reference of selected.values()) reference.parts = reference.parts.map((part): ContentReferenceSegment => Array.isArray(part)
    ? [compactIndices[part[0]], part[1], part[2]]
    : compactIndices[part]);
  const visit = (value: unknown, state: unknown): unknown => {
    if (isReadFieldState(state)) return selected.get(state) ?? value;
    if (Array.isArray(state)) {
      if (!Array.isArray(value)) throw new TypeError('ReferenceBuilder state array does not match its assistant turn');
      const result = value.slice();
      for (let index = 0; index < state.length; index++) {
        if (!Object.hasOwn(state, index)) continue;
        result[index] = visit(value[index], state[index]);
      }
      return result;
    }
    if (typeof state !== 'object' || state === null) return value;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('ReferenceBuilder state object does not match its assistant turn');
    const result = { ...value };
    for (const [key, childState] of Object.entries(state)) Reflect.set(result, key, visit(Reflect.get(value, key), childState));
    return result;
  };
  const targetTurn = visit(turn, fieldState) as ReferenceableInputAssistantTurnFor<Protocol, ContentReference>;
  return {
    targetTurn,
    referencedContentHashes,
  };
};
