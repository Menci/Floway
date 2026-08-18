import type { AnthropicMessagesInterceptor } from './types.ts';
import { telemetryModelIdentity } from '../../../shared/telemetry/attribution.ts';
import { generateAnthropicId, type AnthropicMessagesPayload, type AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { eventResult, providerModelOf, type ExecuteResult, type ModelCandidate } from '@floway-dev/provider';

// Claude Code answers "is this model usable?" by generating one token against
// it. `/model <id>` runs the CLI's `model_validation` side query — a
// non-streaming `POST /v1/messages?beta=true` with `max_tokens: 1` and a fixed
// throwaway prompt — and reports the model unusable if that call throws.
// Decompiled from the 2.1.226 binary:
//
//   await eie({model:r, max_tokens:1, maxRetries:0, querySource:"model_validation",
//     messages:[{role:"user",content:[{type:"text",text:"Hi",
//       cache_control:{type:"ephemeral"}}]}]}), lra.set(r,!0), {valid:!0}
//
// The verdict is "did not throw". The validation path dereferences
// `usage.input_tokens` / `usage.output_tokens` unguarded to populate the CLI's
// own telemetry event, reads `stop_reason` and the cache counters behind `??`,
// and looks at nothing else. The CLI runs several other one-token probes with
// their own fixed prompts, each from an independent call site rather than
// through `eie` — `quota` for the rate-limit preflight, `test` for credential
// verification, `.` for the Bedrock / Vertex / Mantle reachability checks.
//
// A one-token cap is not portable. OpenAI's OpenAI Responses API floors
// `max_output_tokens` at 16 and rejects anything lower with a hard 400, so
// every Anthropic Messages→OpenAI Responses candidate fails the probe and Claude Code
// concludes the model does not exist — the CLI surfaces the upstream envelope
// verbatim: `API error: 400 {"error":{"message":"Invalid 'max_output_tokens':
// integer below minimum value. Expected a value >= 16, but got 1 instead.",
// "code":"invalid_request_body"}}`.
//
// The gateway answers the probe itself instead. That is honest for what the
// probe actually asks: by the time this interceptor runs, model resolution has
// already picked a real candidate for the requested id, so an id no upstream
// serves still fails at the serve layer with a 404 and the CLI still reports
// it not found. What we suppress is only the pointless one-token generation
// behind it — no upstream call, and no tokens to bill.
const CLAUDE_CODE_USER_AGENT = /^claude-cli\/\d+\.\d+\.\d+/i;

// The probes we can answer truthfully, written exactly as 2.1.226 sends them:
// `Hi` is the `/model` validation probe, `test` the credential check, which
// reads nothing at all off the response.
//
// Two recorded prompts are deliberately absent. `quota` is the rate-limit
// preflight, and its caller consumes the `anthropic-ratelimit-unified-*`
// response headers rather than the body — a synthesized turn cannot carry
// them, so answering it here would replace a working quota reading, on every
// upstream that serves the probe today, with a silent blank. `.` is issued by
// the Bedrock / Vertex / Mantle SDK clients, which route through their own
// base URLs and never reach an `ANTHROPIC_BASE_URL` gateway.
//
// Matching is exact, and every literal is read off a binary rather than
// inferred: a probe shape we have not observed should reach the upstream
// rather than be answered from a guess. The cost of keying on the prompt at
// all is that these literals are a Claude Code build detail — a report against
// v2.1.220 records the validation prompt as `hello`
// (https://github.com/BerriAI/litellm/issues/35061), a spelling absent from
// 2.1.226 — so a release that renames one re-exposes the 400 until the new
// literal is read off that build and added here.
const PROBE_PROMPTS: ReadonlySet<string> = new Set(['Hi', 'test']);

// The whole conversation of a probe. `model_validation` sends its prompt as a
// single ephemeral text block and the credential check sends the bare-string
// form; both shapes are current. Anything longer is a real turn.
const soleUserPromptOf = (payload: AnthropicMessagesPayload): string | null => {
  if (payload.messages.length !== 1) return null;
  const message = payload.messages[0]!;
  if (message.role !== 'user') return null;
  const { content } = message;
  if (typeof content === 'string') return content;
  if (content.length !== 1) return null;
  const block = content[0]!;
  return block.type === 'text' ? block.text : null;
};

const isClaudeCodeProbe = (payload: AnthropicMessagesPayload, headers: Headers): boolean => {
  if (payload.max_tokens !== 1) return false;
  // Every real Claude Code turn ships the session's tools; the one-token
  // probes never do.
  if (payload.tools !== undefined) return false;
  const userAgent = headers.get('user-agent');
  if (userAgent === null || !CLAUDE_CODE_USER_AGENT.test(userAgent)) return false;
  const prompt = soleUserPromptOf(payload);
  return prompt !== null && PROBE_PROMPTS.has(prompt);
};

// A turn that stopped at the caller's one-token cap before emitting anything:
// no content blocks, `stop_reason: 'max_tokens'`, and a zero usage block. The
// usage block is load-bearing — the validation path dereferences
// `usage.input_tokens` / `usage.output_tokens` unconditionally, and a missing
// `usage` throws inside the CLI and reads as a failed probe.
const probeFrames = async function* (model: string): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEvent>> {
  yield eventFrame({
    type: 'message_start',
    message: {
      id: generateAnthropicId('msg'),
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  yield eventFrame({ type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 0 } });
  yield eventFrame({ type: 'message_stop' });
  yield doneFrame();
};

// No `performance` context on the result: `settle` reads it to decide whether
// the turn contributes a latency sample, and a turn that never dialed the
// upstream has no latency to report. The usage row still lands, at zero, so
// the request itself stays visible in the dashboard.
const probeResult = (candidate: ModelCandidate, model: string): ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEvent>> =>
  eventResult(probeFrames(model), telemetryModelIdentity(candidate, providerModelOf(candidate).id));

export const answerClaudeCodeProbe: AnthropicMessagesInterceptor = async (ctx, _gatewayCtx, run) =>
  isClaudeCodeProbe(ctx.payload, ctx.headers)
    ? probeResult(ctx.candidate, ctx.payload.model)
    : await run();
