import { cloneIRJSON } from '../shared/json.ts';
import type { IRPath } from '../stream.ts';
import type { IATReference } from '../thin-types.ts';

export const replaceIRRoundTripReferences = <T>(
  assistantTurn: T,
  referencesByProtocolPath: ReadonlyMap<string, IATReference>,
  eligiblePaths: readonly IRPath[],
): T => {
  const thinTurn = cloneIRJSON(assistantTurn);
  for (const path of eligiblePaths) {
    const reference = referencesByProtocolPath.get(JSON.stringify(path));
    if (reference === undefined) continue;
    let parent = thinTurn as Record<string | number, unknown>;
    for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
    parent[path.at(-1)!] = reference;
  }
  return thinTurn;
};
