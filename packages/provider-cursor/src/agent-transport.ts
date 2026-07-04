/**
 * Cursor Agent transport — HTTP/1.1 dual-channel driver.
 *
 * RunSSE (server-streaming read) + BidiAppend (unary write) over plain fetch,
 * no node:http2. Workers + Node dual-target. Produces AgentStreamChunk events
 * consumed by agent-translate; the caller bridges those into Floway's
 * ProviderStreamResult.
 *
 * Workers-clean: crypto.randomUUID, bytesToHex, Uint8Array fetch bodies,
 * DecompressionStream for gzip. Environment facts come via RequestContextEnv.
 */

import {
  CURSOR_BIDI_APPEND_PATH,
  CURSOR_GRPC_WEB_CONTENT_TYPE,
  CURSOR_RUN_SSE_PATH,
  CURSOR_USER_AGENT,
} from './constants.ts';
import { TEXT_DECODER } from './proto/decoding.ts';
import {
  bytesToHex,
  addConnectEnvelope,
  readConnectFrame,
  isTrailerFrame,
  isCompressedFrame,
  parseTrailerMetadata,
  decompressGzip,
  parseProtoFields,
  parseInteractionUpdate,
  parseCheckpointTokenDetails,
  parseExecServerMessage,
  parseKvServerMessage,
  analyzeBlobData,
  extractAssistantContent,
  buildKvClientMessage,
  buildAgentClientMessageWithKv,
  buildExecClientMessageWithMcpResult,
  buildExecClientMessageWithRequestContextResult,
  buildExecClientMessageWithRejectedTool,
  buildAgentClientMessageWithExec,
  buildExecClientControlMessage,
  buildAgentClientMessageWithExecControl,
  encodeBidiRequestId,
  encodeBidiAppendRequest,
  buildRequestContext,
  encodeUserMessage,
  encodeUserMessageAction,
  encodeConversationAction,
  encodeModelDetails,
  encodeAgentRunRequest,
  encodeAgentClientMessage,
  AgentMode,
  type AgentStreamChunk,
  type AgentChatRequest,
  type ExecRequest,
  type KvServerMessage,
  type McpResult,
  type RequestContextEnv,
} from './proto/index.ts';

const MAX_BLOB_STORE_SIZE = 64;

// Repackage a parsed tool-call started/completed record as an AgentStreamChunk.
// Both events use the same payload shape and differ only by the chunk `type`.
type ToolCallLike = {
  callId: string;
  modelCallId: string;
  toolType: string;
  name: string;
  arguments: string;
};
const toolCallChunk = (
  type: 'tool_call_started' | 'tool_call_completed',
  tc: ToolCallLike,
): AgentStreamChunk => ({
  type,
  toolCall: {
    callId: tc.callId,
    modelCallId: tc.modelCallId,
    toolType: tc.toolType,
    name: tc.name,
    arguments: tc.arguments,
  },
});

const DEFAULT_HEARTBEAT = {
  // No progress yet: be conservative — close fast if the backend stalls before
  // first output so we don't burn a Workers subrequest on a dead turn.
  idleBeforeProgressMs: 30_000,
  maxBeforeProgress: 15,
  // After first output: the turn ends authoritatively on the IU[14] turn_ended
  // frame (or an exec pause). This idle window is only a stall safety net for a
  // genuinely wedged upstream that stops sending turn_ended AND stops streaming
  // — kept generous so a long mid-answer reasoning pause (which emits
  // heartbeats) is never mistaken for the end.
  idleAfterProgressMs: 30_000,
};

export interface AgentTransportOptions {
  /** Supplies the Bearer access token. A getter (not a captured string) so a
   * resume on a long-lived session can swap in a freshly-minted token. */
  getAuthToken: () => string;
  baseUrl: string;
  env: RequestContextEnv;
  clientVersion: string;
  /** Privacy/ghost-mode toggle sent as x-ghost-mode. */
  privacyMode?: boolean;
  /** Supplies the x-cursor-checksum header (pure-compute, see checksum.ts). */
  getChecksum: () => string;
  /** Optional fetch injection (tests / per-upstream proxy). Defaults to global. */
  fetch?: typeof fetch;
  /** BidiAppend retry count for transient network errors. Default 1. */
  maxRetries?: number;
  heartbeat?: Partial<typeof DEFAULT_HEARTBEAT>;
}

