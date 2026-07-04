/**
 * Cursor StreamCpp (Tab) transport: a Connect proto server-stream call.
 *
 * Unlike RunSSE (dual-channel via DurableHttpSession), StreamCpp is a plain
 * unary-request → server-stream: POST one enveloped proto frame, then read
 * enveloped response frames off the response body until the trailer. Runs over
 * the per-request proxy-aware `fetcher`; no persistent session needed. The Tab
 * backend is a separate, geo-routed host and expects client-type `ide`.
 */

import { CURSOR_GCPP_BACKEND_BASE, CURSOR_STREAM_CPP_PATH, CURSOR_TAB_CLIENT_VERSION, CURSOR_USER_AGENT } from './constants.ts';
import { TEXT_DECODER } from './proto/decoding.ts';
import { addConnectEnvelope, decompressGzip, FLAG_END_STREAM, isCompressedFrame, readConnectFrame } from './proto/envelope.ts';
import { decodeStreamCppResponse, encodeStreamCppRequest, type StreamCppLineRange, type StreamCppRequestInput } from './proto/stream-cpp.ts';
import type { Fetcher } from '@floway-dev/provider';

export interface StreamCppCallResult {
  ok: boolean;
  status: number;
  /** Accumulated completion text across data frames. */
  text: string;
  /** Line range the edit replaces, from the last frame that carried one. */
  rangeToReplace?: StreamCppLineRange;
  /** Trailer / error body when the call did not produce a clean completion. */
  errorBody?: string;
}

export const callStreamCpp = async (opts: {
  fetcher: Fetcher;
  accessToken: string;
  checksum: string;
  request: StreamCppRequestInput;
  signal?: AbortSignal;
}): Promise<StreamCppCallResult> => {
  const body = addConnectEnvelope(encodeStreamCppRequest(opts.request));
  const response = await opts.fetcher(`${CURSOR_GCPP_BACKEND_BASE}${CURSOR_STREAM_CPP_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.accessToken}`,
      'content-type': 'application/connect+proto',
      'connect-protocol-version': '1',
      'user-agent': CURSOR_USER_AGENT,
      'x-cursor-checksum': opts.checksum,
      'x-cursor-client-version': CURSOR_TAB_CLIENT_VERSION,
      'x-cursor-client-type': 'ide',
      'x-cursor-streaming': 'true',
      'x-request-id': crypto.randomUUID(),
      'x-session-id': crypto.randomUUID(),
      'x-ghost-mode': 'true',
    },
    body: body as BodyInit,
    signal: opts.signal,
  });

  if (!response.ok || !response.body) {
    const errorBody = await response.text().catch(() => '');
    return { ok: false, status: response.status, text: '', errorBody };
  }

  const reader = response.body.getReader();
  let buffer = new Uint8Array(0);
  let offset = 0;
  let text = '';
  let rangeToReplace: StreamCppLineRange | undefined;
  let endStream: string | undefined;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) {
      const tailLen = buffer.length - offset;
      if (tailLen === 0) {
        buffer = value;
      } else {
        const next = new Uint8Array(tailLen + value.length);
        next.set(buffer.subarray(offset), 0);
        next.set(value, tailLen);
        buffer = next;
      }
      offset = 0;
    }
    for (;;) {
      const frame = readConnectFrame(buffer, offset);
      if (!frame) break;
      offset = frame.nextOffset;
      const payload = isCompressedFrame(frame.flags) ? await decompressGzip(frame.payload) : frame.payload;
      // Connect server-stream ends with a FLAG_END_STREAM (0x02) frame whose
      // payload is the EndStreamResponse JSON ({} on success, {"error":…} on
      // failure) — not a gRPC-web 0x80 trailer.
      if ((frame.flags & FLAG_END_STREAM) !== 0) {
        endStream = TEXT_DECODER.decode(payload);
        continue;
      }
      const decoded = decodeStreamCppResponse(payload);
      if (decoded.text) text += decoded.text;
      if (decoded.rangeToReplace) rangeToReplace = decoded.rangeToReplace;
    }
  }

  // A non-empty error object in the end-stream frame means the stream failed
  // even though the HTTP status was 200.
  const streamError = endStream !== undefined && /"error"\s*:/.test(endStream);
  return {
    ok: !streamError,
    status: response.status,
    text,
    ...(rangeToReplace ? { rangeToReplace } : {}),
    ...(streamError ? { errorBody: endStream } : {}),
  };
};
