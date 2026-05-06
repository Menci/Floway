import {
  type ResponseInputItem,
  type ResponseOutputFunctionCall,
  type ResponseOutputItem,
  type ResponseOutputWebSearchCall,
  type ResponsesPayload,
  type ResponsesResult,
  type ResponseStreamEvent,
  type ResponseTool,
  type ResponseWebSearchTool,
} from "../../../../../lib/responses-types.ts";
import { isRecord } from "../../../../../lib/type-guards.ts";
import { toInternalDebugError } from "../../../shared/errors/internal-debug-error.ts";
import {
  eventResult,
  type InternalErrorResult,
  internalErrorResult,
  type UpstreamErrorResult,
} from "../../../shared/errors/result.ts";
import { jsonFrame, type StreamFrame } from "../../../shared/stream/types.ts";
import type { EmitInput } from "../../emit-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import { loadSearchConfig } from "../../../../tools/web-search/search-config.ts";
import { resolveConfiguredWebSearchProvider } from "../../../../tools/web-search/provider.ts";
import type {
  WebSearchProvider,
} from "../../../../tools/web-search/provider.ts";
import {
  searchWebAndRecordUsage,
  searchWebWithoutRecordingUsage,
} from "../../../../tools/web-search/search.ts";
import type {
  WebSearchProviderName,
  WebSearchProviderRequest,
  WebSearchProviderResult,
} from "../../../../tools/web-search/types.ts";

const CODEX_WEB_SEARCH_TOOL_NAME = "web_search";
const MAX_CODEX_WEB_SEARCH_CALL_ROUNDS = 5;

interface ActiveResponsesWebSearchProvider {
  providerName: WebSearchProviderName;
  search: WebSearchProvider;
  apiKeyId?: string;
}

interface PreparedResponsesWebSearchRequest {
  type: "ok";
  payload: ResponsesPayload;
  tool: ResponseWebSearchTool;
}

interface ExecutedWebSearchCall {
  call: ResponseOutputFunctionCall;
  query: string;
  output: Extract<ResponseInputItem, { type: "function_call_output" }>;
  item: ResponseOutputWebSearchCall;
}

const buildSyntheticInvalidRequestUpstreamError = (
  message: string,
): UpstreamErrorResult => ({
  type: "upstream-error",
  status: 400,
  headers: new Headers({ "content-type": "application/json" }),
  body: new TextEncoder().encode(JSON.stringify({
    error: {
      type: "invalid_request_error",
      message,
    },
  })),
});

const isResponsesWebSearchTool = (
  tool: ResponseTool,
): tool is ResponseWebSearchTool => tool.type === "web_search";

const normalizeNonEmptyDomainList = (
  domains?: string[],
): string[] | undefined => {
  const normalized = domains?.map((domain) => domain.trim()).filter((domain) =>
    domain.length > 0
  );
  return normalized && normalized.length > 0
    ? [...new Set(normalized)]
    : undefined;
};

const buildUpstreamWebSearchFunctionTool = (): Extract<
  ResponseTool,
  { type: "function" }
> => ({
  type: "function",
  name: CODEX_WEB_SEARCH_TOOL_NAME,
  description: "Search the web for up-to-date information from web sources.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  strict: false,
});

const prepareResponsesWebSearchRequest = (
  payload: ResponsesPayload,
): PreparedResponsesWebSearchRequest | UpstreamErrorResult | null => {
  const tools = payload.tools ?? [];
  const webSearchTools = tools.filter(isResponsesWebSearchTool);
  if (webSearchTools.length === 0) return null;

  if (webSearchTools.length > 1) {
    return buildSyntheticInvalidRequestUpstreamError(
      "Only one Responses web_search tool definition is supported per request.",
    );
  }

  if (
    tools.some((tool) =>
      !isResponsesWebSearchTool(tool) && "name" in tool &&
      tool.name === CODEX_WEB_SEARCH_TOOL_NAME
    )
  ) {
    return buildSyntheticInvalidRequestUpstreamError(
      `Responses web_search tool name collides with another tool: ${CODEX_WEB_SEARCH_TOOL_NAME}.`,
    );
  }

  const tool = webSearchTools[0];
  const rewrittenTools = tools.map((entry) =>
    isResponsesWebSearchTool(entry)
      ? buildUpstreamWebSearchFunctionTool()
      : entry
  );
  const toolChoice = payload.tool_choice;

  return {
    type: "ok",
    payload: {
      ...payload,
      tools: rewrittenTools,
      ...(isRecord(toolChoice) && toolChoice.type === "web_search"
        ? {
          tool_choice: { type: "function", name: CODEX_WEB_SEARCH_TOOL_NAME },
        }
        : {}),
    },
    tool,
  };
};

