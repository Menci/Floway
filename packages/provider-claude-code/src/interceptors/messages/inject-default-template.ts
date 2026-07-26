import { DEFAULT_TEMPLATE_BLOCK } from './system-blocks.ts';
import type { MessagesBoundaryCtx } from './types.ts';
import type { MessagesPayload } from '@floway-dev/protocols/messages';

// Anthropic's prompt-caching API rejects requests that carry more than four
// `cache_control` markers; the docs state "the API enforces a maximum of 4
// cache points per request" and the budget is shared across system blocks,
// tools, and message content blocks. Reference:
// https://platform.claude.com/docs/en/build-with-claude/prompt-caching
// sub2api's `gateway_service.go:71` ports the same constant
// (`maxCacheControlBlocks = 4`) and enforces it in `enforceCacheControlLimit`
// at line 4581.
const ANTHROPIC_CACHE_BREAKPOINT_CAP = 4;

// Counts `cache_control` markers the caller has already placed across tools,
// the `system` array (when in block form), and each message's content blocks.
// Mirrors sub2api's `collectCacheControlPaths`. The billing and identity
// blocks injected earlier in this chain carry no `cache_control`, so they
// never contribute here.
const countCacheBreakpoints = (payload: MessagesPayload): number => {
  let count = 0;

  if (payload.tools) {
    for (const tool of payload.tools) {
      if ('cache_control' in tool && tool.cache_control) count++;
    }
  }

  if (Array.isArray(payload.system)) {
    for (const block of payload.system) {
      if (block.cache_control) count++;
    }
  }

  for (const message of payload.messages) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      if ('cache_control' in block && block.cache_control) count++;
    }
  }

  return count;
};

// Appends the cached default-template block at system[2]. The block normally
// carries `cache_control: { type: 'ephemeral', ttl: '5m' }` so Anthropic's
// prompt cache keys on the (billing, identity, template) triplet up to here;
// the billing block intentionally sits BEFORE this cache breakpoint so its
// per-request fingerprint never invalidates the cached prefix.
//
// When the caller's payload is already at or near the four-breakpoint cap,
// adding our breakpoint would push the request over the limit and Anthropic
// rejects with HTTP 400. In that case we still inject the template text
// (real CC's shape relies on three system blocks) but demote it to an
// un-cached block. The caller's own breakpoints stay where they are — if
// the caller already exceeds the cap, that overage is theirs to fix.
//
// Chain order in ./index.ts guarantees `system` is already a fresh array
// when this runs.
export const injectDefaultTemplate = async <TResult>(
  ctx: MessagesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  if (!Array.isArray(ctx.payload.system)) {
    throw new Error('inject-default-template: expected system to be an array (inject-billing-block must run first)');
  }
  const system = ctx.payload.system;
  const callerBreakpoints = countCacheBreakpoints(ctx.payload);
  const wouldOverflowBreakpointCap = callerBreakpoints >= ANTHROPIC_CACHE_BREAKPOINT_CAP;
  const templateBlock = wouldOverflowBreakpointCap
    ? { type: 'text' as const, text: DEFAULT_TEMPLATE_BLOCK.text }
    : DEFAULT_TEMPLATE_BLOCK;
  ctx.payload = { ...ctx.payload, system: [...system, templateBlock] };
  return await run();
};
