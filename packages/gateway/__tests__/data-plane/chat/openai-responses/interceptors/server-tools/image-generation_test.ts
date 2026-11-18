import { beforeEach, test } from 'vitest';

import {
  inspectImageSources,
  DEFAULT_IMAGE_MODEL,
  imageGenerationServerTool,
  imageTerminal,
  parseImageStreamEvent,
  parseRetryAfterMs,
  prepareImageGenerationConfig,
  resolveImageOperation,
  SHIM_TOOL_NAME,
  expandImageGenerationCall,
} from '../../../../../../src/data-plane/chat/openai-responses/interceptors/server-tools/image-generation.ts';
import type { OpenAIResponsesInvocation } from '../../../../../../src/data-plane/chat/openai-responses/interceptors/types.ts';
import { initRepo } from '../../../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../../../test-utils/gateway-ctx.ts';
import { initExternalResourceFetcher } from '@floway-dev/platform';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputImage, OpenAIResponsesInputImageGenerationCall, CanonicalOpenAIResponsesInputItem, OpenAIResponsesPayloadEx, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals, assertFalse, assertStringIncludes, assertThrows, stubModelCandidate } from '@floway-dev/test-utils';

const PNG_B64 = 'aGVsbG8='; // "hello" — any decodable base64 works for source tests.
const VALID_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/wEAAAAASUVORK5CYII=';
const validPngResponse = (): Response => new Response(Uint8Array.from(atob(VALID_PNG_B64), c => c.charCodeAt(0)), {
  headers: { 'content-type': 'image/png' },
});
const paddedPngResponse = (byteLength: number): Response => {
  const bytes = new Uint8Array(byteLength);
  bytes.set(Uint8Array.from(atob(VALID_PNG_B64), c => c.charCodeAt(0)));
  return new Response(bytes, { headers: { 'content-type': 'image/png' } });
};

// The registration only reads targetApi / enabledFlags / payload off the invocation.
const makeCtx = (payload: Partial<OpenAIResponsesPayloadEx>): OpenAIResponsesInvocation => ({
  candidate: stubModelCandidate({
    enabledFlags: new Set(['openai-responses-image-generation-shim']),
    model: { id: 'm', endpoints: { openaiResponses: {} } },
  }),
  targetApi: 'openaiResponses',
  payload: { model: 'm', input: [], ...payload } as CanonicalOpenAIResponsesPayload,
  headers: new Headers(),
  action: 'generate',
});
const gatewayCtx = () => mockChatGatewayCtx({ wantsStream: true });

beforeEach(() => {
  initRepo(new InMemoryRepo());
});

const imageInputContainers = {
  message: (image: OpenAIResponsesInputImage): CanonicalOpenAIResponsesInputItem => ({ type: 'message', role: 'user', content: [image] }),
  function_output: (image: OpenAIResponsesInputImage): CanonicalOpenAIResponsesInputItem => ({ type: 'function_call_output', call_id: 'call_function', output: [image] }),
  custom_output: (image: OpenAIResponsesInputImage): CanonicalOpenAIResponsesInputItem => ({ type: 'custom_tool_call_output', call_id: 'call_custom', output: [image] }),
};

const unresolvableImages = {
  file_id: { type: 'input_image', file_id: 'file_1', detail: 'auto' },
  malformed: { type: 'input_image', image_url: 'data:image/png;base64,%%%', detail: 'auto' },
} as const satisfies Record<string, OpenAIResponsesInputImage>;

const unresolvableSourceCases = ([
  ['file_id', 'message', 'generate'],
  ['file_id', 'function_output', 'edit'],
  ['file_id', 'custom_output', 'auto'],
  ['malformed', 'message', 'generate'],
  ['malformed', 'custom_output', 'edit'],
] as const).map(([source, container, action]) => ({
  source,
  container,
  action,
  input: imageInputContainers[container](unresolvableImages[source]),
  path: `input[0].${container === 'message' ? 'content' : 'output'}[0].${source === 'file_id' ? 'file_id' : 'image_url'}`,
}));

// ── prepareImageGenerationConfig ──