const resolveActiveResponsesWebSearchProvider = async (
  sourceApi: EmitInput<ResponsesPayload>["sourceApi"],
  apiKeyId: string | undefined,
): Promise<
  | { type: "ok"; provider: ActiveResponsesWebSearchProvider }
  | InternalErrorResult
> => {
  const searchConfig = await loadSearchConfig();
  const configuredProvider = resolveConfiguredWebSearchProvider(searchConfig);

  if (configuredProvider.type === "enabled") {
    return {
      type: "ok",
      provider: {
        providerName: configuredProvider.provider,
        search: configuredProvider.search,
        ...(apiKeyId ? { apiKeyId } : {}),
      },
    };
  }

  return internalErrorResult(
    500,
    toInternalDebugError(
      new Error(
        configuredProvider.type === "disabled"
          ? "Responses web_search requires an enabled search provider."
          : `Responses web_search is missing the configured ${configuredProvider.provider} credential.`,
      ),
      sourceApi,
      "responses",
    ),
  );
};

const parseSseResponseEvent = (
  frame: Extract<StreamFrame<ResponsesResult>, {
    type: "sse";
  }>,
): ResponseStreamEvent | null => {
  const data = frame.data.trim();
  if (!data || data === "[DONE]") return null;

  const parsed = JSON.parse(data) as ResponseStreamEvent;
  return frame.event && !(parsed as { type?: string }).type
    ? { ...parsed, type: frame.event }
    : parsed;
};

const isResponseOutputItemDoneEvent = (
  event: ResponseStreamEvent,
): event is Extract<
  ResponseStreamEvent,
  { type: "response.output_item.done" }
> => event.type === "response.output_item.done";

const isResponseTerminalEvent = (
  event: ResponseStreamEvent,
): event is Extract<
  ResponseStreamEvent,
  {
    type: "response.completed" | "response.incomplete" | "response.failed";
  }
> =>
  event.type === "response.completed" ||
  event.type === "response.incomplete" || event.type === "response.failed";

const responseOutputText = (output: ResponseOutputItem[]): string =>
  output.flatMap((item) =>
    item.type === "message"
      ? item.content.flatMap((part) =>
        part.type === "output_text" ? [part.text] : []
      )
      : []
  ).join("");

const responseWithStreamOutputFallback = (
  response: ResponsesResult,
  streamOutput: Map<number, ResponseOutputItem>,
): ResponsesResult => {
  if (response.output.length > 0 || streamOutput.size === 0) return response;

  const output = [...streamOutput.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, item]) => item);

  return {
    ...response,
    output,
    output_text: response.output_text || responseOutputText(output),
  };
};

const collectResponsesResult = async (
  frames: AsyncIterable<StreamFrame<ResponsesResult>>,
): Promise<ResponsesResult> => {
  const streamOutput = new Map<number, ResponseOutputItem>();

  for await (const frame of frames) {
    if (frame.type === "json") return frame.data;

    const event = parseSseResponseEvent(frame);
    if (!event) continue;

    if (event.type === "error") {
      throw new Error(
        typeof event.message === "string"
          ? event.message
          : JSON.stringify(event),
      );
    }

    if (isResponseOutputItemDoneEvent(event)) {
      streamOutput.set(event.output_index, event.item);
      continue;
    }

    if (isResponseTerminalEvent(event)) {
      return responseWithStreamOutputFallback(event.response, streamOutput);
    }
  }

  throw new Error(
    "Responses web_search upstream stream ended without a terminal event.",
  );
};

const getWebSearchFunctionCalls = (
  response: ResponsesResult,
): ResponseOutputFunctionCall[] =>
  response.output.filter((item): item is ResponseOutputFunctionCall =>
    item.type === "function_call" && item.name === CODEX_WEB_SEARCH_TOOL_NAME
  );

const hasClientFunctionCalls = (response: ResponsesResult): boolean =>
  response.output.some((item) =>
    item.type === "function_call" && item.name !== CODEX_WEB_SEARCH_TOOL_NAME
  );

