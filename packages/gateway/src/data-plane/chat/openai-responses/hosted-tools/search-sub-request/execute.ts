import type { Fields, WebSearchRequest } from './facts.ts';
import type { SearchServices, WebSearchRuntime } from './services.ts';
import { providerEntry } from '../../../../pipeline/provider-entry.ts';
import { providerCalls } from '../../../../pipeline/provider-usage.ts';
import { spentBody } from '../../../../pipeline/upstream-body.ts';
import { upstreamPerformanceContext } from '../../../../shared/telemetry/attribution.ts';
import { executeAlphaSearch } from '../../../../tools/web-search/alpha-search/execution.ts';
import type { AlphaSearchDispatcher } from '../../../../tools/web-search/alpha-search/upstream.ts';
import { assertLocalWebSearchSupport, executeOperationToIr, parseWebSearchOperations, runBackendSearchMulti, schemaErrorIr, startBatchFetch, UnsupportedLocalWebSearchFeatureError, unsupportedLocalWebSearchFeatureIr, type WebSearchCallIR, type WebSearchOperation } from '../../../../tools/web-search/operations.ts';
import { exchangeResponse } from '@floway-dev/http/pipeline';
import { defineStage, move } from '@floway-dev/pipeline';
import type { OpenAIResponsesWebSearchAction } from '@floway-dev/protocols/openai-responses';
import type { ProviderOperationRequest, ProviderResponse } from '@floway-dev/provider';

const ITERATION_CAP = 30;

export const runWebSearchCall = defineStage<
  Fields<'request.webSearch.canonical'>,
  ProviderOperationRequest<'alphaSearch'>,
  ProviderResponse,
  Fields<'response.webSearch.ir' | 'response.usage.billable'>,
  Fields<'response.webSearch.ir' | 'response.usage.billable'>,
  SearchServices
>({
  name: 'runWebSearchCall',
  into: {
    request: { needs: ['request.webSearch.canonical'], consumes: [], provides: ['request.provider.model', 'request.provider.payload', 'request.http.callId', 'request.http.headers'] },
    response: { needs: ['response.http.exchange', 'response.http.body', 'response.provider.called', 'response.provider.modelKey', 'response.provider.previousCalls'], consumes: ['response.http.exchange', 'response.http.body', 'response.provider.called', 'response.provider.modelKey', 'response.provider.previousCalls'], provides: ['response.webSearch.ir', 'response.usage.billable'] },
  },
  return: { provides: ['response.webSearch.ir', 'response.usage.billable'] },
  execute: async (facts, next, use) => {
    let billable: Fields<'response.usage.billable'>['response.usage.billable'] = [];
    const dispatch: AlphaSearchDispatcher = async (body, _signal, headers) => {
      const alpha = use.webSearch.alpha;
      if (alpha === undefined) throw new Error('Alpha Search was dispatched without a selected provider');
      const candidate = await alpha.candidate;
      const pipeline = candidate.provider.pipelines.alphaSearch;
      if (pipeline === undefined) throw new Error(`Provider ${candidate.provider.kind} has no Alpha Search pipeline`);
      const selector = use.rememberCandidates([candidate])[0];
      use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, 'chat');
      const { model: _callerModel, ...payload } = body;
      const back = await next(providerEntry({ ...facts, 'route.attempt': selector, 'ingress.http.headers': [...headers] }, candidate, payload), pipeline);
      billable = providerCalls(candidate, back as unknown as Record<string, unknown>);
      const exchange = back['response.http.exchange'];
      if (exchange.type === 'transportFailure') throw exchange.error;
      const response = exchangeResponse(exchange);
      // Formatting reads the finite body before the child returns; release then has no bytes left.
      const bytes = await response.arrayBuffer();
      spentBody(exchange.body);
      return new Response(exchange.body === null ? null : bytes, { status: exchange.status, statusText: exchange.statusText, headers: exchange.headers.map(([name, value]): [string, string] => [name, value]) });
    };
    const ir = await execute(facts['request.webSearch.canonical'], use.webSearch, dispatch);
    return move({ ...facts, 'response.webSearch.ir': ir, 'response.usage.billable': billable });
  },
});

const execute = async (request: WebSearchRequest, runtime: WebSearchRuntime, dispatch: AlphaSearchDispatcher): Promise<WebSearchCallIR> => {
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
  if (runtime.alpha !== undefined) {
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
    return await executeAlphaSearch({ dispatcher: dispatch, sessionId: runtime.alpha.sessionId, commands: request.commands, settings: request.settings, input: request.input, action, signal: runtime.session.signal });
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
