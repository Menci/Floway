import { beforeEach, test } from 'vitest';

import {
  buildGenerationsBody,
  buildImageGenerationFunctionTool,
  createImageSourceInspector,
  inspectImageSources,
  DEFAULT_IMAGE_MODEL,
  type ImageGenerationConfig,
  type ImageOutcome,
  imageGenerationServerTool,
  imageTerminal,
  isHostedImageGenerationTool,
  parseImageStreamEvent,
  parseRetryAfterMs,
  prepareEditSources,
  prepareImageGenerationConfig,
  resolveImageOperation,
  SHIM_TOOL_NAME,
  synthesizeImageGenerationCallId,
  transformInputItemsForImageGeneration,
} from './image-generation.ts';
import { initRepo } from '../../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../../../test-helpers/gateway-ctx.ts';
import type { ResponsesInvocation } from '../types.ts';
import { initExternalResourceFetcher, initImageProcessor } from '@floway-dev/platform';
import type { CanonicalResponsesPayload, ResponsesInputImage, ResponsesInputItem, ResponsesPayload, ResponsesTool } from '@floway-dev/protocols/responses';
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
const makeCtx = (payload: Partial<ResponsesPayload>): ResponsesInvocation => ({
  candidate: stubModelCandidate({
    enabledFlags: new Set(['responses-image-generation-shim']),
    model: { id: 'm', endpoints: { responses: {} } },
  }),
  targetApi: 'responses',
  payload: { model: 'm', input: [], ...payload } as CanonicalResponsesPayload,
  headers: new Headers(),
  action: 'generate',
});
const gatewayCtx = () => mockChatGatewayCtx({ wantsStream: true });

beforeEach(() => {
  initRepo(new InMemoryRepo());
});

const imageMessage = (mime: string): ResponsesInputItem => ({
  type: 'message', role: 'user', content: [{ type: 'input_image', image_url: `data:${mime};base64,${PNG_B64}`, detail: 'auto' }],
});

const imageInputContainers = {
  message: (image: ResponsesInputImage): ResponsesInputItem => ({ type: 'message', role: 'user', content: [image] }),
  function_output: (image: ResponsesInputImage): ResponsesInputItem => ({ type: 'function_call_output', call_id: 'call_function', output: [image] }),
  custom_output: (image: ResponsesInputImage): ResponsesInputItem => ({ type: 'custom_tool_call_output', call_id: 'call_custom', output: [image] }),
};

const unresolvableImages = {
  file_id: { type: 'input_image', file_id: 'file_1', detail: 'auto' },
  malformed: { type: 'input_image', image_url: 'data:image/png;base64,%%%', detail: 'auto' },
} as const satisfies Record<string, ResponsesInputImage>;

const unresolvableSourceCases = Object.entries(unresolvableImages).flatMap(([source, image]) =>
  Object.entries(imageInputContainers).flatMap(([container, wrap]) =>
    (['auto', 'edit', 'generate'] as const).map(action => ({
      source,
      container,
      action,
      input: wrap(image),
      path: `input[0].${container === 'message' ? 'content' : 'output'}[0].${source === 'file_id' ? 'file_id' : 'image_url'}`,
    }))));

// ── isHostedImageGenerationTool ──

test('isHostedImageGenerationTool matches only the hosted image_generation type', () => {
  assert(isHostedImageGenerationTool({ type: 'image_generation' } as ResponsesTool));
  assertFalse(isHostedImageGenerationTool({ type: 'custom', name: 'x' } as ResponsesTool));
  assertFalse(isHostedImageGenerationTool({ type: 'function', name: 'x', parameters: {}, strict: false } as ResponsesTool));
});

// ── prepareImageGenerationConfig ──

test('prepareImageGenerationConfig accepts a valid hosted entry and defaults the model', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', quality: 'low', size: '1024x1024' } as ResponsesTool]);
  assert(result.ok);
  assertEquals(result.config.model, DEFAULT_IMAGE_MODEL);
  assertEquals(result.config.quality, 'low');
  assertEquals(result.config.size, '1024x1024');
  assertEquals(result.config.action, 'auto');
});

test('prepareImageGenerationConfig honors an explicit model', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', model: 'gpt-image-1.5' } as ResponsesTool]);
  assert(result.ok);
  assertEquals(result.config.model, 'gpt-image-1.5');
});

