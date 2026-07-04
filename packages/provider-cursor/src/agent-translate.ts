/**
 * Cursor Agent → OpenAI Chat Completions stream translator.
 *
 * Consumes AgentStreamChunk events from agent-transport and emits
 * ChatCompletionsStreamEvent frames. The caller (fetch.ts) wraps each event
 * with eventFrame/doneFrame into a ProviderStreamResult.
 *
 * Composer thinking-as-content: the composer-* family puts the visible reply
 * inside the `thinking` field after a final `</think>` sentinel, optionally
 * wrapped in `<｜final｜>`/`<|final|>` tags. The chain-of-thought prefix is
 * hidden; only the suffix is surfaced as `content`. Non-composer models map
 * `thinking` straight to `reasoning_text`.
 */

import type { AgentStreamChunk, ExecRequest } from './proto/index.ts';
import { wrapToolCallId } from './session-id.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';

const COMPOSER_THINK_END = '</think>';

const COMPOSER_OPEN_MARKER = /^\s*<[｜|]\s*final\s*[｜|]>\s*/i;
const COMPOSER_CLOSE_MARKER = /\s*<[｜|]\s*\/\s*final\s*[｜|]>\s*$/i;
const COMPOSER_PARTIAL_OPEN = /^\s*<(?![｜|/])/;
const COMPOSER_PARTIAL_OPEN_PIPE = /^\s*<[｜|][^>]*$/;

export function isComposerModel(model: string | undefined | null): boolean {
  const id = String(model ?? '')
    .split('/')
    .pop();
  return /^composer(?:-|$)/i.test(id ?? '');
}

/**
 * Extract the user-facing reply from an accumulated composer thinking buffer:
 * everything after the last `</think>`, with optional `<｜final｜>` wrapper
 * stripped. Returns "" until the sentinel has arrived (so partial marker
 * fragments don't leak as content).
 */
export function visibleComposerContentFromThinking(thinking: string): string {
  if (!thinking) return '';
  const endIdx = thinking.lastIndexOf(COMPOSER_THINK_END);
  if (endIdx < 0) return '';
  let visible = thinking.slice(endIdx + COMPOSER_THINK_END.length).trimStart();
  if (COMPOSER_OPEN_MARKER.test(visible)) {
    visible = visible.replace(COMPOSER_OPEN_MARKER, '');
  } else if (COMPOSER_PARTIAL_OPEN.test(visible) || COMPOSER_PARTIAL_OPEN_PIPE.test(visible)) {
    return '';
  }
  return visible.replace(COMPOSER_CLOSE_MARKER, '').trim();
}

export interface TranslatorOptions {
  id: string;
  model: string;
  created: number;
  composer?: boolean;
  /**
   * When set, tool_call_id values emitted in tool_calls deltas are wrapped
   * with `sess_<sessionId>__` so the OpenAI client echoes them back on the
   * next turn, enabling session correlation. Leave undefined to emit cursor's
   * raw tool_call_id (backward-compatible, no session persistence).
   */
  sessionKey?: string;
}

export interface AgentTranslator {
  /** Map one transport chunk to 0..N stream events. */
  translate(chunk: AgentStreamChunk): ChatCompletionsStreamEvent[];
  /** Emit the terminal finish_reason chunk. Idempotent. */
  finalize(): ChatCompletionsStreamEvent[];
  /**
   * The model's context window as reported by the run's last checkpoint
   * (ConversationTokenDetails.maxTokens), or null if no checkpoint carried it.
   * The caller persists this into the per-model context cache.
   */
  observedMaxTokens(): number | null;
}

type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

