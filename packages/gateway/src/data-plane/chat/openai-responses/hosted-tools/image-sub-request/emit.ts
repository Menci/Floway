import type { Fields } from './facts.ts';
import { errorFromBody, extractEcho, imageTerminal, isRetryableImageError, projectImageStreamEvent, serverError, type ImageOutcome } from './result.ts';
import type { RunDump } from '../../../../../dump/run-sink.ts';
import { isFailure } from '../../../../pipeline/facts.ts';
import type { GatewayServices } from '../../../../pipeline/services.ts';
import type { HostedToolLifecycleEvent, HostedToolTerminal } from '../types.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { eventFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIImagesResponse } from '@floway-dev/protocols/openai-images';

export const emitHostedImageGeneration = defineStage<
  Fields<'request.imageGeneration.canonical'>,
  Fields<'request.imageGeneration.canonical'>,
  Fields<'response.openaiImages.canonical' | 'response.openaiImages.streamedUsage' | 'response.http.status'>,
  Fields<'response.imageGeneration.lifecycle' | 'response.openaiImages.streamedUsage' | 'response.http.status'>,
  GatewayServices
>({
  name: 'emitHostedImageGeneration',
  through: {
    request: { needs: ['request.imageGeneration.canonical'], consumes: [], provides: [] },
    response: {
      needs: ['response.openaiImages.canonical', 'response.openaiImages.streamedUsage', 'response.http.status'],
      consumes: ['response.openaiImages.canonical'], provides: ['response.imageGeneration.lifecycle'],
    },
  },
  execute: async (facts, next, use) => {
    const back = await next(facts);
    const { 'response.openaiImages.canonical': answer, ...rest } = back;
    const request = facts['request.imageGeneration.canonical'];
    const lifecycle = (async function* (): AsyncGenerator<HostedToolLifecycleEvent, HostedToolTerminal> {
      let outcome: ImageOutcome;
      if (isFailure(answer)) {
        const error = answer.body === undefined
          ? { type: 'image_generation_error', code: answer.status === 404 ? 'model_not_found' : answer.status === 400 ? 'model_not_supported' : 'server_error', message: answer.message }
          : errorFromBody(JSON.stringify(answer.body), answer.status);
        outcome = { ok: false, error: { ...error, type: error.type ?? 'image_generation_error', retryable: isRetryableImageError(error.code, error.type) } };
      } else if (Symbol.asyncIterator in answer) {
        try {
          for await (const event of answer) {
            const signal = projectImageStreamEvent(event);
            if (signal === null) continue;
            if (signal.kind === 'partial') {
              yield { type: 'response.image_generation_call.partial_image', partial_image_index: signal.index, partial_image_b64: signal.b64, ...signal.echo };
            } else if (signal.kind === 'completed') {
              return imageTerminal(request.prompt, request.action, signal.b64 === undefined
                ? { ok: false, error: serverError(new Error('Image backend stream ended without a completed image.')) }
                : { ok: true, b64: signal.b64, echo: signal.echo });
            } else {
              return imageTerminal(request.prompt, request.action, { ok: false, error: signal.error });
            }
          }
          outcome = { ok: false, error: serverError(new Error('Image backend stream ended without a completed image.')) };
        } catch (error) {
          use.gateway.dump?.failed(error);
          outcome = { ok: false, error: serverError(error) };
        }
      } else {
        outcome = imageOutcome(answer);
      }
      return imageTerminal(request.prompt, request.action, outcome);
    })();
    return { ...rest, 'response.imageGeneration.lifecycle': move(recordLifecycle(lifecycle, use.gateway.dump)) };
  },
});

const imageOutcome = (answer: CanonicalOpenAIImagesResponse): ImageOutcome => {
  const b64 = answer.images[0]?.base64;
  return b64 === undefined
    ? { ok: false, error: serverError(new Error('Image backend response did not contain image bytes.')) }
    : { ok: true, b64, echo: extractEcho(answer.raw) };
};

const recordLifecycle = (source: AsyncGenerator<HostedToolLifecycleEvent, HostedToolTerminal>, dump: RunDump | null): AsyncGenerator<HostedToolLifecycleEvent, HostedToolTerminal> => {
  if (dump === null) return source;
  const recording = dump.openStream();
  const generator = (async function* () {
    let completed = false;
    try {
      for (;;) {
        const step = await source.next();
        recording.frame(eventFrame(step.value));
        if (step.done) {
          completed = true;
          recording.end();
          return step.value;
        }
        yield step.value;
      }
    } finally {
      if (!completed) await source.return(undefined as never);
    }
  })();
  return Object.assign(generator, recording.fact);
};