test('prepareImageGenerationConfig rejects any client-supplied n, including n:1', () => {
  for (const n of [2, 1, 0]) {
    const result = prepareImageGenerationConfig([{ type: 'image_generation', n } as ResponsesTool]);
    assertFalse(result.ok);
    assert(!result.ok);
    assertEquals(result.error.code, 'unknown_parameter');
    assertEquals(result.error.param, 'tools[0].n');
  }
});

test('prepareImageGenerationConfig rejects output_format webp', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', output_format: 'webp' } as ResponsesTool]);
  assert(!result.ok);
  assertEquals(result.error.code, 'invalid_value');
  assertEquals(result.error.param, 'tools[0].output_format');
});

test('prepareImageGenerationConfig rejects an arbitrary size', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', size: '512x512' } as ResponsesTool]);
  assert(!result.ok);
  assertEquals(result.error.code, 'invalid_value');
  assertEquals(result.error.param, 'tools[0].size');
});

test('prepareImageGenerationConfig accepts auto for size/quality/background', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', size: 'auto', quality: 'auto', background: 'auto' } as ResponsesTool]);
  assert(result.ok);
  assertEquals(result.config.size, 'auto');
  assertEquals(result.config.quality, 'auto');
  assertEquals(result.config.background, 'auto');
});

test('prepareImageGenerationConfig rejects an invalid action', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', action: 'morph' } as ResponsesTool]);
  assert(!result.ok);
  assertEquals(result.error.code, 'invalid_value');
  assertEquals(result.error.param, 'tools[0].action');
});

test('prepareImageGenerationConfig takes the last hosted entry when several are present', () => {
  const result = prepareImageGenerationConfig([
    { type: 'image_generation', quality: 'low' } as ResponsesTool,
    { type: 'image_generation', quality: 'high' } as ResponsesTool,
  ]);
  assert(result.ok);
  assertEquals(result.config.quality, 'high');
});

test('prepareImageGenerationConfig reports the concrete tool index in error.param', () => {
  const result = prepareImageGenerationConfig([
    { type: 'function', name: 'x', parameters: {}, strict: false } as ResponsesTool,
    { type: 'image_generation', size: '99x99' } as ResponsesTool,
  ]);
  assert(!result.ok);
  assertEquals(result.error.param, 'tools[1].size');
});

test('prepareImageGenerationConfig accepts output_compression in range and passes it through', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', output_compression: 80 } as ResponsesTool]);
  assert(result.ok);
  assertEquals(result.config.output_compression, 80);
});

test('prepareImageGenerationConfig rejects out-of-range output_compression', () => {
  const cases: [number, string][] = [[-1, 'integer_below_min_value'], [101, 'integer_above_max_value'], [50.5, 'invalid_value']];
  for (const [v, code] of cases) {
    const result = prepareImageGenerationConfig([{ type: 'image_generation', output_compression: v } as ResponsesTool]);
    assert(!result.ok);
    assertEquals(result.error.code, code);
    assertEquals(result.error.param, 'tools[0].output_compression');
  }
});

test('prepareImageGenerationConfig rejects unknown tool fields (Azure-strict)', () => {
  for (const field of ['seed', 'thinking', 'made_up_field']) {
    const result = prepareImageGenerationConfig([{ type: 'image_generation', [field]: 1 } as ResponsesTool]);
    assert(!result.ok);
    assertEquals(result.error.code, 'unknown_parameter');
    assertEquals(result.error.param, `tools[0].${field}`);
  }
});

test('prepareImageGenerationConfig validates input_fidelity and partial_images', () => {
  const okFidelity = prepareImageGenerationConfig([{ type: 'image_generation', input_fidelity: 'high' } as ResponsesTool]);
  assert(okFidelity.ok);
  assertEquals(okFidelity.config.input_fidelity, 'high');

  const badFidelity = prepareImageGenerationConfig([{ type: 'image_generation', input_fidelity: 'ultra' } as ResponsesTool]);
  assert(!badFidelity.ok);
  assertEquals(badFidelity.error.param, 'tools[0].input_fidelity');

  const okPartial = prepareImageGenerationConfig([{ type: 'image_generation', partial_images: 2 } as ResponsesTool]);
  assert(okPartial.ok);
  assertEquals(okPartial.config.partial_images, 2);

  const badPartial = prepareImageGenerationConfig([{ type: 'image_generation', partial_images: 9 } as ResponsesTool]);
  assert(!badPartial.ok);
  assertEquals(badPartial.error.param, 'tools[0].partial_images');
});