const normalizeWebSearchQuery = (call: ResponseOutputFunctionCall): string => {
  try {
    const parsed = JSON.parse(call.arguments);
    return isRecord(parsed) && typeof parsed.query === "string"
      ? parsed.query.trim()
      : "";
  } catch {
    return "";
  }
};

const resultContentText = (
  content: Extract<
    WebSearchProviderResult,
    { type: "ok" }
  >["results"][number]["content"],
): string => content.map((block) => block.text).join("\n");

const providerResultForModel = (
  result: WebSearchProviderResult,
): unknown =>
  result.type === "ok"
    ? {
      results: result.results.map((entry) => ({
        title: entry.title,
        url: entry.source,
        ...(entry.pageAge ? { page_age: entry.pageAge } : {}),
        content: resultContentText(entry.content),
      })),
    }
    : {
      error: {
        code: result.errorCode,
        ...(result.message ? { message: result.message } : {}),
      },
    };

const searchWithActiveResponsesWebSearchProvider = (
  provider: ActiveResponsesWebSearchProvider,
  request: WebSearchProviderRequest,
): Promise<WebSearchProviderResult> =>
  provider.apiKeyId
    ? searchWebAndRecordUsage({
      provider: provider.search,
      providerName: provider.providerName,
      keyId: provider.apiKeyId,
      request,
    })
    : searchWebWithoutRecordingUsage({
      provider: provider.search,
      request,
    });

const toSyntheticWebSearchCallId = (
  call: ResponseOutputFunctionCall,
  index: number,
): string => {
  const suffix = call.call_id.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40);
  return suffix ? `ws_${suffix}` : `ws_${index}`;
};

const executeWebSearchCall = async (
  provider: ActiveResponsesWebSearchProvider,
  tool: ResponseWebSearchTool,
  call: ResponseOutputFunctionCall,
  index: number,
): Promise<ExecutedWebSearchCall> => {
  const query = normalizeWebSearchQuery(call);
  const result = query.length === 0
    ? {
      type: "error" as const,
      errorCode: "invalid_tool_input" as const,
      message: "Search query must not be empty.",
    }
    : await searchWithActiveResponsesWebSearchProvider(provider, {
      query,
      allowedDomains: normalizeNonEmptyDomainList(
        tool.filters?.allowed_domains,
      ),
      userLocation: tool.user_location
        ? {
          city: tool.user_location.city,
          region: tool.user_location.region,
          country: tool.user_location.country,
          timezone: tool.user_location.timezone,
        }
        : undefined,
    });

  return {
    call,
    query,
    output: {
      type: "function_call_output",
      call_id: call.call_id,
      output: JSON.stringify(providerResultForModel(result)),
      status: "completed",
    },
    item: {
      type: "web_search_call",
      id: toSyntheticWebSearchCallId(call, index),
      status: "completed",
      action: { type: "search", query },
    },
  };
};

const toFunctionCallInputItem = (
  call: ResponseOutputFunctionCall,
): Extract<ResponseInputItem, { type: "function_call" }> => ({
  type: "function_call",
  call_id: call.call_id,
  name: call.name,
  arguments: call.arguments,
  status: call.status === "in_progress" || call.status === "incomplete"
    ? call.status
    : "completed",
});

const toContinuationInputItem = (
  item: ResponseOutputItem,
): ResponseInputItem | null => {
  if (item.type === "function_call") return toFunctionCallInputItem(item);
  if (item.type === "web_search_call") return null;
  return item as ResponseInputItem;
};

const inputItems = (input: ResponsesPayload["input"]): ResponseInputItem[] =>
  typeof input === "string"
    ? [{ type: "message", role: "user", content: input }]
    : [...input];

const appendSearchOutputsToPayload = (
  payload: ResponsesPayload,
  response: ResponsesResult,
  executed: ExecutedWebSearchCall[],
): ResponsesPayload => {
  const choice = payload.tool_choice;
  let nextPayload = payload;
  if (
    isRecord(choice) && choice.type === "function" &&
    choice.name === CODEX_WEB_SEARCH_TOOL_NAME
  ) {
    const { tool_choice: _toolChoice, ...rest } = payload;
    nextPayload = rest;
  }

  return {
    ...nextPayload,
    input: [
      ...inputItems(payload.input),
      ...response.output.flatMap((item) => {
        const inputItem = toContinuationInputItem(item);
        return inputItem ? [inputItem] : [];
      }),
      ...executed.map((entry) => entry.output),
    ],
  };
};

