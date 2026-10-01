import { callSearchUpstream } from './call-upstream.ts';
import { emitAlphaSearch } from './emit.ts';
import { executeSearchOperations } from './execute-operations.ts';
import type { SearchExecution, Fields } from './facts.ts';
import { parseSearchOperations } from './parse-operations.ts';
import { serializeClientJson } from '../pipeline/serialize-client-json.ts';
import { writeSettlement } from '../pipeline/settlement.ts';
import { compose, type Pipeline } from '@floway-dev/pipeline';

export const searchServePipeline = (execution: SearchExecution): Pipeline<
  Fields<'request.search.alphaSearch'>,
  Fields<'response.http.jsonBody' | 'response.search.rendered' | 'response.http.status' | 'response.http.headers' | 'response.usage.billable'>
> => compose('searchServe', [
  // Unconditional, as everywhere: a run that searched locally reached no upstream and bills
  // for none, and saying so is a row that names no billed entity rather than no row.
  writeSettlement(handedUp => Number(handedUp['response.http.status']) >= 400),
  serializeClientJson('response.search.rendered'),
  emitAlphaSearch,
  ...(execution.kind === 'local'
    ? [parseSearchOperations, executeSearchOperations]
    : [callSearchUpstream(execution)]),
]);
