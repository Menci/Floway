import type { MessagesInterceptor } from './types.ts';
import { telemetryModelIdentity } from '../../../shared/telemetry/attribution.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { eventResult, providerModelOf, type ExecuteResult, type ModelCandidate } from '@floway-dev/provider';

// Claude Code answers "is this model usable?" by generating one token against
// it. `/model <id>` runs the CLI's `model_validation` side query — a
// non-streaming `POST /v1/messages?beta=true` with `max_tokens: 1` and a
// throwaway one-word prompt — and reports the model unusable if that call
// throws. Decompiled from the 2.1.226 binary:
//
//   await eie({model:r, max_tokens:1, maxRetries:0, querySource:"model_validation",
//     messages:[{role:"user",content:[{type:"text",text:"Hi",
//       cache_control:{type:"ephemeral"}}]}]}), lra.set(r,!0), {valid:!0}
//
// The same helper serves the CLI's other one-token probes, each with its own
// fixed prompt: `quota` for the rate-limit preflight, `test` for credential
// verification, `.` for the Bedrock/Vertex reachability checks. None of them
// wants generated text — the caller reads `usage.input_tokens` /
// `usage.output_tokens` for its own telemetry and treats "did not throw" as
// the verdict.
//
// A one-token cap is not portable. OpenAI's Responses API floors
// `max_output_tokens` at 16 and rejects anything lower with a hard 400, so
// every Messages→Responses candidate fails the probe and Claude Code
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
//
// The predicate is deliberately narrower than the one gateway with production
// experience here — CLIProxyAPI short-circuits on `max_tokens === 1` alone
// (https://github.com/router-for-me/CLIProxyAPI/pull/3571), having reverted a
// tighter predicate that missed probe shapes. We keep the client and prompt
// conditions because a mismatch here fails safe in the direction of the
// current behavior: an unrecognized probe reaches the upstream exactly as it
// does today. The cost is that the literals below are a Claude Code build
// detail — a report against v2.1.220 records `hello` where 2.1.226 sends `Hi`
// (https://github.com/BerriAI/litellm/issues/35061) — so a release that renames
// one re-exposes the 400 until the new literal is added here.
const CLAUDE_CODE_USER_AGENT = /^claude-cli\/\d+\.\d+\.\d+/i;

const PROBE_PROMPTS: ReadonlySet<string> = new Set(['hi', 'hello', 'quota', 'test', '.']);

// The whole conversation of a probe: one user turn carrying one text block (or
// the bare-string form older clients send). Anything longer is a real turn.
const soleUserPromptOf = (payload: MessagesPayload): string | null => {
  if (payload.messages.length !== 1) return null;
  const message = payload.messages[0]!;
  if (message.role !== 'user') return null;
  const { content } = message;
  if (typeof content === 'string') return content;
  if (content.length !== 1) return null;
  const block = content[0]!;
  return block.type === 'text' ? block.text : null;
};

export const isClaudeCodeProbe = (payload: MessagesPayload, headers: Headers): boolean => {
  if (payload.max_tokens !== 1) return false;
  // Every real Claude Code turn ships the session's tools; a side query never
  // does.
  if (payload.tools !== undefined) return false;
  const userAgent = headers.get('user-agent');
  if (userAgent === null || !CLAUDE_CODE_USER_AGENT.test(userAgent)) return false;
  const prompt = soleUserPromptOf(payload);
  return prompt !== null && PROBE_PROMPTS.has(prompt.trim().toLowerCase());
};

// Anthropic-shaped opaque message id (`msg_` + 24 base62 chars) for a body no
// upstream produced, mirroring the synthetic `request_id` the Messages error
// envelopes mint. 24 chars off crypto.randomUUID is ~96 bits of entropy.
const mintMessageId = (): string => `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

// A turn that stopped at the caller's one-token cap before emitting anything:
// no content blocks, `stop_reason: 'max_tokens'`, and a zero usage block. The
// usage block is load-bearing — Claude Code dereferences
// `usage.input_tokens` / `usage.output_tokens` unconditionally, and a missing
// `usage` throws inside the CLI and reads as a failed probe.
const probeFrames = async function* (model: string): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
  yield eventFrame({
    type: 'message_start',
    message: {
      id: mintMessageId(),
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
const probeResult = (candidate: ModelCandidate, model: string): ExecuteResult<ProtocolFrame<MessagesStreamEvent>> =>
  eventResult(probeFrames(model), telemetryModelIdentity(candidate, providerModelOf(candidate).id));

export const answerClaudeCodeProbe: MessagesInterceptor = async (ctx, _gatewayCtx, run) =>
  isClaudeCodeProbe(ctx.payload, ctx.headers)
    ? probeResult(ctx.candidate, ctx.payload.model)
    : await run();