test('prepareImageGenerationConfig decodes image_url masks and reports file_id as a Floway limitation', () => {
  const ok = prepareImageGenerationConfig([{ type: 'image_generation', input_image_mask: { image_url: `data:image/png;base64,${PNG_B64}` } } as OpenAIResponsesTool]);
  assert(ok.ok);
  assert(ok.config.mask !== undefined && !('wireUrl' in ok.config.mask));
  assertEquals(ok.config.mask.mimeType, 'image/png');
  assertEquals(ok.config.mask.bytes.byteLength, 5);

  const expectedFileIdError = {
    message: 'Floway cannot resolve input_image_mask.file_id; remove file_id and provide image_url alone.',
    param: 'tools[0].input_image_mask.file_id',
    code: 'unsupported_image_source',
  };
  const fileId = prepareImageGenerationConfig([{ type: 'image_generation', input_image_mask: { file_id: 'file_123' } } as OpenAIResponsesTool]);
  assert(!fileId.ok);
  assertEquals(fileId.error, expectedFileIdError);

  const inlineBoth = prepareImageGenerationConfig([{
    type: 'image_generation',
    input_image_mask: { image_url: `data:image/png;base64,${PNG_B64}`, file_id: 'file_123' },
  } as OpenAIResponsesTool]);
  assert(!inlineBoth.ok);
  assertEquals(inlineBoth.error, expectedFileIdError);

  const remoteBoth = prepareImageGenerationConfig([{
    type: 'image_generation',
    input_image_mask: { file_id: 'file_123', image_url: 'https://example.com/mask.png' },
  } as OpenAIResponsesTool]);
  assert(remoteBoth.ok);
  assert(remoteBoth.config.mask !== undefined && 'wireUrl' in remoteBoth.config.mask);
  assertEquals(remoteBoth.config.mask.afterMaterializationError, expectedFileIdError);
});

test('inspectImageSources rejects bare base64 with the native input_image error', () => {
  const inspection = inspectImageSources([imageInputContainers.message({
    type: 'input_image', image_url: 'AAAA', detail: 'auto',
  })]);
  assertEquals(inspection.issue, {
    kind: 'native',
    error: {
      message: "Invalid 'input[0].content[0].image_url'. Expected a valid URL, but got a value with an invalid format.",
      errorType: 'invalid_request_error',
      param: 'input[0].content[0].image_url',
      code: 'invalid_value',
    },
  });
});

test.each(Object.entries(imageInputContainers).filter(([container]) => container !== 'function_output'))(
  'inspectImageSources mirrors the native mutually-exclusive error in %s',
  (container, wrap) => {
    const inspection = inspectImageSources([wrap({
      type: 'input_image',
      image_url: `data:image/png;base64,${PNG_B64}`,
      file_id: 'assistant-file_1',
      detail: 'auto',
    })]);
    const path = `input[0].${container === 'message' ? 'content' : 'output'}[0]`;
    assertEquals(inspection.issue, {
      kind: 'native',
      error: {
        message: `Mutually exclusive parameters: '${path}'. Ensure you are only providing one of: 'file_id' or 'image_url'.`,
        errorType: 'invalid_request_error',
        param: path,
        code: 'mutually_exclusive_parameters',
      },
    });
  },
);

test('resolveImageOperation exposes a malformed replayed result as an invariant failure', () => {
  const inspection = inspectImageSources([
    { type: 'image_generation_call', id: 'ig_bad', status: 'completed', result: '%%%' },
  ]);
  assertEquals(inspection.sources, []);
  assertThrows(
    () => resolveImageOperation({ model: DEFAULT_IMAGE_MODEL, action: 'auto' }, inspection),
    Error,
    'Stored image_generation_call at input[0] contains invalid result bytes.',
  );
});

// ── expandImageGenerationCall ──

// ── imageTerminal ──

