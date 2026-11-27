import type { Context } from 'hono';

// Inbound body bytes the handler reads once and forwards into the dump
// accumulator (so the handler's payload parser AND the dump see the same
// bytes without a second read). `streamError` surfaces a client mid-upload
// abort as a non-null message; the dump records it as `meta.error`.
export interface RequestBody {
  readonly bytes: Uint8Array;
  readonly streamError: string | null;
}

// The pipeline and Dump share one read of the inbound bytes. An interrupted
// upload leaves empty bytes and a stream error message for Dump metadata.
export const readRequestBody = async (c: Context): Promise<RequestBody> => {
  if (c.req.raw.body === null) return { bytes: new Uint8Array(), streamError: null };
  try {
    return { bytes: new Uint8Array(await c.req.raw.arrayBuffer()), streamError: null };
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
    return { bytes: new Uint8Array(), streamError: msg.length > 500 ? `${msg.slice(0, 497)}…` : msg };
  }
};
