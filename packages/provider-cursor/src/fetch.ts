/**
 * Cursor Chat Completions data-plane call.
 *
 * Self-constructs a ProviderStreamResult (async generator of
 * ProtocolFrame<ChatCompletionsStreamEvent>) — bypasses streamingProviderCall,
 * which hard-requires a Response+text/event-stream, because Cursor's stream is
 * a synthesized dual-channel (RunSSE read + BidiAppend write) rather than a
 * single SSE body. The gateway's respond.ts re-encodes these frames downstream.
 */

import { ensureCursorAccessToken, mintCursorAccessToken } from './access-token-cache.ts';
import { createAgentTranslator, isComposerModel } from './agent-translate.ts';
import { AgentTransport } from './agent-transport.ts';
import { CursorSessionTerminatedError } from './auth/oauth.ts';
import { generateCursorChecksum } from './checksum.ts';
import { CURSOR_BACKEND_BASE, CURSOR_CLIENT_VERSION } from './constants.ts';
import { contextCacheKey, shouldPersistContext, withObservedContext } from './context-window.ts';
import { parseCursorImages } from './cursor-images.ts';
import { cursorWireModelId } from './models.ts';
import { AgentMode, type AgentStreamChunk, type RequestContextEnv, type OpenAIToolDefinition } from './proto/index.ts';
import { deriveSessionKey, mintSessionKey, decodeToolCallId } from './session-id.ts';
import type { CursorAccountCredential } from './state.ts';
import { assertCursorUpstreamState } from './state.ts';
import { getDurableHttpSession, type DurableHttpSessionHandle } from '@floway-dev/platform';
import type { ChatCompletionsStreamEvent, ChatCompletionsPayload, ChatCompletionsMessage, ChatCompletionsTool } from '@floway-dev/protocols/chat-completions';
import { eventFrame, doneFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { getProviderRepo, type ProviderStreamResult, type UpstreamCallOptions, type ProviderModel } from '@floway-dev/provider';

export interface CursorCallEffects {
  persistRefreshTokenRotation(newRefreshToken: string): Promise<void>;
  persistTerminalState(state: 'session_terminated' | 'refresh_failed', message: string): Promise<void>;
}

interface CursorChatCallBase {
  upstreamId: string;
  account: CursorAccountCredential;
  model: ProviderModel;
  headers: Headers;
  signal?: AbortSignal;
  effects: CursorCallEffects;
  call: UpstreamCallOptions;
  /** Ghost-mode toggle, resolved by provider.ts from config (default on). */
  privacyMode: boolean;
}

export interface CallCursorChatCompletionsOptions extends CursorChatCallBase {
  body: Omit<ChatCompletionsPayload, 'model'>;
  // Operator's Max Mode toggle — encoded into ModelDetails.max_mode on the wire.
  maxMode?: boolean;
  // Resolved wire model id (variant slug picked from the request's reasoning
  // effort). Falls back to the model's default wire id.
  wireModelId?: string;
}

// Gateway environment reported to Cursor's request_context exec. The gateway
// has no real workspace (it rejects built-in tool exec), so these are stable
// placeholders. timezone is the only operator-relevant value.
const gatewayEnv: RequestContextEnv = {
  workspacePath: '/workspace',
  osVersion: 'darwin 24.0.0',
  shell: '/bin/zsh',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
};

const mintAccessToken = (opts: CursorChatCallBase, refreshToken: string) =>
  mintCursorAccessToken(refreshToken, opts.call.fetcher, opts.effects.persistRefreshTokenRotation);

// Pre-fetch gates + access-token mint + checksum precompute. The checksum is
// stable within a 30-minute window for a given token, so one precompute per
// turn is correct.
const prepareCursorCall = async (
  opts: CursorChatCallBase,
): Promise<{ ok: true; accessToken: string; checksum: string } | { ok: false; response: Response }> => {
  const wrapSynthetic = (response: Response) => opts.call.recordUpstreamLatency(Promise.resolve(response));

  if (opts.account.state !== 'active') {
    return { ok: false, response: await wrapSynthetic(synthetic503(`Cursor upstream is ${opts.account.state}`)) };
  }

  try {
    const entry = await ensureCursorAccessToken(opts.upstreamId, opts.account.userId, refresh => mintAccessToken(opts, refresh));
    const checksum = await generateCursorChecksum(entry.token);
    return { ok: true, accessToken: entry.token, checksum };
  } catch (err) {
    if (err instanceof CursorSessionTerminatedError) {
      await opts.effects.persistTerminalState('refresh_failed', err.upstreamMessage);
      return { ok: false, response: await wrapSynthetic(synthetic503(`Cursor refresh failed: ${err.upstreamMessage}`)) };
    }
    throw err;
  }
};

// Cursor agent is stateless from the gateway's view: each fresh RunSSE carries
// an empty conversation state, so the full transcript is inlined into the
// single user message. System → prefix, history → role-tagged turns.
//
// This path serves (a) genuine new conversations and (b) the cold-resume
// fallback when a live session was lost (cross-instance / evicted / CF cold
// start). Only live-resume (performResume) carries a tool result over the
// BidiAppend ExecMcpResult write channel; here on cold-open cursor has zero
// server-side memory, so past tool rounds are reconstructed into the transcript
// too — otherwise the model loses what it already called and re-runs tools. They
// are framed explicitly (which tool, its arguments, its result) so the model
// reads them as history: the degradation the earlier version avoided came from
// folding an *unaddressed* JSON blob, not from tool history per se. Tools stay
// advertised so cursor can still continue the agent loop natively.
export const flattenMessages = (messages: ChatCompletionsMessage[]): string => {
  // A tool message carries only tool_call_id + content; recover the tool name
  // from the assistant tool_calls so its result can be labelled with what it
  // answers.
  const toolNameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) toolNameById.set(tc.id, tc.function.name);
    }
  }

  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const mapped = m.tool_call_id ? toolNameById.get(m.tool_call_id) : undefined;
      const name = mapped ?? m.tool_call_id ?? 'tool';
      parts.push(`[Tool result: ${name}]\n${messageText(m)}`);
      continue;
    }

    if (m.role === 'assistant') {
      // Text (if any) then one line per tool call it made — an assistant turn
      // that only carried tool_calls still contributes its calls, not nothing.
      const lines: string[] = [];
      const text = messageText(m);
      if (text) lines.push(text);
      for (const tc of m.tool_calls ?? []) {
        lines.push(`→ called ${tc.function.name}(${tc.function.arguments})`);
      }
      if (lines.length === 0) continue;
      parts.push(`[Assistant]\n${lines.join('\n')}`);
      continue;
    }

    const text = messageText(m);
    if (!text) continue;
    const tag = m.role === 'system' || m.role === 'developer' ? 'System' : m.role === 'user' ? 'User' : m.role;
    parts.push(`[${tag}]\n${text}`);
  }

  return parts.join('\n\n');
};