test.each([false, true])('image replay records input fields independently of success or failure: %s', failed => {
  const echo = { size: '1024x1024', quality: 'high', output_format: 'png', background: 'opaque' } as const;
  const terminal = imageTerminal('a cat', 'generate', failed
    ? { ok: false, error: { type: 'image_generation_error', message: 'failed', code: 'server_error', retryable: true } }
    : { ok: true, b64: PNG_B64, echo });
  assertEquals(terminal.replayData, {
    action: failed ? undefined : 'generate', revised_prompt: 'a cat',
    size: failed ? undefined : echo.size, quality: failed ? undefined : echo.quality,
    output_format: failed ? undefined : echo.output_format, background: failed ? undefined : echo.background,
  });
  const item = { ...terminal.item, id: 'ig_echo' } as OpenAIResponsesInputImageGenerationCall;
  const matched = expandImageGenerationCall(item, { data: terminal.replayData });
  assertEquals(matched.callSource, 'replay');
  assertFalse(Object.hasOwn(matched, 'synthesizedCall'));
  assertEquals(expandImageGenerationCall({ ...item, result: 'b3RoZXI=' }, { data: terminal.replayData }).callSource, 'replay');
  assertEquals(expandImageGenerationCall({ ...item, revised_prompt: 'different' }, { data: terminal.replayData }).callSource, 'synthesized');
});

// ── parseImageStreamEvent ──

test('parseImageStreamEvent maps generations and edits partial/completed/error with backend echo', () => {
  const genPartial = parseImageStreamEvent(JSON.stringify({ type: 'image_generation.partial_image', partial_image_index: 1, b64_json: PNG_B64, background: 'opaque', output_format: 'png', quality: 'low', size: '1024x1024' }));
  assert(genPartial?.kind === 'partial');
  assertEquals(genPartial.index, 1);
  assertEquals(genPartial.b64, PNG_B64);
  assertEquals(genPartial.echo, { background: 'opaque', output_format: 'png', quality: 'low', size: '1024x1024' });

  const editPartial = parseImageStreamEvent(JSON.stringify({ type: 'image_edit.partial_image', partial_image_index: 0, b64_json: PNG_B64 }));
  assert(editPartial?.kind === 'partial');
  assertEquals(editPartial.echo, {});

  const completed = parseImageStreamEvent(JSON.stringify({ type: 'image_generation.completed', b64_json: PNG_B64, usage: { total_tokens: 1 }, quality: 'high' }));
  assert(completed?.kind === 'completed');
  assertEquals(completed.b64, PNG_B64);
  assertEquals(completed.echo.quality, 'high');

  const err = parseImageStreamEvent(JSON.stringify({ type: 'error', error: { type: 'image_generation_server_error', code: 'image_generation_failed', message: 'boom' } }));
  assert(err?.kind === 'error');
  assertEquals(err.error.code, 'image_generation_failed');
  assertEquals(err.error.retryable, true);
});

test('prepareImageGenerationConfig validates every hosted entry, not just the last', () => {
  const result = prepareImageGenerationConfig([
    { type: 'image_generation', n: 2 } as OpenAIResponsesTool,
    { type: 'image_generation', quality: 'low' } as OpenAIResponsesTool,
  ]);
  assert(!result.ok);
  assertEquals(result.error.code, 'unknown_parameter');
  assertEquals(result.error.param, 'tools[0].n');
});

// ── parseRetryAfterMs ──

test('parseRetryAfterMs interprets Retry-After HTTP-date as delta from now', () => {
  // HTTP-date is 1-second resolution and Date.parse() strips ms, so allow a
  // ~1s skew between toUTCString() and the parser's Date.now().
  const future = new Date(Date.now() + 10_000).toUTCString();
  const h = new Headers({ 'retry-after': future });
  const result = parseRetryAfterMs(h);
  assert(result !== null);
  assert(result > 0 && result <= 11_000);
});

test('parseRetryAfterMs returns null for zero / negative values (gpt-image-1 "0.0s" hint)', () => {
  assertEquals(parseRetryAfterMs(new Headers({ 'retry-after-ms': '0' })), null);
  assertEquals(parseRetryAfterMs(new Headers({ 'retry-after': '0' })), null);
  assertEquals(parseRetryAfterMs(new Headers({ 'retry-after': '-5' })), null);
});