const RETRYABLE_NETWORK_HINTS = [
  'socket',
  'connection',
  'econnreset',
  'etimedout',
  'epipe',
  'network',
  'fetch',
];

function isRetryableNetworkError(message: string): boolean {
  const lower = message.toLowerCase();
  return RETRYABLE_NETWORK_HINTS.some(hint => lower.includes(hint));
}

/**
 * Cursor Agent dual-channel transport. One instance per chat turn — the blob
 * store and seqno are turn-scoped and cleared on openChatStream.
 */
export class AgentTransport {
  private readonly getAuthToken: () => string;
  private readonly baseUrl: string;
  private readonly env: RequestContextEnv;
  private readonly clientVersion: string;
  private readonly privacyMode: boolean;
  private readonly getChecksum: () => string;
  private readonly fetchFn: typeof fetch;
  private readonly maxRetries: number;
  private readonly heartbeat: typeof DEFAULT_HEARTBEAT;

  private readonly blobStore = new Map<string, Uint8Array>();
  private readonly blobStoreOrder: string[] = [];

  // Turn-scoped state. seed() sets requestId+seqno before open/resume; the read
  // stream + socket lifetime are owned by the DurableHttpSession, so the
  // transport no longer holds an AbortController/timeout of its own.
  private currentRequestId: string | null = null;
  private currentAppendSeqno = 0n;
  // RunSSE bytes read past the exec_mcp frame but not yet parsed, captured at
  // the pause so a cross-instance resume can prepend them (see driveReadLoop).
  private suspendedLeftover: Uint8Array | null = null;

  constructor(opts: AgentTransportOptions) {
    this.getAuthToken = opts.getAuthToken;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.env = opts.env;
    this.clientVersion = opts.clientVersion;
    this.privacyMode = opts.privacyMode ?? true;
    this.getChecksum = opts.getChecksum;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.maxRetries = opts.maxRetries ?? 1;
    this.heartbeat = { ...DEFAULT_HEARTBEAT, ...opts.heartbeat };
  }

  /** The unparsed RunSSE remainder at the last exec_mcp pause (usually empty). */
  get leftover(): Uint8Array | null {
    return this.suspendedLeftover;
  }

  /** The next BidiAppend seqno (to persist for a cross-instance resume). */
  get seqno(): bigint {
    return this.currentAppendSeqno;
  }

