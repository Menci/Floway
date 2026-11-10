import { ContentReference, type AssistantTurnStateFor, type ContentReferenceSegment, type ReferenceableAssistantTurnFor } from './assistant-turn.ts';
import { createReferenceFinalizer, isFieldState, pairedChildren, type FieldState, type FieldStates, type ReferenceBuilder } from './reference-builder.ts';
import type { IRJSONObject } from '../../ir/types.ts';
import { requireJSONObject } from '../../shared/json/object.ts';
import { rawJSON } from '../../shared/json/raw-json.ts';
import type { AssistantTurnByProtocol, AssistantTurnFor } from '../assistant-turn.ts';
import type { TextPlacement } from '../text-groups.ts';

type ContentId = number;

interface FinalizedAssistantTurn<Turn> {
  readonly targetTurn: Turn;
  readonly referencedContentHashes?: Uint8Array[];
}

interface ReferenceChoice {
  readonly field: FieldState;
  readonly reference: ContentReference;
  readonly hashes: number[];
  readonly savings: number;
}

// Deliberately coarse budgets keep selection independent of the injected codec.
// Shared hashes are charged once; indices and ranges use fixed generous costs.
const REFERENCE_OVERHEAD = 8;
const HASH_BUDGET = 16;
const HASH_TABLE_BUDGET = 32;

const referenceBudget = (reference: ContentReference): number => REFERENCE_OVERHEAD
  + reference.parts.reduce<number>((cost, part) => cost + (typeof part === 'number' ? 4 : 16), 0);

const jsonLiteralBudget = (value: unknown, ancestors = new Set<object>()): number => {
  if (rawJSON.isRawJSON(value)) return value.rawJSON.length;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return 1;
  if (typeof value === 'string') return value.length;
  if (typeof value !== 'object') throw new TypeError('JSON reference budget requires a JSON value');
  if (ancestors.has(value)) throw new TypeError('JSON reference budget requires an acyclic value');
  ancestors.add(value);
  const budget = Array.isArray(value)
    ? value.reduce((sum, child) => sum + jsonLiteralBudget(child, ancestors), 0)
    : Object.entries(value).reduce((sum, [key, child]) => sum + key.length + jsonLiteralBudget(child, ancestors), 0);
  ancestors.delete(value);
  return budget;
};

export const finalizeAssistantTurnReferences = async <Protocol extends keyof AssistantTurnByProtocol>(
  turn: AssistantTurnFor<Protocol>,
  fieldState: AssistantTurnStateFor<Protocol, FieldStates>,
  builder: ReferenceBuilder,
  contentViews: ReadonlyMap<ContentId, TextPlacement>,
): Promise<FinalizedAssistantTurn<ReferenceableAssistantTurnFor<Protocol, ContentReference>>> => {
  const finalizer = createReferenceFinalizer(builder, contentViews);
  const minimumReferenceBudget = REFERENCE_OVERHEAD + 4;
  const choices: ReferenceChoice[] = [];
  const collect = async (value: unknown, state: unknown): Promise<void> => {
    if (isFieldState(state)) {
      let original: string | IRJSONObject;
      if (state.kind === 'text') {
        if (typeof value !== 'string') throw new TypeError('Text field state does not match its assistant turn');
        original = value;
      } else original = requireJSONObject(value);
      const literalBudget = typeof original === 'string' ? original.length : jsonLiteralBudget(original);
      if (literalBudget <= minimumReferenceBudget) return;
      const reference = await finalizer.finalizeField(original, state);
      if (reference instanceof ContentReference) {
        const savings = literalBudget - referenceBudget(reference);
        if (savings > 0) choices.push({ field: state, reference, hashes: [...new Set(reference.parts.map(part => Array.isArray(part) ? part[0] : part))], savings });
      }
      return;
    }
    for (const [, childValue, childState] of pairedChildren(value, state)) await collect(childValue, childState);
  };
  await collect(turn, fieldState);
  if (choices.length === 0) return { targetTurn: turn };

  const savingsByHash = finalizer.referencedContentHashes.map(() => 0);
  for (const choice of choices) for (const hash of choice.hashes) savingsByHash[hash] += choice.savings / choice.hashes.length;
  const selected = new Map<FieldState, ContentReference>();
  const selectedHashes = new Set<number>();
  let savings = 0;
  for (const choice of choices) {
    if (choice.hashes.some(hash => savingsByHash[hash] <= HASH_BUDGET)) continue;
    selected.set(choice.field, choice.reference);
    savings += choice.savings;
    for (const hash of choice.hashes) selectedHashes.add(hash);
  }
  // Rejected atomic fields may have contributed to a surviving hash's estimate.
  // Check the selected set again so those contributions cannot fund its table.
  if (savings <= HASH_TABLE_BUDGET + selectedHashes.size * HASH_BUDGET) return { targetTurn: turn };

  const referencedContentHashes: Uint8Array[] = [];
  const compactIndices: number[] = [];
  for (const [index, hash] of finalizer.referencedContentHashes.entries()) {
    if (!selectedHashes.has(index)) continue;
    compactIndices[index] = referencedContentHashes.length;
    referencedContentHashes.push(hash);
  }

  for (const reference of selected.values()) reference.parts = reference.parts.map((part): ContentReferenceSegment => Array.isArray(part)
    ? [compactIndices[part[0]], part[1], part[2]]
    : compactIndices[part]);
  const visit = (value: unknown, state: unknown): unknown => {
    if (isFieldState(state)) return selected.get(state) ?? value;
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
  const targetTurn = visit(turn, fieldState) as ReferenceableAssistantTurnFor<Protocol, ContentReference>;
  return {
    targetTurn,
    referencedContentHashes,
  };
};
