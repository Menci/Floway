import type { ChatAttemptOutcome, ChatPipelineServices } from './types.ts';
import { inboundHeaderEntriesFromHeaders } from '../../pipeline/headers.ts';
import type { StageEnv } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { headersFromEntries } from '@floway-dev/provider';
import type { ChatTargetApi } from '@floway-dev/provider';
import type { TranslateTrip } from '@floway-dev/translate';

const captureTargetFrames = async function* <TEvent>(
  source: AsyncIterable<ProtocolFrame<TEvent>>,
  env: StageEnv<ChatPipelineServices>,
): AsyncGenerator<ProtocolFrame<TEvent>> {
  for await (const frame of source) {
    env.ctx.dump?.upstreamFrame(frame);
    yield frame;
  }
};

export const applyTranslationTripToOutcome = <TP, SE, TE>(
  env: StageEnv<ChatPipelineServices>,
  trip: TranslateTrip<TP, SE, TE>,
  targetApi: ChatTargetApi,
  inner: ChatAttemptOutcome<TE>,
): ChatAttemptOutcome<SE> => {
  env.attribution.recordTargetApi(targetApi);
  if (inner.type === 'events') {
    const events = env.wrapStream<ProtocolFrame<TE>, ProtocolFrame<SE>>(inner.events, {
      label: 'translated.protocol.events',
      transform(source) {
        const captured = env.ctx.dump === null ? source : captureTargetFrames(source, env);
        return trip.events(captured);
      },
    });
    return { ...inner, events };
  }

  if (inner.type === 'api-error' && inner.source === 'upstream') {
    env.ctx.dump?.upstreamApiError({
      status: inner.http.status,
      headers: headersFromEntries(inner.http.headers),
      body: inner.body,
    });
    if (inner.body === null) return inner;
    const rewritten = trip.error(inner.http.status, headersFromEntries(inner.http.headers), inner.body);
    if (rewritten === undefined) return inner;
    return {
      ...inner,
      http: {
        status: rewritten.status,
        headers: inboundHeaderEntriesFromHeaders(rewritten.headers),
      },
      body: new TextEncoder().encode(JSON.stringify(rewritten.body)),
    };
  }

  return inner;
};