  private getHeaders(requestId?: string): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.getAuthToken()}`,
      'content-type': CURSOR_GRPC_WEB_CONTENT_TYPE,
      'user-agent': CURSOR_USER_AGENT,
      'x-cursor-checksum': this.getChecksum(),
      'x-cursor-client-version': this.clientVersion,
      'x-cursor-client-type': 'cli',
      'x-cursor-timezone': this.env.timezone,
      'x-ghost-mode': this.privacyMode ? 'true' : 'false',
      // Ask the backend to stream text back over RunSSE instead of stashing
      // assistant responses in KV blobs.
      'x-cursor-streaming': 'true',
    };
    if (requestId) headers['x-request-id'] = requestId;
    return headers;
  }

  private blobIdToKey(blobId: Uint8Array): string {
    return bytesToHex(blobId);
  }

  private storeBlob(key: string, data: Uint8Array): void {
    const existingIndex = this.blobStoreOrder.indexOf(key);
    if (existingIndex !== -1) this.blobStoreOrder.splice(existingIndex, 1);

    while (this.blobStore.size >= MAX_BLOB_STORE_SIZE && this.blobStoreOrder.length > 0) {
      const oldestKey = this.blobStoreOrder.shift();
      if (oldestKey) this.blobStore.delete(oldestKey);
    }

    this.blobStore.set(key, data);
    this.blobStoreOrder.push(key);
  }

  private clearBlobStore(): void {
    this.blobStore.clear();
    this.blobStoreOrder.length = 0;
  }

  /**
   * POST one AgentClientMessage on the BidiAppend write channel. Retries
   * transient network errors up to maxRetries with exponential backoff.
   */
  async bidiAppend(requestId: string, appendSeqno: bigint, data: Uint8Array): Promise<void> {
    const hexData = bytesToHex(data);
    const appendRequest = encodeBidiAppendRequest(hexData, requestId, appendSeqno);
    const envelope = addConnectEnvelope(appendRequest);
    const url = `${this.baseUrl}${CURSOR_BIDI_APPEND_PATH}`;

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.fetchFn(url, {
          method: 'POST',
          headers: this.getHeaders(requestId),
          body: envelope as BodyInit,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`BidiAppend failed: ${response.status} - ${errorText}`);
        }

        // Drain the (usually empty) response body.
        await response.arrayBuffer();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (isRetryableNetworkError(lastError.message) && attempt < this.maxRetries) {
          const delay = Math.min(1000 * 2 ** attempt, 4000);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw lastError;
      }
    }
    throw lastError ?? new Error('BidiAppend failed with unknown error');
  }

  private buildChatMessage(request: AgentChatRequest): Uint8Array {
    const messageId = crypto.randomUUID();
    const conversationId = request.conversationId ?? crypto.randomUUID();
    const model = request.model ?? 'gpt-4o';
    const mode = request.mode ?? AgentMode.AGENT;

    const requestContext = buildRequestContext(this.env, request.tools);
    const userMessage = encodeUserMessage(request.message, messageId, mode, request.images);
    const userMessageAction = encodeUserMessageAction(userMessage, requestContext);
    const conversationAction = encodeConversationAction(userMessageAction);
    const modelDetails = encodeModelDetails(model, request.maxMode);
    const agentRunRequest = encodeAgentRunRequest(
      conversationAction,
      modelDetails,
      conversationId,
      request.tools,
      this.env.workspacePath,
    );
    return encodeAgentClientMessage(agentRunRequest);
  }

  private async handleKvMessage(kvMsg: KvServerMessage, requestId: string): Promise<bigint> {
    const seqno = this.currentAppendSeqno;

    if (kvMsg.messageType === 'get_blob_args' && kvMsg.blobId) {
      const key = this.blobIdToKey(kvMsg.blobId);
      const data = this.blobStore.get(key);
      const result = data ?? new Uint8Array(0);
      const kvClientMsg = buildKvClientMessage(kvMsg.id, 'get_blob_result', result);
      const responseMsg = buildAgentClientMessageWithKv(kvClientMsg);
      await this.bidiAppend(requestId, seqno, responseMsg);
      return seqno + 1n;
    }

    if (kvMsg.messageType === 'set_blob_args' && kvMsg.blobId && kvMsg.blobData) {
      const key = this.blobIdToKey(kvMsg.blobId);
      this.storeBlob(key, kvMsg.blobData);

      const result = new Uint8Array(0);
      const kvClientMsg = buildKvClientMessage(kvMsg.id, 'set_blob_result', result);
      const responseMsg = buildAgentClientMessageWithKv(kvClientMsg);
      await this.bidiAppend(requestId, seqno, responseMsg);
      return seqno + 1n;
    }

    return seqno;
  }

  /**
   * Send an ExecClientMessage result then the stream-close control frame.
   * Used by every tool-result path (mcp, rejected built-in, request_context).
   */
  private async sendExecAndClose(id: number, execId: string | undefined, execClientMessage: Uint8Array): Promise<void> {
    if (!this.currentRequestId) throw new Error('No active chat stream — cannot send exec result');

    const responseMsg = buildAgentClientMessageWithExec(execClientMessage);
    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, responseMsg);
    this.currentAppendSeqno += 1n;

    const controlMsg = buildExecClientControlMessage(id);
    const controlResponseMsg = buildAgentClientMessageWithExecControl(controlMsg);
    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, controlResponseMsg);
    this.currentAppendSeqno += 1n;
  }

  /**
   * Send an ExecClientMessage result WITHOUT a stream-close control frame.
   * Cursor's MCP protocol treats a single mcp_result as the complete tool
   * output and auto-resumes the model turn on the same RunSSE read channel —
   * an extra exec-stream-close (or a ResumeAction) makes the server finalize
   * the turn instead of continuing, yielding an empty follow-up reply. This
   * mirrors the validated HTTP/2 reference (OmniRoute cursorSessionManager
   * .sendToolResult → encodeExecMcpResult, single frame, no close/resume).
   */
  private async sendExecResultNoClose(execClientMessage: Uint8Array): Promise<void> {
    if (!this.currentRequestId) throw new Error('No active chat stream — cannot send exec result');
    const responseMsg = buildAgentClientMessageWithExec(execClientMessage);
    await this.bidiAppend(this.currentRequestId, this.currentAppendSeqno, responseMsg);
    this.currentAppendSeqno += 1n;
  }

  /**
   * Send an MCP tool result from just the exec identity (id + exec_id) — a
   * cross-instance resume reconstructs these from the client's echoed
   * tool_call_id (see session-id.ts decodeToolCallId), without the original
   * exec_request object.
   */
  async sendMcpResultRaw(id: number, execId: string | undefined, result: McpResult): Promise<void> {
    const execClientMsg = buildExecClientMessageWithMcpResult(id, execId, result);
    await this.sendExecResultNoClose(execClientMsg);
  }

  /** Reject a built-in tool request so the model can adapt and keep streaming. */
  async sendRejectedTool(execRequest: ExecRequest, reason: string): Promise<void> {
    const execClientMsg = buildExecClientMessageWithRejectedTool(execRequest, reason);
    await this.sendExecAndClose(execRequest.id, execRequest.execId, execClientMsg);
  }

  /** Answer a request_context exec with the gateway environment. */
  async sendRequestContextResult(id: number, execId: string | undefined): Promise<void> {
    const execClientMsg = buildExecClientMessageWithRequestContextResult(id, execId, this.env);
    await this.sendExecAndClose(id, execId, execClientMsg);
  }

  /**
   * Seed the turn-scoped write-channel state before open/resume. requestId +
   * seqno are generated/loaded by the caller (fetch.ts) so they can be shared
   * with the DurableHttpSession RunSSE request and persisted to D1 for a
   * cross-instance resume.
   */
  seed(requestId: string, seqno: bigint): void {
    this.currentRequestId = requestId;
    this.currentAppendSeqno = seqno;
    this.suspendedLeftover = null;
    this.clearBlobStore();
  }

  /**
   * The RunSSE POST spec the caller hands to DurableHttpSession.acquire — the
   * read socket lives in the session, not the transport. The body is just the
   * requestId envelope; the actual RunRequest goes out on BidiAppend (open()).
   */
  runSseInit(requestId: string): { method: 'POST'; url: string; headers: Record<string, string>; body: Uint8Array } {
    return {
      method: 'POST',
      url: `${this.baseUrl}${CURSOR_RUN_SSE_PATH}`,
      headers: this.getHeaders(requestId),
      body: addConnectEnvelope(encodeBidiRequestId(requestId)),
    };
  }

  /**
   * Open turn: send the initial RunRequest on BidiAppend (seqno 0, seeded by
   * seed()), then pump the provided RunSSE read stream. The stream comes from
   * the DurableHttpSession; the transport never fetches RunSSE itself.
   */
  async *openChatStream(opts: { readStream: ReadableStream<Uint8Array>; request: AgentChatRequest }): AsyncGenerator<AgentStreamChunk> {
    const requestId = this.currentRequestId;
    if (!requestId) throw new Error('openChatStream called before seed()');
    const messageBody = this.buildChatMessage(opts.request);
    try {
      await this.bidiAppend(requestId, this.currentAppendSeqno, messageBody);
      this.currentAppendSeqno += 1n;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield { type: 'error', error: `BidiAppend initial RunRequest failed: ${message}` };
      return;
    }
    yield* this.driveReadLoop(opts.readStream.getReader(), new Uint8Array(0));
  }

  /**
   * Resume turn: the RunRequest was already sent on a prior turn and the
   * caller has seeded {requestId, seqno} and sent the ExecMcpResult; we just
   * pump the continued RunSSE read stream, prepending any leftover bytes the
   * prior turn read past its exec_mcp pause.
   */
  async *resumeChatStream(opts: { readStream: ReadableStream<Uint8Array>; leftover: Uint8Array | null }): AsyncGenerator<AgentStreamChunk> {
    yield* this.driveReadLoop(opts.readStream.getReader(), opts.leftover ?? new Uint8Array(0));
  }

  /**
   * Pump AgentServerMessage frames off the RunSSE read stream as
   * AgentStreamChunk events until turn_ended / idle / done / error.
   *
   * The caller drives exec_request disposition: on an mcp exec it translates to
   * a downstream tool_calls chunk and stops pulling (the pause point — leftover
   * is captured here); on a built-in/request_context exec it answers on the
   * write channel and keeps pulling.
   */
  private async *driveReadLoop(reader: ReadableStreamDefaultReader<Uint8Array>, initialBuffer: Uint8Array): AsyncGenerator<AgentStreamChunk> {
    let lastProgressAt = Date.now();
    let heartbeatSinceProgress = 0;
    let hasProgress = false;
    const markProgress = (): void => {
      heartbeatSinceProgress = 0;
      lastProgressAt = Date.now();
      hasProgress = true;
    };

    const pendingAssistantBlobs: Array<{ blobId: string; content: string }> = [];
    let hasStreamedText = false;
    let streamedTextChars = 0;

    try {
      let buffer = initialBuffer;
      // Read cursor into `buffer` — advanced past every complete frame we've
      // parsed. The next read merges only the still-unparsed tail (buffer from
      // `offset` onward) with the new chunk instead of re-concatenating the
      // whole running buffer on every reader.read().
      let offset = 0;
      let turnEnded = false;

      try {
        while (!turnEnded) {
          const { done, value } = await reader.read();
          if (done) {
            yield { type: 'done' };
            break;
          }
          if (!value || value.byteLength === 0) continue;

          const tailLen = buffer.length - offset;
          if (tailLen === 0) {
            // Fast path: buffer was fully consumed, no copy needed.
            buffer = value;
          } else {
            const merged = new Uint8Array(tailLen + value.length);
            merged.set(buffer.subarray(offset), 0);
            merged.set(value, tailLen);
            buffer = merged;
          }
          offset = 0;
          // Parse as many complete connect frames as the buffer currently holds.

          while (true) {
            const frame = readConnectFrame(buffer, offset);
            if (!frame) break;
            offset = frame.nextOffset;

            let payload = frame.payload;
            if (isCompressedFrame(frame.flags)) {
              try {
                payload = await decompressGzip(frame.payload);
              } catch {
                // leave payload compressed; field parsing will likely skip it
              }
            }

            if (isTrailerFrame(frame.flags)) {
              const trailer = TEXT_DECODER.decode(payload);
              const meta = parseTrailerMetadata(trailer);
              const grpcStatus = Number(meta['grpc-status'] ?? '0');
              if (grpcStatus !== 0) {
                const grpcMessage = meta['grpc-message'] ? decodeURIComponent(meta['grpc-message']) : 'Unknown gRPC error';
                yield { type: 'error', error: `${grpcMessage} (grpc-status ${grpcStatus})` };
              }
              continue;
            }

            const serverMsgFields = parseProtoFields(payload);
            for (const field of serverMsgFields) {
              try {
                if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  const parsed = parseInteractionUpdate(field.value);

                  if (parsed.text) {
                    hasStreamedText = true;
                    streamedTextChars += parsed.text.length;
                    markProgress();
                    yield { type: 'text', content: parsed.text };
                  }
                  if (parsed.thinking) {
                    markProgress();
                    yield { type: 'thinking', content: parsed.thinking };
                  }
                  if (parsed.toolCallStarted) {
                    markProgress();
                    yield toolCallChunk('tool_call_started', parsed.toolCallStarted);
                  }
                  if (parsed.toolCallCompleted) {
                    markProgress();
                    yield toolCallChunk('tool_call_completed', parsed.toolCallCompleted);
                  }
                  if (parsed.partialToolCall) {
                    markProgress();
                    yield {
                      type: 'partial_tool_call',
                      toolCall: {
                        callId: parsed.partialToolCall.callId,
                        toolType: 'partial',
                        name: 'partial',
                        arguments: '',
                      },
                      partialArgs: parsed.partialToolCall.argsTextDelta,
                    };
                  }
                  if (parsed.tokenDelta !== null) {
                    // Cursor's streamed output-token counter. Real activity, so
                    // it counts as progress; the translator sums it into the
                    // per-request completion_tokens.
                    markProgress();
                    yield { type: 'token', tokens: parsed.tokenDelta };
                  }
                  if (parsed.isComplete) {
                    // InteractionUpdate field 14 (turn_ended) — cursor's
                    // authoritative end-of-turn marker. Verified on the wire to
                    // arrive after the final answer text (after the closing KV
                    // checkpoints and the field-17 usage update). This is the
                    // signal we close the session on; everything below is a
                    // stall-safety fallback, not a normal end path.
                    turnEnded = true;
                  }
                  if (parsed.isHeartbeat) {
                    heartbeatSinceProgress++;
                    const idleMs = Date.now() - lastProgressAt;
                    if (hasProgress) {
                      // The model has already produced output. Heartbeats here
                      // are keep-alives during cursor's own pauses (KV
                      // checkpointing, the gap before turn_ended, mid-answer
                      // reasoning). They must NOT preempt the turn_ended frame —
                      // a raw beat count would truncate short answers whose
                      // turn_ended lags a beat or two behind the last text
                      // (observed). So after progress we only close on a long
                      // *time* idle (a genuine upstream stall), never on count.
                      if (idleMs >= this.heartbeat.idleAfterProgressMs) {
                        turnEnded = true;
                      } else {
                        yield { type: 'heartbeat' };
                      }
                    } else if (heartbeatSinceProgress >= this.heartbeat.maxBeforeProgress || idleMs >= this.heartbeat.idleBeforeProgressMs) {
                      // Before any output: a stream that never produces is
                      // detected by either a beat count or an idle window.
                      turnEnded = true;
                    } else {
                      yield { type: 'heartbeat' };
                    }
                  }
                } else if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  // conversation_checkpoint_update — NOT a completion signal;
                  // exec_server_message can follow. Just mark progress. Cursor
                  // stamps the live context accounting (used/max tokens) here;
                  // surface it so the translator can report a per-request total.
                  markProgress();
                  const td = parseCheckpointTokenDetails(field.value);
                  if (td) yield { type: 'checkpoint', usedTokens: td.usedTokens, maxTokens: td.maxTokens };
                  else yield { type: 'checkpoint' };
                } else if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  const execRequest = parseExecServerMessage(field.value);
                  if (execRequest) {
                    markProgress();
                    // An mcp exec is the pause point: the caller stops pulling
                    // here. Capture the unparsed remainder so a cross-instance
                    // resume (fresh transport, fresh DurableHttpSession view) can
                    // prepend it — these bytes were already dequeued from the
                    // session and won't be re-served. Usually empty (cursor
                    // pauses right after exec_mcp).
                    if (execRequest.type === 'mcp') this.suspendedLeftover = buffer.slice(offset);
                    yield { type: 'exec_request', execRequest };
                  }
                } else if (field.fieldNumber === 4 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  const kvMsg = parseKvServerMessage(field.value);
                  if (kvMsg.messageType === 'set_blob_args' && kvMsg.blobId && kvMsg.blobData) {
                    const key = this.blobIdToKey(kvMsg.blobId);
                    const analysis = analyzeBlobData(kvMsg.blobData);
                    for (const item of extractAssistantContent(analysis, key)) {
                      pendingAssistantBlobs.push(item);
                    }
                  }
                  // kv_server_message: cursor checkpointing conversation state
                  // (it pushes set_blob frames for us to store, and get_blob
                  // frames to re-read on a follow-up). NOT a turn-end signal —
                  // turn termination is the authoritative IU[14] turn_ended
                  // frame (or an exec pause), which always arrives after the
                  // closing KV checkpoints. We answer KV here (blob store) so
                  // the model can finish; a stalled reply pins the seqno and
                  // wedges the whole turn (see handleKvMessage).
                  try {
                    // Assign the returned next-seqno back: handleKvMessage sends
                    // a kv_client_message on the shared BidiAppend channel and
                    // returns seqno+1. Dropping the return value pinned the
                    // seqno, so multiple blob requests in one turn (common on a
                    // tool-result follow-up, where cursor re-fetches conversation
                    // blobs) all replied at the same seqno — cursor ignores the
                    // duplicates, the blob channel stalls, and the model emits an
                    // empty continuation.
                    this.currentAppendSeqno = await this.handleKvMessage(kvMsg, this.currentRequestId!);
                  } catch (kvErr) {
                    const msg = kvErr instanceof Error ? kvErr.message : String(kvErr);
                    if (isRetryableNetworkError(msg)) {
                      yield { type: 'error', error: `Network error during KV: ${msg}` };
                      turnEnded = true;
                    }
                    // non-network KV errors: swallow, keep streaming
                  }
                } else if (field.fieldNumber === 5 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  markProgress();
                  yield { type: 'exec_server_abort' };
                } else if (field.fieldNumber === 7 && field.wireType === 2 && field.value instanceof Uint8Array) {
                  const queryFields = parseProtoFields(field.value);
                  let queryId = 0;
                  let queryType = 'unknown';
                  for (const qf of queryFields) {
                    if (qf.fieldNumber === 1 && qf.wireType === 0) queryId = Number(qf.value);
                    else if (qf.fieldNumber === 2) queryType = 'web_search';
                    else if (qf.fieldNumber === 3) queryType = 'ask_question';
                    else if (qf.fieldNumber === 4) queryType = 'switch_mode';
                    else if (qf.fieldNumber === 5) queryType = 'exa_search';
                    else if (qf.fieldNumber === 6) queryType = 'exa_fetch';
                  }
                  markProgress();
                  yield { type: 'interaction_query', queryId, queryType };
                }
              } catch (parseErr) {
                const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
                if (isRetryableNetworkError(msg)) {
                  yield { type: 'error', error: `Network error: ${msg}` };
                  turnEnded = true;
                } else {
                  yield { type: 'error', error: `Parse error in field ${field.fieldNumber}: ${msg}` };
                }
              }
            }

            if (turnEnded) break;
          }
        }

        if (turnEnded) {
          if (pendingAssistantBlobs.length > 0) {
            if (!hasStreamedText) {
              // Recovery path: the model streamed no text this turn (an
              // observed empty continuation), but cursor checkpointed the
              // answer into KV blobs — surface them so the caller isn't left
              // with nothing.
              for (const blob of pendingAssistantBlobs) {
                yield { type: 'kv_blob_assistant', blobContent: blob.content };
              }
            } else {
              // Discard boundary: the streamed text is the answer and the KV
              // blob is a redundant checkpoint mirror, so it's dropped to avoid
              // duplicating the reply. Measured over batches of long kimi-k2.5
              // conversations, this fires on essentially every turn and the blob
              // is a byte-for-byte mirror of the stream (zero content lost). So
              // we stay silent on the normal case and only warn if a blob ever
              // carries MORE than the stream did — the one shape where the drop
              // would lose real content (e.g. a stream truncated mid-answer).
              const blobChars = pendingAssistantBlobs.reduce((n, b) => n + b.content.length, 0);
              if (blobChars > streamedTextChars) {
                console.warn(
                  `Cursor KV-blob exceeds stream: req=${this.currentRequestId ?? '?'} ` +
                    `blobChars=${blobChars} streamedChars=${streamedTextChars} ` +
                    `blobs=${pendingAssistantBlobs.length} — discarded blob carried content beyond the stream`,
                );
              }
            }
          }
          yield { type: 'done' };
        }
      } finally {
        reader.releaseLock();
      }
    } catch (err: unknown) {
      const error = err as Error & { name?: string };
      if (error.name === 'AbortError') return; // stream cancelled by the caller
      yield { type: 'error', error: error.message || String(err) };
    }
  }
}
