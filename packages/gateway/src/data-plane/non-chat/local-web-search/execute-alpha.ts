import { defineStage } from './facts.ts';
import { searchAbort, searchSession } from './session.ts';
import { executeOperationToText, startBatchFetch } from '../../tools/web-search/operations.ts';

const MAX_OUTPUT_CODE_UNITS = 16 * 1024 * 1024;
const BLOCK_SEPARATOR = '\n\n';

export const executeLocalAlphaSearch = defineStage({
  name: 'local-alpha-search.execute',
  request: { needs: ['http', 'serve.startedAt', 'alphaSearchBatch'] },
  return: { provides: ['http', 'alphaSearchBatch'] },
  async execute({ alphaSearchBatch }, { services: { localWebSearch }, signal }) {
    try {
      signal.throwIfAborted();
      const { operations, ...options } = alphaSearchBatch;
      const session = searchSession(localWebSearch, options, signal);
      const batch = await startBatchFetch({ kind: 'ops', ops: operations }, session);
      let outputLength = Math.max(0, operations.length - 1) * BLOCK_SEPARATOR.length;
      const blocks = await Promise.all(operations.map(async operation => {
        const block = await executeOperationToText(operation, session, batch);
        outputLength += block.length;
        if (outputLength > MAX_OUTPUT_CODE_UNITS) {
          throw new RangeError(`Alpha Search output exceeds ${MAX_OUTPUT_CODE_UNITS} UTF-16 code units`);
        }
        return block;
      }));
      return { http: null, alphaSearchBatch: { kind: 'text', result: blocks.join(BLOCK_SEPARATOR) } };
    } catch (cause) {
      return { http: null, alphaSearchBatch: searchAbort(cause, signal) };
    }
  },
});
