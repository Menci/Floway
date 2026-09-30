import type { HostedToolOutputItem, HostedToolTerminal } from '../types.ts';
import type { OpenAIImagesStreamEvent } from '@floway-dev/protocols/openai-images';
import type { OpenAIResponsesOutputImageGenerationCall } from '@floway-dev/protocols/openai-responses';

export type ImageError = { type: string; code: string; message: string; retryable: boolean };

// Server-resolved tool config echoed by the backend on both the partial_image
// frames and the final result (`background:"auto"` becomes the concrete value
// the server picked, etc.). Read straight off the backend rather than inferred
// from the request, so what we surface matches what was actually rendered.
interface EchoFields {
  output_format?: 'png' | 'jpeg';
  quality?: 'low' | 'medium' | 'high';
  background?: 'transparent' | 'opaque';
  size?: string;
}

export type ImageOutcome =
  | { ok: true; b64: string; echo: EchoFields }
  | { ok: false; error: ImageError };

// Project the server-resolved echo fields out of a backend payload (a response
// JSON body or an SSE event). Each field is validated against the public enum
// so a surprising backend value is dropped rather than echoed verbatim.
export const extractEcho = (source: unknown): EchoFields => {
  if (source === null || typeof source !== 'object') return {};
  const s = source as Record<string, unknown>;
  const echo: EchoFields = {};
  if (s.output_format === 'png' || s.output_format === 'jpeg') echo.output_format = s.output_format;
  if (s.quality === 'low' || s.quality === 'medium' || s.quality === 'high') echo.quality = s.quality;
  if (s.background === 'transparent' || s.background === 'opaque') echo.background = s.background;
  if (typeof s.size === 'string') echo.size = s.size;
  return echo;
};

const RETRYABLE_IMAGE_ERROR_CODES = new Set([
  'EngineOverloaded', 'server_error', 'image_generation_server_error', 'image_generation_failed',
]);

export const isRetryableImageError = (code: string, type?: string): boolean =>
  RETRYABLE_IMAGE_ERROR_CODES.has(code) || (type !== undefined && RETRYABLE_IMAGE_ERROR_CODES.has(type));

export const errorFromBody = (body: string, status: number): { type?: string; code: string; message: string } => {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown; code?: unknown; type?: unknown } };
    const err = parsed.error;
    if (err !== undefined && err !== null) {
      return {
        ...(typeof err.type === 'string' ? { type: err.type } : {}),
        message: typeof err.message === 'string' ? err.message : `Image backend returned HTTP ${status}`,
        code: typeof err.code === 'string' ? err.code : `upstream_${status}`,
      };
    }
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }
  return { message: `Image backend returned HTTP ${status}`, code: `upstream_${status}` };
};

// Build the completed/failed `image_generation_call` output item plus its
// closing events. On success the final bytes ride `output_item.done.item.result`
// and a `response.image_generation_call.completed` closes the item; on failure
// neither `.completed` nor any `.partial_image` is emitted — only the failed
// `output_item.done`.
//
// `revised_prompt` is set to the orchestrator's prompt: the standalone images
// backend does no prompt rewriting and returns no `revised_prompt`, and the
// orchestrator's emitted prompt IS already its refined rewrite (it plays the
// role Azure's native flow gives the orchestrator), so it is the faithful
// source for this field.
export const imageTerminal = (
  prompt: string,
  action: 'generate' | 'edit',
  outcome: ImageOutcome,
): HostedToolTerminal => {
  if (!outcome.ok) {
    const item: HostedToolOutputItem & Omit<OpenAIResponsesOutputImageGenerationCall, 'id'> = {
      type: 'image_generation_call',
      status: 'failed',
      revised_prompt: prompt,
      error: { message: outcome.error.message, code: outcome.error.code, type: outcome.error.type },
    };
    return { item, endEvents: [] };
  }

  const item: HostedToolOutputItem & Omit<OpenAIResponsesOutputImageGenerationCall, 'id'> = {
    type: 'image_generation_call',
    status: 'completed',
    action,
    result: outcome.b64,
    revised_prompt: prompt,
    ...outcome.echo,
  };
  return { item, endEvents: [{ type: 'response.image_generation_call.completed' }] };
};

// Native image events become the hosted lifecycle without transport reframing.
// The generations and edits endpoints use distinct event prefixes
// (`image_generation.*` vs `image_edit.*`); only the suffix is matched here.
type ImageStreamSignal =
  | { kind: 'partial'; index: number; b64: string; echo: EchoFields }
  | { kind: 'completed'; b64: string | undefined; usage: unknown; echo: EchoFields }
  | { kind: 'error'; error: ImageError }
  | null;

export const projectImageStreamEvent = (evt: OpenAIImagesStreamEvent): ImageStreamSignal => {
  const type = typeof evt.type === 'string' ? evt.type : '';
  if (type.endsWith('.partial_image')) {
    return {
      kind: 'partial',
      index: typeof evt.partial_image_index === 'number' ? evt.partial_image_index : 0,
      b64: typeof evt.b64_json === 'string' ? evt.b64_json : '',
      echo: extractEcho(evt),
    };
  }
  if (type.endsWith('.completed')) {
    return { kind: 'completed', b64: typeof evt.b64_json === 'string' ? evt.b64_json : undefined, usage: evt.usage, echo: extractEcho(evt) };
  }
  if (type === 'error') {
    const err = evt.error as { message?: unknown; code?: unknown; type?: unknown } | undefined;
    const code = typeof err?.code === 'string' ? err.code : 'server_error';
    const errType = typeof err?.type === 'string' ? err.type : 'image_generation_error';
    return {
      kind: 'error',
      error: { type: errType, code, message: typeof err?.message === 'string' ? err.message : 'Image backend stream reported an error.', retryable: isRetryableImageError(code, errType) },
    };
  }
  return null;
};

export const serverError = (error: unknown): ImageError => ({
  type: 'image_generation_error', message: error instanceof Error ? error.message : String(error), code: 'server_error', retryable: true,
});
