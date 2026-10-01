import type { Fields } from './facts.ts';
import type { ChatServices } from '../services.ts';
import { isClaudeCodeProbe, probeFrames } from './claude-code-probe.ts';
import { telemetryModelIdentity } from '../../shared/telemetry/attribution.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { providerModelOf } from '@floway-dev/provider';

/**
 * Answers Claude Code's one-token probe itself, rather than spending an upstream turn on it.
 *
 * The CLI asks "is this model usable?" by generating one token against it and reporting the
 * model unusable if the call throws. A one-token cap is not portable — OpenAI's Responses API
 * floors `max_output_tokens` at 16 and rejects anything lower with a hard 400 — so every
 * Anthropic-Messages-via-OpenAI-Responses candidate fails a probe that is asking nothing this gateway cannot
 * answer. Resolution has already picked a real candidate by the time this runs, so an id no
 * upstream serves still fails above with a 404; what is suppressed is only the generation.
 *
 * It answers rather than descending, which is why it carries the `return` trait — and why it
 * has to live here rather than beside the shared rules: what it answers with is this
 * family's own response keys.
 */
export const answerClaudeCodeProbe = defineStage<
  Fields<'request.chat.anthropicMessages' | 'route.attempt' | 'ingress.http.headers'>,
  Fields<'request.chat.anthropicMessages' | 'route.attempt' | 'ingress.http.headers'>,
  Fields<'response.chat.anthropicMessages' | 'response.chat.anthropicMessages.streamedUsage'
  | 'response.usage.billable' | 'response.http.headers' | 'response.http.body' | 'response.http.status'>,
  Fields<'response.chat.anthropicMessages' | 'response.chat.anthropicMessages.streamedUsage'
  | 'response.usage.billable' | 'response.http.headers' | 'response.http.body' | 'response.http.status'>,
  Fields<'response.chat.anthropicMessages' | 'response.chat.anthropicMessages.streamedUsage'
  | 'response.usage.billable' | 'response.http.headers' | 'response.http.body' | 'response.http.status'>,
  ChatServices
>({
  name: 'answerClaudeCodeProbe',
  through: {
    request: {
      needs: ['request.chat.anthropicMessages', 'route.attempt', 'ingress.http.headers'],
      consumes: [],
      provides: [],
    },
    response: {
      needs: ['response.chat.anthropicMessages', 'response.http.headers'],
      consumes: [],
      provides: [],
    },
  },
  return: {
    provides: [
      'response.chat.anthropicMessages',
      'response.chat.anthropicMessages.streamedUsage',
      'response.usage.billable',
      'response.http.headers', 'response.http.body', 'response.http.status',
    ],
  },
  execute: async (facts, next, use) => {
    const headers = new Headers(facts['ingress.http.headers'].map(([name, value]): [string, string] => [name, value]));
    if (!isClaudeCodeProbe(facts['request.chat.anthropicMessages'], headers)) return await next(facts);

    const candidate = use.resolveAttempt(facts['route.attempt']);
    // The probe is answered *for* this candidate, so it is the one a follow-up turn carrying
    // our own state must come back to — the same statement a dialled attempt makes.
    use.selectAffinity(candidate);
    use.gateway.dump?.success(telemetryModelIdentity(candidate, providerModelOf(candidate).id), null);
    await use.log.debug('answering a Claude Code probe without dialling', { upstream: facts['route.attempt'].upstreamId });
    return move({
      ...facts,
      'response.chat.anthropicMessages': {
        kind: 'stream' as const,
        frames: probeFrames(facts['request.chat.anthropicMessages'].model),
      },
      'response.chat.anthropicMessages.streamedUsage': null,
      'response.usage.billable': [],
      'response.http.headers': [],
      'response.http.body': null, 'response.http.status': 200,
    });
  },
});