test('prepareImageGenerationConfig decodes image_url masks and reports file_id as a Floway limitation', () => {
  const ok = prepareImageGenerationConfig([{ type: 'image_generation', input_image_mask: { image_url: `data:image/png;base64,${PNG_B64}` } } as ResponsesTool]);
  assert(ok.ok);
  assert(ok.config.mask !== undefined && !('wireUrl' in ok.config.mask));
  assertEquals(ok.config.mask.mimeType, 'image/png');
  assertEquals(ok.config.mask.bytes.byteLength, 5);

  const expectedFileIdError = {
    message: 'Floway cannot resolve input_image_mask.file_id; remove file_id and provide image_url alone.',
    param: 'tools[0].input_image_mask.file_id',
    code: 'unsupported_image_source',
  };
  const fileId = prepareImageGenerationConfig([{ type: 'image_generation', input_image_mask: { file_id: 'file_123' } } as ResponsesTool]);
  assert(!fileId.ok);
  assertEquals(fileId.error, expectedFileIdError);

  const inlineBoth = prepareImageGenerationConfig([{
    type: 'image_generation',
    input_image_mask: { image_url: `data:image/png;base64,${PNG_B64}`, file_id: 'file_123' },
  } as ResponsesTool]);
  assert(!inlineBoth.ok);
  assertEquals(inlineBoth.error, expectedFileIdError);

  const remoteBoth = prepareImageGenerationConfig([{
    type: 'image_generation',
    input_image_mask: { file_id: 'file_123', image_url: 'https://example.com/mask.png' },
  } as ResponsesTool]);
  assert(remoteBoth.ok);
  assert(remoteBoth.config.mask !== undefined && 'wireUrl' in remoteBoth.config.mask);
  assertEquals(remoteBoth.config.mask.afterMaterializationError, expectedFileIdError);
});

// ── buildImageGenerationFunctionTool ──

test('buildImageGenerationFunctionTool exposes only an optional prompt and is non-strict', () => {
  const tool = buildImageGenerationFunctionTool({ type: 'image_generation' }, SHIM_TOOL_NAME);
  assertEquals(tool.type, 'function');
  assertEquals(tool.name, SHIM_TOOL_NAME);
  assertEquals(tool.strict, false);
  const params = tool.parameters as { properties: Record<string, unknown>; required: unknown[]; additionalProperties: unknown };
  assertEquals(Object.keys(params.properties), ['prompt']);
  assertEquals(params.required.length, 0);
  assertEquals(params.additionalProperties, false);
});

// ── inspectImageSources ──

test('inspectImageSources reads input_image blocks and image_generation_call results', () => {
  const input: ResponsesInputItem[] = [
    {
      type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'edit this' },
        { type: 'input_image', image_url: `data:image/png;base64,${PNG_B64}`, detail: 'auto' },
      ],
    },
    { type: 'image_generation_call', id: 'ig_prev', status: 'completed', result: PNG_B64 },
  ];
  const { sources, issue } = inspectImageSources(input);
  assertEquals(sources.length, 2);
  assertEquals(issue, undefined);
});

