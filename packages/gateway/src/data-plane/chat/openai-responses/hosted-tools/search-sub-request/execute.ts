import type { Fields, WebSearchRequest } from './facts.ts';
import type { SearchServices, WebSearchRuntime } from './services.ts';
import { assertLocalWebSearchSupport, executeOperationToIr, parseWebSearchOperations, runBackendSearchMulti, schemaErrorIr, startBatchFetch, UnsupportedLocalWebSearchFeatureError, unsupportedLocalWebSearchFeatureIr, type WebSearchCallIR, type WebSearchOperation } from '../../../../tools/web-search/operations.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { OpenAIResponsesWebSearchAction } from '@floway-dev/protocols/openai-responses';

const ITERATION_CAP = 30;

export const runWebSearchCall = defineStage<
  Fields<'request.webSearch.canonical'>,
  Fields<'response.webSearch.ir'> & { 'response.usage.billable': readonly never[] },
  SearchServices
>({
  name: 'runWebSearchCall',
  return: { provides: ['response.webSearch.ir', 'response.usage.billable'] },
  execute: async (facts, use) => move({
    ...facts,
    'response.webSearch.ir': await execute(facts['request.webSearch.canonical'], use.webSearch),
    // Search billing belongs to the backend operations; no model entity is called here.
    'response.usage.billable': [],
  }),
});

const execute = async (request: WebSearchRequest, runtime: WebSearchRuntime): Promise<WebSearchCallIR> => {
  const { commands, toolName, iterationCount } = request;
  const parsed = parseWebSearchOperations(commands);
  if (iterationCount > ITERATION_CAP) {
    return schemaErrorIr(
      'tool budget exhausted',
      'Tool call budget exhausted',
      `Web search iteration limit (${ITERATION_CAP}) reached. Further web_search calls in this response will return this same error. Summarize what you have already learned, and continue the task using other available tools (shell, file inspection, prior knowledge) or directly answer based on what you've gathered.`,
    );
  }
  if (parsed.kind === 'malformed' || parsed.ops.length === 0) {
    return schemaErrorIr(
      'malformed dispatcher call arguments',
      'Malformed arguments',
      'Error: arguments must be a JSON object with sub-property arrays (search_query[], open[], find[]).',
    );
  }
  if (runtime.executeAlpha !== undefined) {
    const first = parsed.ops[0];
    let action: OpenAIResponsesWebSearchAction;
    if (first.kind === 'search') {
      const queries = parsed.ops.filter((op): op is Extract<WebSearchOperation, { kind: 'search' }> => op.kind === 'search').map(op => op.query);
      action = queries.length === 1
        ? { type: 'search', query: queries[0], queries }
        : { type: 'search', query: queries.join(' | '), queries };
    } else if (first.kind === 'open') {
      action = { type: 'open_page', url: first.url };
    } else if (first.kind === 'find') {
      action = { type: 'find_in_page', url: first.url, pattern: first.pattern };
    } else {
      action = { type: 'search', query: Object.keys(commands).join(', ') };
    }
    return await runtime.executeAlpha(request, action);
  }
  try {
    assertLocalWebSearchSupport(commands);
  } catch (error) {
    if (error instanceof UnsupportedLocalWebSearchFeatureError) {
      return unsupportedLocalWebSearchFeatureIr({ type: 'search', query: Object.keys(commands).join(', ') }, error.message);
    }
    throw error;
  }
  const session = { ...runtime.session, filters: request.filters, includeSearchActionSources: request.includeSearchActionSources };
  if (parsed.ops.length > 1 && parsed.ops.every(op => op.kind === 'search' && op.error === undefined)) {
    return await runBackendSearchMulti(parsed.ops as Extract<WebSearchOperation, { kind: 'search' }>[], session);
  }
  if (parsed.ops.length > 1) {
    return schemaErrorIr(
      'ambiguous dispatcher call',
      'Ambiguous tool call',
      `Error: ambiguous \`${toolName}\` tool call — each function_call maps to one web_search_call. `
      + 'Multiple `search_query` entries are fine (they collapse into one search). '
      + 'For `open`/`find`, or any mix of kinds, split into one call per `open[]` entry, `find[]` entry, or `search_query[]` batch.',
    );
  }
  const batch = await startBatchFetch(parsed, session);
  return await executeOperationToIr(parsed.ops[0], session, batch);
};
