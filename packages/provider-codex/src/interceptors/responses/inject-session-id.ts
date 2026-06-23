import type { ResponsesBoundaryCtx } from './types.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';

// Codex backend's prompt cache keys on the `session-id` header. Empirically:
// with a stable `session-id` repeated across turns of the same conversation,
// ~88% of input tokens hit the cache (e.g. 1792/2031 on a 2k-token prompt).
// Without it, cache hits are sporadic at best.
//
// Strategy: derive a stable id from `(instructions + first user-message text)`
// so the same conversation prefix produces the same session-id across turns,
// regardless of what tail tokens the client appends. Different conversations
// (different system prompt or different opening user message) get different
// ids and don't poison each other's cache.
//
// Honor a client-supplied `session-id` verbatim. A downstream `session_id` is
// accepted only as a compatibility alias when the canonical header is absent;
// upstream still receives only `session-id`.

export const injectSessionId = async <TResult>(
  ctx: ResponsesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const suppliedSessionId = trimHeader(ctx.headers, 'session-id') ?? trimHeader(ctx.headers, 'session_id');
  if (suppliedSessionId) {
    ctx.headers.set('session-id', suppliedSessionId);
    ctx.headers.delete('session_id');
    return await run();
  }

  const instructions = typeof ctx.payload.instructions === 'string' ? ctx.payload.instructions : '';
  const firstUser = firstUserMessageText(ctx.payload.input);
  // U+0001 separates the two seed components so an empty instructions can't
  // collide with an empty first-user-message via prefix concatenation.
  ctx.headers.set('session-id', await sha256Uuid(`${instructions}${firstUser}`));
  return await run();
};

const trimHeader = (headers: Headers, name: string): string | null => {
  const value = headers.get(name)?.trim();
  return value || null;
};

const firstUserMessageText = (input: unknown): string => {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  for (const item of input) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as { type?: unknown; role?: unknown; content?: unknown };
    // Allow implicit `type: "message"` (OpenAI accepts {role, content} bare).
    if (obj.type !== undefined && obj.type !== 'message') continue;
    if (obj.role !== 'user') continue;
    return extractMessageText(item as ResponsesInputItem);
  }
  return '';
};

const extractMessageText = (item: ResponsesInputItem): string => {
  const content = (item as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (typeof part !== 'object' || part === null) return '';
      const p = part as { type?: unknown; text?: unknown };
      if (p.type === 'input_text' && typeof p.text === 'string') return p.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
};

// Format the SHA-256 hex digest as a real UUIDv4 string by stamping the version
// (4) and variant (8/9/a/b) nibbles. The upstream doesn't validate the shape
// but observability tools that do will accept the result.
const sha256Uuid = async (input: string): Promise<string> => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const hex = Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  const variantNibble = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variantNibble}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