const withoutInternalWebSearchFunctionCalls = (
  response: ResponsesResult,
): ResponsesResult => ({
  ...response,
  output: response.output.filter((item) =>
    item.type !== "function_call" || item.name !== CODEX_WEB_SEARCH_TOOL_NAME
  ),
});

const withSyntheticWebSearchOutput = (
  response: ResponsesResult,
  calls: ResponseOutputWebSearchCall[],
): ResponsesResult =>
  calls.length === 0 ? response : {
    ...response,
    output: [...calls, ...response.output],
  };

const withHostedWebSearchResponseSurface = (
  response: ResponsesResult,
  tool: ResponseWebSearchTool,
): ResponsesResult => {
  const responseFields = response as ResponsesResult & {
    tools?: ResponseTool[] | null;
    tool_choice?: ResponsesPayload["tool_choice"];
  };
  const toolChoice = responseFields.tool_choice;

  return {
    ...responseFields,
    ...(Array.isArray(responseFields.tools)
      ? {
        tools: responseFields.tools.map((entry) =>
          entry.type === "function" && entry.name === CODEX_WEB_SEARCH_TOOL_NAME
            ? tool
            : entry
        ),
      }
      : {}),
    ...(isRecord(toolChoice) && toolChoice.type === "function" &&
        toolChoice.name === CODEX_WEB_SEARCH_TOOL_NAME
      ? { tool_choice: { type: "web_search" as const } }
      : {}),
  };
};

const toClientWebSearchResponse = (
  response: ResponsesResult,
  tool: ResponseWebSearchTool,
  calls: ResponseOutputWebSearchCall[],
): ResponsesResult =>
  withSyntheticWebSearchOutput(
    withHostedWebSearchResponseSurface(response, tool),
    calls,
  );

const singleJsonResponseFrame = async function* (
  response: ResponsesResult,
): AsyncGenerator<StreamFrame<ResponsesResult>> {
  yield jsonFrame(response);
};

/**
 * Copilot `/responses` does not execute OpenAI hosted `web_search` tools. Codex
 * sends that hosted tool and expects Responses `web_search_call` output items,
 * not a client-visible function call. This target shim converts the hosted tool
 * into an internal function tool for Copilot, executes the configured gateway
 * search provider, continues the upstream Responses turn, and exposes only the
 * native-looking `web_search_call` surface back to Codex.
 */
export const withResponsesWebSearchShim: TargetInterceptor<
  EmitInput<ResponsesPayload>,
  ResponsesResult
> = async (ctx, run) => {
  const prepared = prepareResponsesWebSearchRequest(ctx.payload);
  if (!prepared) return await run();
  if (prepared.type === "upstream-error") return prepared;

  const provider = await resolveActiveResponsesWebSearchProvider(
    ctx.sourceApi,
    ctx.apiKeyId,
  );
  if (provider.type !== "ok") return provider;

  const webSearchOutput: ResponseOutputWebSearchCall[] = [];
  ctx.payload = prepared.payload;

  for (let round = 0; round < MAX_CODEX_WEB_SEARCH_CALL_ROUNDS; round++) {
    const result = await run();
    if (result.type !== "events") return result;

    const response = await collectResponsesResult(result.events);
    const searchCalls = getWebSearchFunctionCalls(response);
    if (searchCalls.length === 0) {
      return eventResult(singleJsonResponseFrame(
        toClientWebSearchResponse(response, prepared.tool, webSearchOutput),
      ));
    }

    const executed = await Promise.all(
      searchCalls.map((call, index) =>
        executeWebSearchCall(provider.provider, prepared.tool, call, index)
      ),
    );
    webSearchOutput.push(...executed.map((entry) => entry.item));

    if (hasClientFunctionCalls(response)) {
      return eventResult(singleJsonResponseFrame(
        toClientWebSearchResponse(
          withoutInternalWebSearchFunctionCalls(response),
          prepared.tool,
          webSearchOutput,
        ),
      ));
    }

    ctx.payload = appendSearchOutputsToPayload(ctx.payload, response, executed);
  }

  return internalErrorResult(
    502,
    toInternalDebugError(
      new Error(
        `Responses web_search exceeded ${MAX_CODEX_WEB_SEARCH_CALL_ROUNDS} internal call rounds.`,
      ),
      ctx.sourceApi,
      "responses",
    ),
  );
};