// Plain-text extraction: string content verbatim, array content's text parts
// joined, everything else empty (assistant tool_calls are rendered separately).
const messageText = (m: ChatCompletionsMessage): string => {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
  }
  return '';
};

const toAgentTools = (tools: ChatCompletionsTool[] | null | undefined): OpenAIToolDefinition[] | undefined => {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      ...(t.function.parameters ? { parameters: t.function.parameters } : {}),
    },
  }));
};

export const syntheticErrorResponse = (status: number, type: string, message: string): Response =>
  new Response(JSON.stringify({ error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const synthetic503 = (message: string): Response =>
  syntheticErrorResponse(503, 'cursor_upstream_unavailable', message);

export const callCursorChatCompletions = async (
  opts: CallCursorChatCompletionsOptions,
): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => {
  const ready = await prepareCursorCall(opts);
  if (!ready.ok) return { ok: false, modelKey: opts.model.id, response: ready.response };

  // Session correlation: a tool-result follow-up carries the session id in the
  // echoed tool_call_id (see session-id.ts).
  const { sessionKey: derived, isFollowUp } = deriveSessionKey(
    opts.upstreamId, opts.call.apiKeyId, opts.headers, opts.body.messages,
  );

  // Follow-up: resume the live RunSSE stream (held by the DurableHttpSession),
  // seeded by the {requestId, seqno} persisted in D1. A miss / busy claim /
  // lost socket returns null → fall through to a fresh open (cold-resume:
  // cursor re-runs the agent loop with the full transcript).
  if (isFollowUp && derived) {
    const resumed = await performResume(opts, ready.accessToken, ready.checksum, derived);
    if (resumed) return resumed;
  }

  // Open always mints a fresh session key so it never collides with a still-live
  // session for the derived key (e.g. a racing concurrent follow-up).
  return await performOpen(opts, ready.accessToken, ready.checksum);
};

// Claim-lock TTL for the D1 single-flight: long enough to cover a turn's
// upstream round-trips, short enough that a crashed turn frees the session.
const CLAIM_TTL_MS = 60_000;

const makeTransport = (
  opts: CallCursorChatCompletionsOptions,
  getAuthToken: () => string,
  checksum: string,
): AgentTransport =>
  new AgentTransport({
    getAuthToken,
    baseUrl: CURSOR_BACKEND_BASE,
    env: gatewayEnv,
    clientVersion: CURSOR_CLIENT_VERSION,
    privacyMode: opts.privacyMode,
    getChecksum: () => checksum,
    // The BidiAppend write channel goes through the proxy-aware Fetcher (which
    // records upstream latency); the RunSSE read is owned by the
    // DurableHttpSession, not fetched here.
    fetch: ((url: string, init: RequestInit) =>
      opts.call.fetcher(url, init, opts.call.recordUpstreamLatency)) as unknown as typeof fetch,
  });

// Shared turn driver: pump the transport gen → translator → SSE frames, and
// dispose of the DurableHttpSession + D1 row at the right boundary:
//   - mcp exec      → tool_calls + pause: persist {requestId, seqno, leftover}
//                     to D1, release the handle (keep the socket), stop pulling.
//   - request_context / built-in → answer/reject on the write channel, continue.
//   - done          → discard the handle, delete the D1 row.
//   - error         → discard the handle, delete the D1 row, rethrow (502).
//
// Manual gen pulls (never for-await): for-await calls gen.return() on break,
// which would tear the read loop down mid-pause.
const buildEvents = (
  opts: CallCursorChatCompletionsOptions,
  transport: AgentTransport,
  gen: AsyncGenerator<AgentStreamChunk>,
  translator: ReturnType<typeof createAgentTranslator>,
  sessionKey: string,
  requestId: string,
  handle: DurableHttpSessionHandle,
  first: IteratorResult<AgentStreamChunk>,
): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> => {
  const repo = getProviderRepo().cursorSessions;
  return (async function* (): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {
    let paused = false;
    try {
      let iterResult = first;
      while (true) {
        if (iterResult.done) break;
        const chunk = iterResult.value;
        if (chunk.type === 'error') throw new Error(chunk.error ?? 'Cursor agent stream error');
        if (chunk.type === 'done') break;

        if (chunk.type === 'exec_request' && chunk.execRequest) {
          const exec = chunk.execRequest;
          if (exec.type === 'mcp') {
            for (const ev of translator.translate(chunk)) yield eventFrame(ev);
            // Pause point: persist the scalars a (possibly cross-instance)
            // resume needs. The exec id+execId travel in the tool_call_id, so
            // only requestId/seqno/leftover go to D1.
            await repo.put({
              sessionKey,
              requestId,
              appendSeqno: Number(transport.seqno),
              leftover: transport.leftover,
            });
            paused = true;
            break;
          }
          if (exec.type === 'request_context') {
            await transport.sendRequestContextResult(exec.id, exec.execId);
            iterResult = await gen.next();
            continue;
          }
          await transport.sendRejectedTool(exec, 'Floway gateway cannot execute built-in tools');
          iterResult = await gen.next();
          continue;
        }

        for (const ev of translator.translate(chunk)) yield eventFrame(ev);
        iterResult = await gen.next();
      }
    } catch (err) {
      await gen.return(undefined).catch(() => {});
      await handle.discard('stream error').catch(() => {});
      await repo.delete(sessionKey).catch(() => {});
      throw err;
    }

    // gen.return() releases the read lock; leftover was already captured before
    // the pause yield, so this is safe.
    await gen.return(undefined).catch(() => {});
    if (paused) {
      await handle.release().catch(() => {}); // keep the socket; D1 row persisted
    } else {
      await handle.discard('turn ended').catch(() => {});
      await repo.delete(sessionKey).catch(() => {});
    }

    for (const ev of translator.finalize()) yield eventFrame(ev);
    await persistObservedContext(opts, translator.observedMaxTokens());
    yield doneFrame();
  })();
};

// Best-effort persist of the run's observed context window into the upstream
// state, so the next catalog build prefers it over the tooltip heuristic. A
// per-isolate throttle keeps this off the hot path (at most once per TTL per
// model+mode); the write is optimistic-concurrency and any miss/error is
// swallowed — a lost race just re-attempts on a later request.
const persistObservedContext = async (opts: CallCursorChatCompletionsOptions, maxTokens: number | null): Promise<void> => {
  if (maxTokens === null) return;
  const maxMode = opts.maxMode ?? false;
  const now = Date.now();
  if (!shouldPersistContext(opts.upstreamId, opts.model.id, maxMode, now)) return;
  try {
    const fresh = await getProviderRepo().upstreams.getById(opts.upstreamId);
    if (fresh?.kind !== 'cursor') return;
    assertCursorUpstreamState(fresh.state);
    if (fresh.state.modelContext?.[contextCacheKey(opts.model.id, maxMode)]?.maxTokens === maxTokens) return;
    const next = withObservedContext(fresh.state, opts.model.id, maxMode, maxTokens, now);
    await getProviderRepo().upstreams.saveState(opts.upstreamId, next, { expectedState: fresh.state });
  } catch {
    // best-effort: concurrency miss / transient error re-attempts next request
  }
};

// A cursor turn opens with pre-output control frames — conversation
// checkpoints and keep-alive heartbeats cursor emits while the model is still
// queued/thinking — that arrive before the first real token. Classify the
// frame the model's first *output* rides on: real text/thinking content, any
// tool call (incl. the exec_request pause), a kv-blob content frame, or a
// terminal done/error.
const isFirstTokenFrame = (chunk: AgentStreamChunk): boolean => {
  switch (chunk.type) {
  // Pure control / keep-alive frames: the model has not produced output yet.
  case 'checkpoint':
  case 'heartbeat':
  case 'interaction_query':
  case 'exec_server_abort':
  case 'token':
    return false;
  // Empty text/thinking deltas carry no token — keep waiting for real content.
  case 'text':
  case 'thinking':
    return Boolean(chunk.content);
  default:
    return true;
  }
};

// Pull the transport generator to the model's first output frame (or a terminal
// result), discarding the pre-output control frames. Skipping is output-neutral:
// those frames translate to zero downstream events, and the returned result is
// handed to buildEvents unchanged, so exec-pause / seqno persistence / all
// translation stay there. Wrapping this call in recordUpstreamLatency makes
// `upstream_success` measure TTFT (request submitted → first token) instead of
// the BidiAppend write round-trip the earlier wraps saw.
export const pullToFirstMeaningful = async (
  gen: AsyncGenerator<AgentStreamChunk>,
): Promise<IteratorResult<AgentStreamChunk>> => {
  for (;;) {
    const result = await gen.next();
    if (result.done || isFirstTokenFrame(result.value)) return result;
  }
};

// Open a fresh turn: mint a session key, acquire the RunSSE read stream from
// the DurableHttpSession, send the RunRequest on BidiAppend, then drive.
const performOpen = async (
  opts: CallCursorChatCompletionsOptions,
  accessToken: string,
  checksum: string,
): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => {
  const sessionKey = mintSessionKey(opts.upstreamId, opts.call.apiKeyId);
  const message = flattenMessages(opts.body.messages);
  // Inline images ride the current (last) user turn only — Cursor attaches them
  // to that UserMessage's SelectedContext, and historical turns carry text only.
  let lastUser: ChatCompletionsMessage | undefined;
  for (let i = opts.body.messages.length - 1; i >= 0; i--) {
    if (opts.body.messages[i]!.role === 'user') { lastUser = opts.body.messages[i]; break; }
  }
  const images = lastUser ? parseCursorImages(lastUser) : [];
  // Always advertise the tools: a cold-resume (tool-result follow-up that lost
  // its session) lets cursor re-run the agent loop natively rather than degrade
  // to a prompt-folded result.
  const tools = toAgentTools(opts.body.tools);
  // AGENT mode keeps the loop open for tool calls; ASK is the direct Q&A shape.
  const mode = tools && tools.length > 0 ? AgentMode.AGENT : AgentMode.ASK;

  const transport = makeTransport(opts, () => accessToken, checksum);
  const requestId = crypto.randomUUID();
  transport.seed(requestId, 0n);

  // Resolve the upstream's proxies so the DurableHttpSession dials RunSSE
  // through them (the buffered Fetcher can't stream through a proxy). Empty =
  // direct. Absent resolver (test mocks) = direct.
  const proxies = (await getProviderRepo().proxies?.resolveForUpstream(opts.upstreamId)) ?? [];

  const broker = getDurableHttpSession();
  let handle: DurableHttpSessionHandle | null;
  try {
    handle = await opts.call.recordUpstreamLatency(
      broker.acquire(sessionKey, { ...transport.runSseInit(requestId), proxies }, { signal: opts.signal }),
    );
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { ok: false, modelKey: opts.model.id, response: await opts.call.recordUpstreamLatency(Promise.resolve(synthetic503(`Cursor RunSSE dial failed: ${m}`))) };
  }
  if (!handle) {
    return { ok: false, modelKey: opts.model.id, response: await opts.call.recordUpstreamLatency(Promise.resolve(synthetic503('Cursor session broker unavailable'))) };
  }

  // The RunSSE read is owned by the DurableHttpSession, so a non-200 upstream
  // status surfaces here (not in the transport). Surface it as a thrown stream
  // error so the gateway returns a 502.
  if (handle.status !== 200) {
    const bodyText = await new Response(handle.body).text().catch(() => '');
    await handle.discard(`RunSSE status ${handle.status}`).catch(() => {});
    const events = (async function* (): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {
      throw new Error(`SSE stream failed: ${handle.status} - ${bodyText}`);
    })();
    return { ok: true, events, modelKey: opts.model.id };
  }

  const id = `chatcmpl-cursor-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const translator = createAgentTranslator({ id, model: opts.model.id, created, composer: isComposerModel(opts.model.id), sessionKey });

  const gen = transport.openChatStream({ readStream: handle.body, request: { message, model: opts.wireModelId ?? cursorWireModelId(opts.model), tools, mode, maxMode: opts.maxMode, ...(images.length > 0 ? { images } : {}) } });
  // The first pull sends the RunRequest (BidiAppend) then reads; pull past
  // cursor's pre-output control frames to the model's first token so the
  // recorded `upstream_success` latency is TTFT, and satisfy the ok=true
  // latency assertion. broker.acquire above stays wrapped too so the non-200
  // early-return path still records a duration; on success this later wrap wins.
  const first = await opts.call.recordUpstreamLatency(pullToFirstMeaningful(gen));
  return { ok: true, events: buildEvents(opts, transport, gen, translator, sessionKey, requestId, handle, first), modelKey: opts.model.id };
};

/**
 * Resume a tool-result follow-up on the live RunSSE stream held by the
 * DurableHttpSession, seeded by the {requestId, seqno, leftover} persisted in
 * D1. Returns null when the session can't be resumed (no row / busy claim /
 * lost socket) so the caller cold-resumes via a fresh open().
 *
 * Token freshness: the access token is re-minted on this request's isolate and
 * injected via getAuthToken, so a follow-up arriving after the prior turn's
 * token expired still authenticates.
 */
const performResume = async (
  opts: CallCursorChatCompletionsOptions,
  accessToken: string,
  checksum: string,
  sessionKey: string,
): Promise<ProviderStreamResult<ChatCompletionsStreamEvent> | null> => {
  const repo = getProviderRepo().cursorSessions;
  // Single-flight: claim atomically locks the row (or returns null if missing /
  // already claimed by a racing follow-up → cold-resume).
  const row = await repo.claim(sessionKey, CLAIM_TTL_MS);
  if (!row) return null;

  const broker = getDurableHttpSession();
  let handle: DurableHttpSessionHandle | null;
  try {
    handle = await opts.call.recordUpstreamLatency(broker.acquire(sessionKey, null, { signal: opts.signal }));
  } catch {
    handle = null;
  }
  if (!handle) {
    // Read socket gone (idle-evicted / 15-min cap / cross-instance miss) → drop
    // the stale row and cold-resume.
    await repo.delete(sessionKey).catch(() => {});
    return null;
  }

  const transport = makeTransport(opts, () => accessToken, checksum);
  transport.seed(row.requestId, BigInt(row.appendSeqno));

  // Send each tool result on the same stream: the cursor exec ref (id + execId)
  // is decoded from the client's echoed tool_call_id — no server-side map.
  const toolMessages = opts.body.messages.filter(m => m.role === 'tool' && typeof m.tool_call_id === 'string');
  const sendToolResults = async (): Promise<void> => {
    for (const toolMsg of toolMessages) {
      const ref = decodeToolCallId(toolMsg.tool_call_id!);
      if (!ref) continue;
      const content = typeof toolMsg.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg.content);
      await transport.sendMcpResultRaw(ref.id, ref.execId, { success: { content } });
    }
  };

  const id = `chatcmpl-cursor-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const translator = createAgentTranslator({ id, model: opts.model.id, created, composer: isComposerModel(opts.model.id), sessionKey });

  const gen = transport.resumeChatStream({ readStream: handle.body, leftover: row.leftover });
  // TTFT on a resume spans sending the tool results → the model's first new
  // token; wrap both so `upstream_success` reflects the model's turnaround, not
  // just the tool-result write round-trip.
  const first = await opts.call.recordUpstreamLatency(
    (async () => {
      await sendToolResults();
      return await pullToFirstMeaningful(gen);
    })(),
  );
  return { ok: true, events: buildEvents(opts, transport, gen, translator, sessionKey, row.requestId, handle, first), modelKey: opts.model.id };
};