test('imageGenerationServerTool enforces the aggregate limit across distinct successful downloads', async () => {
  let requests = 0;
  initExternalResourceFetcher(() => {
    requests += 1;
    return Promise.resolve(paddedPngResponse(26 * 1024 * 1024));
  });

  const result = await imageGenerationServerTool(
    makeCtx({
      tools: [{ type: 'image_generation', action: 'edit' }],
      input: [
        imageInputContainers.message({ type: 'input_image', image_url: 'https://example.com/first.png', detail: 'auto' }),
        imageInputContainers.message({ type: 'input_image', image_url: 'https://example.com/second.png', detail: 'auto' }),
      ],
    }),
    gatewayCtx(),
  );

  assert(result.type === 'invalid-request');
  assertEquals(result.message, 'Error while downloading file.');
  assertEquals(result.param, 'url');
  assertEquals(result.code, 'invalid_value');
  assertEquals(requests, 2);
});

test.each([
  {
    name: 'DNS failure',
    fetcher: () => Promise.reject(new TypeError('getaddrinfo ENOTFOUND')),
    message: 'Error while downloading file.',
  },
  {
    name: 'HTTP 404',
    fetcher: () => Promise.resolve(new Response(null, { status: 404 })),
    message: 'Error while downloading file. Upstream status code: 404.',
  },
  {
    name: 'oversized response',
    fetcher: () => Promise.resolve(new Response(Uint8Array.of(1), {
      headers: { 'content-length': String(50 * 1024 * 1024 + 1) },
    })),
    message: 'Error while downloading file.',
  },
])('imageGenerationServerTool mirrors the native remote-source error for $name', async ({ fetcher, message }) => {
  initExternalResourceFetcher(fetcher);
  const result = await imageGenerationServerTool(
    makeCtx({
      tools: [{ type: 'image_generation', action: 'edit' }],
      input: [imageInputContainers.message({ type: 'input_image', image_url: 'https://example.invalid/source.png', detail: 'auto' })],
    }),
    gatewayCtx(),
  );

  assert(result.type === 'invalid-request');
  assertEquals(result.message, message);
  assertEquals(result.errorType, 'invalid_request_error');
  assertEquals(result.param, 'url');
  assertEquals(result.code, 'invalid_value');
});

test('imageGenerationServerTool materializes a remote mask and mirrors its download error', async () => {
  initExternalResourceFetcher(() => Promise.resolve(validPngResponse()));
  const accepted = await imageGenerationServerTool(
    makeCtx({ tools: [{ type: 'image_generation', action: 'generate', input_image_mask: { image_url: 'https://example.com/mask.png' } }] }),
    gatewayCtx(),
  );
  assert(accepted.type === 'active');

  initExternalResourceFetcher(() => Promise.resolve(new Response(null, { status: 404 })));
  const rejected = await imageGenerationServerTool(
    makeCtx({ tools: [{ type: 'image_generation', action: 'edit', input_image_mask: { image_url: 'https://example.com/missing.png' } }] }),
    gatewayCtx(),
  );
  assert(rejected.type === 'invalid-request');
  assertEquals(rejected.message, 'There was an issue with your request. Please check your inputs and try again');
  assertEquals(rejected.errorType, 'invalid_request_error');
  assertEquals(rejected.param, null);
  assertEquals(rejected.code, null);
});

test('imageGenerationServerTool validates a remote mask before applying the Floway file-ID guard', async () => {
  let requests = 0;
  initExternalResourceFetcher(() => {
    requests += 1;
    return Promise.resolve(validPngResponse());
  });
  const result = await imageGenerationServerTool(
    makeCtx({
      tools: [{
        type: 'image_generation',
        action: 'edit',
        input_image_mask: { file_id: 'file_123', image_url: 'https://example.com/mask.png' },
      }],
    }),
    gatewayCtx(),
  );

  assert(result.type === 'invalid-request');
  assertEquals(result.message, 'Floway cannot resolve input_image_mask.file_id; remove file_id and provide image_url alone.');
  assertEquals(result.param, 'tools[0].input_image_mask.file_id');
  assertEquals(result.code, 'unsupported_image_source');
  assertEquals(requests, 1);
});