export function createAgentTranslator(opts: TranslatorOptions): AgentTranslator {
  const composer = opts.composer ?? isComposerModel(opts.model);

  // Cursor packs two ids into one toolCallId string, separated by a newline:
  // an OpenAI-style `call_…` token first, then a Responses-API-style `fc_…`
  // token. OpenAI clients expect a single id with no embedded whitespace, so
  // we surface only the leading call_… form. Used for built-in tool calls,
  // which are never resumed; the MCP path (translateExecRequest) instead wraps
  // the exec ref via wrapToolCallId so a follow-up can rebuild the result.
  const cleanCallId = (raw: string): string => raw.split('\n')[0]!.trim();

  let emittedRole = false;
  let toolCallIndex = 0;
  let currentToolCallIndex = 0;
  let emittedToolCalls = 0;
  let endReason: 'tool_calls' | null = null;
  let finalized = false;

  // Composer thinking-as-content accumulation.
  let thinkingText = '';
  let composerVisibleEmittedLength = 0;

  // Per-request token accounting recovered from the RunSSE stream: cursor's
  // TokenDeltaUpdate increments summed into the output count, and the latest
  // ConversationTokenDetails.usedTokens as the authoritative context total.
  let outputTokens = 0;
  let contextUsedTokens: number | null = null;
  // The model's context window (ConversationTokenDetails.maxTokens), surfaced
  // to the caller for the per-model context cache.
  let contextMaxTokens: number | null = null;

  const makeEvent = (
    delta: NonNullable<ChatCompletionsStreamEvent['choices'][number]['delta']>,
    finishReason: FinishReason | null = null,
  ): ChatCompletionsStreamEvent => {
    if (!emittedRole) {
      delta = { role: 'assistant', ...delta };
      emittedRole = true;
    }
    return {
      id: opts.id,
      object: 'chat.completion.chunk',
      created: opts.created,
      model: opts.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
  };

  const emitToolCallStart = (index: number, id: string, name: string): ChatCompletionsStreamEvent => {
    return makeEvent({
      tool_calls: [{ index, id, type: 'function', function: { name } }],
    });
  };

  const translate = (chunk: AgentStreamChunk): ChatCompletionsStreamEvent[] => {
    switch (chunk.type) {
    case 'text': {
      if (!chunk.content) return [];
      return [makeEvent({ content: chunk.content })];
    }

    case 'kv_blob_assistant': {
      if (!chunk.blobContent) return [];
      return [makeEvent({ content: chunk.blobContent })];
    }

    case 'thinking': {
      if (!chunk.content) return [];
      if (!composer) {
        return [makeEvent({ reasoning_text: chunk.content })];
      }
      // Composer: accumulate, surface only the visible suffix incrementally.
      thinkingText += chunk.content;
      const visible = visibleComposerContentFromThinking(thinkingText);
      if (visible.length <= composerVisibleEmittedLength) return [];
      const delta = visible.slice(composerVisibleEmittedLength);
      composerVisibleEmittedLength = visible.length;
      return [makeEvent({ content: delta })];
    }

    case 'tool_call_started': {
      const tc = chunk.toolCall;
      if (!tc) return [];
      // Cursor's tool_call_started + partial_tool_call + tool_call_completed
      // for MCP tools are internal pre-warm signals: the toolCall.name is
      // always "mcp" (the cursor TOOL_FIELD_MAP entry for mcp_tool_call) and
      // the real user-facing tool name + args only land on the matching
      // exec_request that follows. Translating these would double-emit each
      // tool call with a placeholder name and break the OpenAI tool_calls
      // contract (one delta per call, with the real name). Skip them and let
      // exec_request own the translation.
      if (tc.toolType === 'mcp_tool_call' || tc.name === 'mcp') return [];
      const index = toolCallIndex++;
      currentToolCallIndex = index;
      emittedToolCalls++;
      endReason = 'tool_calls';
      return [emitToolCallStart(index, cleanCallId(tc.callId), tc.name)];
    }

    case 'tool_call_completed': {
      const tc = chunk.toolCall;
      if (!tc) return [];
      // Same rationale as tool_call_started: cursor's MCP completion echoes
      // the internal "mcp" type; the authoritative completion is the
      // exec_request that already produced the tool_calls delta.
      if (tc.toolType === 'mcp_tool_call' || tc.name === 'mcp') return [];
      // If no started chunk preceded it, claim a fresh index.
      if (emittedToolCalls === 0) {
        const index = toolCallIndex++;
        currentToolCallIndex = index;
        emittedToolCalls++;
        endReason = 'tool_calls';
      }
      return [
        makeEvent({
          tool_calls: [
            {
              index: currentToolCallIndex,
              id: cleanCallId(tc.callId),
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments ?? '' },
            },
          ],
        }),
      ];
    }

    case 'partial_tool_call': {
      // Skip until a real tool_call_started has run — without an index of our
      // own, an early partial would attach to the wrong tool. Cursor's MCP
      // partials are pre-warm noise (empty argsTextDelta) anyway; the real
      // arguments arrive whole on exec_request.
      if (emittedToolCalls === 0) return [];
      return [
        makeEvent({
          tool_calls: [
            {
              index: currentToolCallIndex,
              function: { arguments: chunk.partialArgs ?? '' },
            },
          ],
        }),
      ];
    }

    case 'exec_request': {
      return translateExecRequest(chunk.execRequest);
    }

    case 'token':
      // TokenDeltaUpdate increment — cursor's own output-token ticker.
      outputTokens += chunk.tokens ?? 0;
      return [];

    case 'checkpoint':
      // ConversationTokenDetails on a conversation checkpoint: usedTokens is
      // the live context occupancy (input + history + output-so-far). Keep the
      // latest; it becomes the request's authoritative total_tokens. maxTokens
      // is the model's context window, cached per-model by the caller.
      if (typeof chunk.usedTokens === 'number' && chunk.usedTokens > 0) contextUsedTokens = chunk.usedTokens;
      if (typeof chunk.maxTokens === 'number' && chunk.maxTokens > 0) contextMaxTokens = chunk.maxTokens;
      return [];

    case 'heartbeat':
    case 'interaction_query':
    case 'exec_server_abort':
      return [];

    case 'done':
    case 'error':
      // done/error are handled by the caller (finalize / error surfacing).
      return [];
    }
    return [];
  };

  /**
   * MCP exec requests become a downstream tool_calls delta (stateless passthru:
   * we do NOT reply on the BidiAppend channel — the next turn inlines the tool
   * result). Built-in tool exec requests are not translated here; the caller
   * rejects them on the write channel so the model keeps streaming.
   */
  const translateExecRequest = (execRequest: ExecRequest | undefined): ChatCompletionsStreamEvent[] => {
    if (!execRequest) return [];
    if (execRequest.type !== 'mcp') return [];

    const index = toolCallIndex++;
    currentToolCallIndex = index;
    emittedToolCalls++;
    endReason = 'tool_calls';
    return [
      makeEvent({
        tool_calls: [
          {
            index,
            // Encode the session id + cursor exec ref into the tool_call_id so a
            // follow-up (possibly cross-instance) rebuilds the ExecMcpResult from
            // the client's echoed id. Falls back to the bare call id when no
            // session is tracked (shouldn't happen for MCP turns).
            id: opts.sessionKey
              ? wrapToolCallId(opts.sessionKey, { id: execRequest.id, execId: execRequest.execId })
              : cleanCallId(execRequest.toolCallId),
            type: 'function',
            function: {
              name: execRequest.toolName || execRequest.name,
              arguments: JSON.stringify(execRequest.args ?? {}),
            },
          },
        ],
      }),
    ];
  };

  const finalize = (): ChatCompletionsStreamEvent[] => {
    if (finalized) return [];
    finalized = true;
    const finishReason: FinishReason = endReason === 'tool_calls' ? 'tool_calls' : 'stop';
    // A turn is accountable only when a ConversationTokenDetails checkpoint
    // arrived AND the turn didn't end on a tool-call pause. That checkpoint
    // carries cursor's authoritative CUMULATIVE context total and only lands at
    // the very end of a run, after the model's final answer:
    //   total_tokens      = usedTokens (input + history + all output so far)
    //   completion_tokens = Σ TokenDeltaUpdate.tokens (this turn's output),
    //                       clamped to total
    //   prompt_tokens     = total − completion
    // Tool-call turns pause at the exec_request before any checkpoint, so they
    // report ALL-ZERO here; the real usage lands on the final turn whose
    // checkpoint totals the whole run. A turn that ends with no checkpoint (a
    // transient empty turn) is likewise all-zero. In every case the request is
    // still counted — recordUsage logs the bare request row from the non-null
    // usage object.
    const total = finishReason !== 'tool_calls' && contextUsedTokens != null ? contextUsedTokens : 0;
    const completion = total > 0 ? Math.min(outputTokens, total) : 0;
    const prompt = total - completion;
    const usageEvent: ChatCompletionsStreamEvent = {
      id: opts.id,
      object: 'chat.completion.chunk',
      created: opts.created,
      model: opts.model,
      choices: [],
      usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total },
    };
    return [makeEvent({}, finishReason), usageEvent];
  };

  return { translate, finalize, observedMaxTokens: () => contextMaxTokens };
}