test('inspectImageSources preserves valid remote image urls for materialization', () => {
  const input: ResponsesInputItem[] = [
    {
      type: 'message', role: 'user', content: [
        { type: 'input_image', image_url: 'https://example.com/a.png', detail: 'auto' },
      ],
    },
  ];
  const { sources, issue } = inspectImageSources(input);
  assertEquals(sources.length, 1);
  assert('wireUrl' in sources[0]);
  assertEquals(sources[0].wireUrl, 'https://example.com/a.png');
  assertEquals(issue, undefined);
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

test('inspectImageSources mirrors the native error when input_image has no source field', () => {
  const inspection = inspectImageSources([imageInputContainers.message({
    type: 'input_image', detail: 'auto',
  })]);
  assertEquals(inspection.issue, {
    kind: 'native',
    error: {
      message: "Missing mutually exclusive parameters: 'input[0].content[0]'. Ensure you are providing exactly one of: 'file_id' or 'image_url'.",
      errorType: 'invalid_request_error',
      param: 'input[0].content[0]',
      code: 'missing_mutually_exclusive_parameters',
    },
  });
});

test.each(Object.entries(imageInputContainers))(
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

test('inspectImageSources reads tool-result images and preserves forward order', () => {
  const input: ResponsesInputItem[] = [
    { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_image', image_url: `data:image/png;base64,${PNG_B64}`, detail: 'auto' }] },
    { type: 'custom_tool_call_output', call_id: 'c2', output: [{ type: 'input_image', image_url: `data:image/jpeg;base64,${PNG_B64}`, detail: 'auto' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: `data:image/webp;base64,${PNG_B64}`, detail: 'auto' }] },
  ];
  const { sources } = inspectImageSources(input);
  assertEquals(sources.length, 3);
  const [first, second, third] = sources;
  assert(first !== undefined && !('wireUrl' in first));
  assert(second !== undefined && !('wireUrl' in second));
  assert(third !== undefined && !('wireUrl' in third));
  assertEquals(first.mimeType, 'image/png');
  assertEquals(second.mimeType, 'image/jpeg');
  assertEquals(third.mimeType, 'image/webp');
});

test('prepareEditSources transcodes formats accepted by native Responses but rejected by images edits', async () => {
  let observedTarget: unknown = undefined;
  let processorCalls = 0;
  initImageProcessor({
    compressToWebp: (_input, target) => {
      processorCalls += 1;
      observedTarget = target;
      return Promise.resolve(Uint8Array.of(1, 2, 3));
    },
  });
  const first = {
    bytes: Uint8Array.of(4, 5, 6).buffer,
    mimeType: 'image/gif',
  };
  const sameBytes = { bytes: Uint8Array.of(4, 5, 6).buffer, mimeType: 'image/gif' };
  const prepared = await prepareEditSources([first, first, sameBytes]);
  assertEquals(processorCalls, 1);
  assert(prepared[0] === prepared[1]);
  assert(prepared[0] === prepared[2]);
  assertEquals(prepared[0].mimeType, 'image/webp');
  assertEquals([...new Uint8Array(prepared[0].bytes)], [1, 2, 3]);
  assertEquals(observedTarget, null);
});

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

test('a request inspector reuses decoded bytes after generated results become replay images', () => {
  const inspect = createImageSourceInspector();
  const generated: ResponsesInputItem = {
    type: 'image_generation_call',
    id: 'ig_cached',
    status: 'completed',
    result: PNG_B64,
    output_format: 'jpeg',
  };
  const initial = inspect([generated]);
  const replay = inspect(transformInputItemsForImageGeneration([generated], SHIM_TOOL_NAME));
  assert(initial.sources[0] === replay.sources[0]);
});

test('auto generation pivots to edit when a generated image is fed back', () => {
  const config: ImageGenerationConfig = { model: DEFAULT_IMAGE_MODEL, action: 'auto' };
  const inspect = createImageSourceInspector();
  const initial = resolveImageOperation(config, inspect([]));
  assert(initial.ok);
  assertEquals(initial.action, 'generate');

  const replayInput = transformInputItemsForImageGeneration([
    { type: 'image_generation_call', id: 'ig_replay', status: 'completed', result: PNG_B64 },
  ], SHIM_TOOL_NAME);
  const replay = resolveImageOperation(config, inspect(replayInput));
  assert(replay.ok);
  assertEquals(replay.action, 'edit');
  assertEquals(replay.sources.length, 1);
});

// ── transformInputItemsForImageGeneration ──

test('transformInputItemsForImageGeneration rewrites a completed call into a function_call + output pair and feeds the image back', () => {
  const out = transformInputItemsForImageGeneration(
    [{ type: 'image_generation_call', id: 'ig_1', status: 'completed', result: PNG_B64, revised_prompt: 'a red dot', output_format: 'jpeg' }],
    'image_generation',
  );
  assertEquals(out.length, 3);
  assert(out[0].type === 'function_call');
  assertEquals(out[0].name, 'image_generation');
  assertEquals(out[0].call_id, 'cc_from_ig_1');
  assertStringIncludes(out[0].arguments, 'a red dot');
  assert(out[1].type === 'function_call_output');
  assertEquals(out[1].call_id, 'cc_from_ig_1');
  assert(typeof out[1].output === 'string');
  assertStringIncludes(out[1].output, '"ok":true');
  assert(out[2].type === 'message');
  assert(Array.isArray(out[2].content));
  const imageBlock = out[2].content.find(b => b.type === 'input_image');
  assert(imageBlock !== undefined);
  assertEquals((imageBlock as { image_url: string }).image_url, `data:image/jpeg;base64,${PNG_B64}`);
});

test('transformInputItemsForImageGeneration does not feed back an image for a failed call', () => {
  const out = transformInputItemsForImageGeneration(
    [{ type: 'image_generation_call', id: 'ig_f', status: 'failed', error: { message: 'x', code: 'server_error' } }],
    'image_generation',
  );
  assertEquals(out.length, 2);
  assertFalse(out.some(i => i.type === 'message'));
});

test('transformInputItemsForImageGeneration encodes a failed call as ok:false with error detail', () => {
  const out = transformInputItemsForImageGeneration(
    [{ type: 'image_generation_call', id: 'ig_2', status: 'failed', revised_prompt: 'x', error: { message: 'overloaded', code: 'EngineOverloaded' } }],
    'image_generation',
  );
  assert(out[1].type === 'function_call_output');
  assert(typeof out[1].output === 'string');
  const parsed = JSON.parse(out[1].output) as { ok: boolean; error: { code: string; message: string; retryable: boolean } };
  assertEquals(parsed.ok, false);
  assertEquals(parsed.error.code, 'EngineOverloaded');
  assertEquals(parsed.error.message, 'overloaded');
  assertEquals(parsed.error.retryable, true);
});

test('transformInputItemsForImageGeneration passes non-image items through untouched', () => {
  const message: ResponsesInputItem = { type: 'message', role: 'user', content: 'hi' };
  const out = transformInputItemsForImageGeneration([message], 'image_generation');
  assertEquals(out.length, 1);
  assertEquals(out[0], message);
});

// ── buildGenerationsBody ──

test('buildGenerationsBody always sends n:1 and maps config, omitting undefined', () => {
  const config: ImageGenerationConfig = { model: 'gpt-image-2', size: '1024x1024', quality: 'low', action: 'generate' };
  const body = buildGenerationsBody('a cat', config, false);
  assertEquals(body.prompt, 'a cat');
  assertEquals(body.n, 1);
  assertEquals(body.size, '1024x1024');
  assertEquals(body.quality, 'low');
  assertFalse('background' in body);
  assertFalse('output_format' in body);
  assertFalse('stream' in body);
  assertFalse('partial_images' in body);
});

test('buildGenerationsBody adds stream and partial_images when streaming', () => {
  const config: ImageGenerationConfig = { model: 'gpt-image-2', partial_images: 2, action: 'generate' };
  const body = buildGenerationsBody('a cat', config, true);
  assertEquals(body.stream, true);
  assertEquals(body.partial_images, 2);
});

// ── imageTerminal ──

test('imageTerminal on success echoes the backend-resolved fields and closes with a single completed event', () => {
  const outcome: ImageOutcome = { ok: true, b64: PNG_B64, echo: { size: '1024x1024', quality: 'high', output_format: 'png', background: 'opaque' } };
  const { item, endEvents } = imageTerminal('a red dot', 'generate', outcome);
  assertEquals((item as { status?: string }).status, 'completed');
  assertEquals((item as { result?: string }).result, PNG_B64);
  assertEquals((item as { revised_prompt?: string }).revised_prompt, 'a red dot');
  assertEquals((item as { action?: string }).action, 'generate');
  assertEquals((item as { quality?: string }).quality, 'high');
  assertEquals((item as { size?: string }).size, '1024x1024');
  assertEquals((item as { output_format?: string }).output_format, 'png');
  assertEquals((item as { background?: string }).background, 'opaque');
  assertEquals(endEvents.length, 1);
  assertEquals(endEvents[0].type, 'response.image_generation_call.completed');
});

test('imageTerminal on failure emits a failed item and no closing events', () => {
  const outcome: ImageOutcome = { ok: false, error: { type: 'image_generation_user_error', message: 'overloaded', code: 'EngineOverloaded', retryable: true } };
  const { item, endEvents } = imageTerminal('a red dot', 'generate', outcome);
  assertEquals((item as { status?: string }).status, 'failed');
  assertEquals((item as { error?: { code: string } }).error?.code, 'EngineOverloaded');
  assertEquals((item as { error?: { type?: string } }).error?.type, 'image_generation_user_error');
  assertFalse('result' in item);
  assertEquals(endEvents.length, 0);
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

test('parseImageStreamEvent returns null for non-JSON or unrelated events', () => {
  assertEquals(parseImageStreamEvent('[DONE]'), null);
  assertEquals(parseImageStreamEvent(JSON.stringify({ type: 'image_generation.queued' })), null);
});

test('prepareImageGenerationConfig rejects a present-but-invalid model', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', model: '' } as ResponsesTool]);
  assert(!result.ok);
  assertEquals(result.error.code, 'invalid_value');
  assertEquals(result.error.param, 'tools[0].model');
});

test('prepareImageGenerationConfig validates every hosted entry, not just the last', () => {
  const result = prepareImageGenerationConfig([
    { type: 'image_generation', n: 2 } as ResponsesTool,
    { type: 'image_generation', quality: 'low' } as ResponsesTool,
  ]);
  assert(!result.ok);
  assertEquals(result.error.code, 'unknown_parameter');
  assertEquals(result.error.param, 'tools[0].n');
});

test('prepareImageGenerationConfig uses Azure integer-range codes', () => {
  const below = prepareImageGenerationConfig([{ type: 'image_generation', partial_images: -1 } as ResponsesTool]);
  assert(!below.ok);
  assertEquals(below.error.code, 'integer_below_min_value');
  const above = prepareImageGenerationConfig([{ type: 'image_generation', output_compression: 200 } as ResponsesTool]);
  assert(!above.ok);
  assertEquals(above.error.code, 'integer_above_max_value');
});

test('prepareImageGenerationConfig preserves a remote mask for materialization', () => {
  const result = prepareImageGenerationConfig([{ type: 'image_generation', input_image_mask: { image_url: 'https://example.com/m.png' } } as ResponsesTool]);
  assert(result.ok);
  assert(result.config.mask !== undefined && 'wireUrl' in result.config.mask);
  assertEquals(result.config.mask.wireUrl, 'https://example.com/m.png');
  assertEquals(result.config.mask.invalidUrlParam, 'tools[0].input_image_mask.image_url');
});

test('transformInputItemsForImageGeneration preserves error type and retryability on replay', () => {
  const out = transformInputItemsForImageGeneration(
    [{ type: 'image_generation_call', id: 'ig_3', status: 'failed', error: { message: 'blocked', code: 'content_filter', type: 'image_generation_user_error' } }],
    'image_generation',
  );
  assert(out[1].type === 'function_call_output');
  assert(typeof out[1].output === 'string');
  const parsed = JSON.parse(out[1].output) as { error: { type: string; code: string; retryable: boolean } };
  assertEquals(parsed.error.type, 'image_generation_user_error');
  assertEquals(parsed.error.code, 'content_filter');
  assertEquals(parsed.error.retryable, false);
});

test('imageTerminal omits fields the backend did not echo', () => {
  const { item } = imageTerminal('p', 'generate', { ok: true, b64: PNG_B64, echo: { output_format: 'png' } });
  assertFalse('size' in item);
  assertFalse('quality' in item);
  assertFalse('background' in item);
  assertEquals((item as { output_format?: string }).output_format, 'png');
});

// ── parseRetryAfterMs ──

test('parseRetryAfterMs prefers retry-after-ms over Retry-After', () => {
  const h = new Headers({ 'retry-after-ms': '2500', 'retry-after': '7' });
  assertEquals(parseRetryAfterMs(h), 2500);
});

test('parseRetryAfterMs falls back to x-ms-retry-after-ms when retry-after-ms absent', () => {
  const h = new Headers({ 'x-ms-retry-after-ms': '1800', 'retry-after': '7' });
  assertEquals(parseRetryAfterMs(h), 1800);
});

test('parseRetryAfterMs reads Retry-After as integer seconds → milliseconds', () => {
  const h = new Headers({ 'retry-after': '5' });
  assertEquals(parseRetryAfterMs(h), 5000);
});

test('parseRetryAfterMs parses Retry-After fractional seconds', () => {
  const h = new Headers({ 'retry-after': '0.5' });
  assertEquals(parseRetryAfterMs(h), 500);
});

test('parseRetryAfterMs interprets Retry-After HTTP-date as delta from now', () => {
  // HTTP-date is 1-second resolution and Date.parse() strips ms, so allow a
  // ~1s skew between toUTCString() and the parser's Date.now().
  const future = new Date(Date.now() + 10_000).toUTCString();
  const h = new Headers({ 'retry-after': future });
  const result = parseRetryAfterMs(h);
  assert(result !== null);
  assert(result > 0 && result <= 11_000);
});

test('parseRetryAfterMs returns null for missing headers', () => {
  assertEquals(parseRetryAfterMs(new Headers()), null);
});

test('parseRetryAfterMs returns null for zero / negative values (gpt-image-1 "0.0s" hint)', () => {
  assertEquals(parseRetryAfterMs(new Headers({ 'retry-after-ms': '0' })), null);
  assertEquals(parseRetryAfterMs(new Headers({ 'retry-after': '0' })), null);
  assertEquals(parseRetryAfterMs(new Headers({ 'retry-after': '-5' })), null);
});

test('parseRetryAfterMs returns null for non-numeric, non-HTTP-date Retry-After', () => {
  assertEquals(parseRetryAfterMs(new Headers({ 'retry-after': 'soon' })), null);
});

test('parseRetryAfterMs skips an unparseable retry-after-ms and falls through to Retry-After', () => {
  const h = new Headers({ 'retry-after-ms': 'nope', 'retry-after': '3' });
  assertEquals(parseRetryAfterMs(h), 3000);
});

// ── synthesizeImageGenerationCallId ──

test('synthesizeImageGenerationCallId produces an ig_gw_-prefixed id', () => {
  const id = synthesizeImageGenerationCallId();
  assert(id.startsWith('ig_gw_'));
  assert(id.length > 'ig_gw_'.length);
});

// ── imageGenerationServerTool: unsupported input format (C) ──

test('imageGenerationServerTool accepts GIF edit input for local WebP transcoding', async () => {
  const result = await imageGenerationServerTool(
    makeCtx({ tools: [{ type: 'image_generation' }], input: [imageMessage('image/gif')] }),
    gatewayCtx(),
  );
  assert(result.type === 'active');
});

test('imageGenerationServerTool fetches repeated remote edit sources once', async () => {
  const urls: string[] = [];
  initExternalResourceFetcher(url => {
    urls.push(url.href);
    return Promise.resolve(validPngResponse());
  });
  const remote = { type: 'input_image', image_url: 'https://example.com/source.png', detail: 'auto' } as const;
  const input: ResponsesInputItem[] = [
    imageInputContainers.message(remote),
    imageInputContainers.function_output(remote),
  ];

  const result = await imageGenerationServerTool(
    makeCtx({ tools: [{ type: 'image_generation', action: 'edit' }], input }),
    gatewayCtx(),
  );

  assert(result.type === 'active');
  assertEquals(urls, ['https://example.com/source.png']);
  const transformed = result.transformItems?.(input, SHIM_TOOL_NAME);
  assert(transformed?.[0].type === 'message' && Array.isArray(transformed[0].content));
  const first = transformed[0].content[0];
  assert(first.type === 'input_image');
  assertEquals(first.image_url, 'https://example.com/source.png');
});

test('imageGenerationServerTool counts and fetches one URL once when shared by a source and mask', async () => {
  let requests = 0;
  initExternalResourceFetcher(() => {
    requests += 1;
    return Promise.resolve(paddedPngResponse(30 * 1024 * 1024));
  });
  const imageUrl = 'https://example.com/shared.png';

  const result = await imageGenerationServerTool(
    makeCtx({
      tools: [{ type: 'image_generation', action: 'edit', input_image_mask: { image_url: imageUrl } }],
      input: [imageInputContainers.message({ type: 'input_image', image_url: imageUrl, detail: 'auto' })],
    }),
    gatewayCtx(),
  );

  assert(result.type === 'active');
  assertEquals(requests, 1);
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

test('imageGenerationServerTool mirrors the native error for a fetched non-image', async () => {
  initExternalResourceFetcher(() => Promise.resolve(new Response('not an image', {
    headers: { 'content-type': 'text/plain' },
  })));
  const result = await imageGenerationServerTool(
    makeCtx({
      tools: [{ type: 'image_generation', action: 'edit' }],
      input: [imageInputContainers.message({ type: 'input_image', image_url: 'https://example.com/readme.txt', detail: 'auto' })],
    }),
    gatewayCtx(),
  );

  assert(result.type === 'invalid-request');
  assertEquals(result.message, "The image data you provided does not represent a valid image. Please check your input and try again with one of the supported image formats: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].");
  assertEquals(result.errorType, 'invalid_request_error');
  assertEquals(result.param, 'input');
  assertEquals(result.code, 'invalid_value');
});

test('imageGenerationServerTool follows redirects before materializing a remote source', async () => {
  const urls: string[] = [];
  initExternalResourceFetcher(url => {
    urls.push(url.href);
    return Promise.resolve(url.pathname === '/redirect'
      ? new Response(null, { status: 302, headers: { location: '/image.png' } })
      : validPngResponse());
  });

  const result = await imageGenerationServerTool(
    makeCtx({
      tools: [{ type: 'image_generation', action: 'edit' }],
      input: [imageInputContainers.message({ type: 'input_image', image_url: 'https://example.com/redirect', detail: 'auto' })],
    }),
    gatewayCtx(),
  );

  assert(result.type === 'active');
  assertEquals(urls, ['https://example.com/redirect', 'https://example.com/image.png']);
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

test('imageGenerationServerTool reports a malformed remote mask at its native path', async () => {
  const result = await imageGenerationServerTool(
    makeCtx({ tools: [{ type: 'image_generation', input_image_mask: { file_id: 'file_123', image_url: 'https://' } }] }),
    gatewayCtx(),
  );
  assert(result.type === 'invalid-request');
  assertEquals(result.message, "Invalid 'tools[0].input_image_mask.image_url'. Expected a valid URL, but got a value with an invalid format.");
  assertEquals(result.param, 'tools[0].input_image_mask.image_url');
  assertEquals(result.code, 'invalid_value');
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

test.each(['generate', 'auto', 'edit'] as const)('imageGenerationServerTool accepts a mask without a separate image for action %s', async action => {
  const result = await imageGenerationServerTool(
    makeCtx({
      tools: [{
        type: 'image_generation',
        action,
        input_image_mask: { image_url: `data:image/png;base64,${PNG_B64}` },
      }],
    }),
    gatewayCtx(),
  );
  assert(result.type === 'active');
});

test.each([
  { requested: 'generate' as const, resolved: 'generate' as const, sourceCount: 0 },
  { requested: 'auto' as const, resolved: 'edit' as const, sourceCount: 1 },
  { requested: 'edit' as const, resolved: 'edit' as const, sourceCount: 1 },
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

test('imageGenerationServerTool accepts an auto-action mask with an edit source', async () => {
  const result = await imageGenerationServerTool(
    makeCtx({
      tools: [{
        type: 'image_generation',
        action: 'auto',
        input_image_mask: { image_url: `data:image/png;base64,${PNG_B64}` },
      }],
      input: [imageMessage('image/png')],
    }),
    gatewayCtx(),
  );
  assert(result.type === 'active');
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

test('imageGenerationServerTool accepts webp input for editing', async () => {
  const result = await imageGenerationServerTool(
    makeCtx({ tools: [{ type: 'image_generation' }], input: [imageMessage('image/webp')] }),
    gatewayCtx(),
  );
  assert(result.type === 'active');
});

test('imageGenerationServerTool ignores input format when action is generate', async () => {
  // A gif is fine as pure vision context; action:"generate" never forwards it
  // to the edit backend, so the format is not validated.
  const result = await imageGenerationServerTool(
    makeCtx({ tools: [{ type: 'image_generation', action: 'generate' }], input: [imageMessage('image/gif')] }),
    gatewayCtx(),
  );
  assert(result.type === 'active');
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
      intercepted: { callId: 'call_live_invalid', name: SHIM_TOOL_NAME, arguments: { prompt: 'edit it' } },
      loopState: { iterationCount: 2, remainingToolCalls: undefined },
    }),
    Error,
    'image_generation live source invariant violated after request validation: remote image URL was not materialized',
  );
});

// ── imageGenerationServerTool: per-response dispatch budget (B) ──

test('image dispatch budget caps real backend calls per response, not ReAct turns', async () => {
  const result = await imageGenerationServerTool(makeCtx({ tools: [{ type: 'image_generation', action: 'generate' }] }), gatewayCtx());
  assert(result.type === 'active' && result.hosted !== undefined);
  const dispatch = result.hosted.dispatcher;
  const intercepted = { callId: 'c', name: SHIM_TOOL_NAME, argumentsJson: '{}', arguments: { prompt: 'x' } };
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