test.each(unresolvableSourceCases)(
  'imageGenerationServerTool handles $source images in $container for action $action',
  async ({ source, action, input, path }) => {
    const result = await imageGenerationServerTool(
      makeCtx({ tools: [{ type: 'image_generation', action }], input: [input] }),
      gatewayCtx(),
    );
    if (source !== 'malformed' && action === 'generate') {
      assert(result.type === 'active');
    } else {
      assert(result.type === 'invalid-request');
      assertEquals(result.errorType, 'invalid_request_error');
      assertEquals(result.param, path);
      if (source === 'malformed') {
        assertEquals(result.code, 'invalid_value');
        assertEquals(
          result.message,
          `Invalid '${path}'. Expected a base64-encoded data URL with an image MIME type (e.g. 'data:image/png;base64,aW1nIGJ5dGVzIGhlcmU='), but got an invalid base64-encoded value.`,
        );
      } else {
        assertEquals(result.code, 'unsupported_image_source');
        assertStringIncludes(result.message, 'Floway cannot use');
      }
    }
  },
);

test.each([
  { requested: 'generate' as const, resolved: 'generate' as const, sourceCount: 0 },
  { requested: 'auto' as const, resolved: 'edit' as const, sourceCount: 1 },
])('mask-only action $requested resolves to $resolved', ({ requested, resolved, sourceCount }) => {
  const prepared = prepareImageGenerationConfig([{
    type: 'image_generation',
    action: requested,
    input_image_mask: { image_url: `data:image/png;base64,${PNG_B64}` },
  }]);
  assert(prepared.ok);
  const operation = resolveImageOperation(prepared.config, inspectImageSources([]));
  assert(operation.ok);
  assertEquals(operation.action, resolved);
  assertEquals(operation.sources.length, sourceCount);
});

test('imageGenerationServerTool rejects explicit edit without an input image', async () => {
  const result = await imageGenerationServerTool(
    makeCtx({ tools: [{ type: 'image_generation', action: 'edit' }] }),
    gatewayCtx(),
  );
  assert(result.type === 'invalid-request');
  assertEquals(result.message, "ImageGenTool action 'edit' requires an image, mask, or previous context");
  assertEquals(result.errorType, 'image_generation_user_error');
  assertEquals(result.code, null);
  assertEquals(result.param, 'input');
});

test('image dispatcher exposes a newly introduced invalid edit source as an invariant failure', async () => {
  const invocation = makeCtx({ tools: [{ type: 'image_generation', action: 'auto' }] });
  const result = await imageGenerationServerTool(invocation, gatewayCtx());
  assert(result.type === 'active' && result.hosted !== undefined);

  invocation.payload = {
    ...invocation.payload,
    input: [imageInputContainers.custom_output({
      type: 'input_image', image_url: 'https://example.com/late.png', detail: 'auto',
    })],
  };
  assertThrows(
    () => result.hosted?.dispatcher({
      intercepted: { functionCall: { type: 'function_call', call_id: 'call_live_invalid', name: SHIM_TOOL_NAME, arguments: '{"prompt":"edit it"}', status: 'completed' }, parsedArguments: { prompt: 'edit it' } },
      loopState: { iterationCount: 2, remainingToolCalls: undefined },
    }),
    Error,
    'image_generation live source invariant violated after request validation: remote image URL was not materialized',
  );
});

// ── imageGenerationServerTool: per-response dispatch budget ──

test('image dispatch budget caps real backend calls per response, not ReAct turns', async () => {
  const result = await imageGenerationServerTool(makeCtx({ tools: [{ type: 'image_generation', action: 'generate' }] }), gatewayCtx());
  assert(result.type === 'active' && result.hosted !== undefined);
  const dispatch = result.hosted.dispatcher;
  const intercepted = { functionCall: { type: 'function_call' as const, call_id: 'c', name: SHIM_TOOL_NAME, arguments: '{"prompt":"x"}', status: 'completed' }, parsedArguments: { prompt: 'x' } };
  const loopState = { iterationCount: 1, remainingToolCalls: undefined };

  for (let i = 0; i < 10; i++) {
    const slots = dispatch({ intercepted, loopState });
    assertEquals(slots.length, 1);
  }
  const overBudget = dispatch({ intercepted, loopState });
  const lifecycle = overBudget[0].run();
  let step = await lifecycle.next();
  while (!step.done) step = await lifecycle.next();
  const item = step.value.item as { status?: string; error?: { code?: string } };
  assertEquals(item.status, 'failed');
  assertEquals(item.error?.code, 'tool_call_budget_exhausted');
});
