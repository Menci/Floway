import { callSearchUpstream } from './call-upstream.ts';
import { emitAlphaSearch } from './emit.ts';
import { executeSearchOperations } from './execute-operations.ts';
import type { SearchExecution, Fields } from './facts.ts';
import { parseSearchOperations } from './parse-operations.ts';
import { isFailure } from '../pipeline/facts.ts';
import { writeSettlement } from '../pipeline/settlement.ts';
import { compose, type Pipeline } from '@floway-dev/pipeline';

export const searchServePipeline = (execution: SearchExecution): Pipeline<
  Fields<'request.search.alphaSearch'>,
  Fields<'response.search.rendered' | 'response.http.status' | 'response.http.headers' | 'response.usage.billable'>
> => compose('searchServe', [
  emitAlphaSearch,
  // Unconditional, as everywhere: a run that searched locally reached no upstream and bills
  // for none, and saying so is a row that names no billed entity rather than no row.
  writeSettlement(handedUp => isFailure((handedUp as { 'response.search.alphaSearch'?: unknown })['response.search.alphaSearch'])),
  ...(execution.kind === 'local'
    ? [parseSearchOperations, executeSearchOperations]
    : [callSearchUpstream(execution)]),
]);
