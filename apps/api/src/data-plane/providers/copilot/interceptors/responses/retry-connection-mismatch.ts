import { getRepo } from '../../../../../repo/index.ts';
import type { ResponsesInterceptor } from '../../../../llm/interceptors.ts';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

/**
 * Copilot's `/responses` input items can be connection-bound in two ways:
 *
 * 1. **IDs**: Base64-encoded item IDs are tied to the originating connection.
 *    Upstream error: `input item ID does not belong to this connection`
 *    Fix: replace with stable hash-derived short IDs.
 *
 * 2. **item_reference**: Reference items point to items on the originating
 *    connection by ID. When the connection is gone, the reference dangles.
 *    item_reference IDs share the same cache space as regular item IDs.
 *    Fix: drop the entire item_reference (no inline content to preserve).
 *
 * The gateway caches known-bad identifiers for one hour. On each request it
 * pre-emptively applies cached fixes, avoiding a wasted upstream roundtrip.
 * On a fresh mismatch error it collects all connection-bound identifiers,
 * caches them, applies fixes, and retries exactly once.
 *
 * References:
 * - https://github.com/Menci/Floway/commit/f70e378cc18c3e0523354bfcd64691473a9aa206
 * - https://github.com/san-tian/copilot-pool-gateway/blob/7703408171b8ad0413c746f30e8c19db4bcd781a/handler/proxy.go#L452-L453
 */

const CACHE_TTL_MS = 3600_000;
const SPOTTED_ID_PREFIX = 'spotted_invalid_id:';

type AnyItem = Record<string, unknown>;

const isBase64Id = (id: string): boolean => {
  if (id.length < 20) return false;
  try {
    atob(id);
    return true;
  } catch {
    return false;
  }
};

const sha256Hex16 = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
};

const deriveReplacementId = async (type: string, originalId: string): Promise<string> => {
  // Stable hash-derived IDs keep retries repeatable and preserve cacheability
  // better than generating a new random ID for the same upstream-broken item.
  const hex = await sha256Hex16(originalId);
  const prefix = type === 'reasoning' ? 'rs' : type === 'function_call' ? 'fc' : 'msg';
  return `${prefix}_${hex}`;
};

const cacheSet = (key: string): Promise<void> => getRepo().cache.set(key, '1', CACHE_TTL_MS);

const cacheGet = (key: string): Promise<string | null> => getRepo().cache.get(key);

const getItems = (payload: ResponsesPayload): AnyItem[] => (Array.isArray(payload.input) ? (payload.input as unknown as AnyItem[]) : []);

const isItemReference = (item: AnyItem): boolean => {
  const type = item.type as string | undefined;
  return type === 'item_reference' || (typeof type === 'string' && type.endsWith('_reference'));
};

const isConnectionMismatchError = (body: unknown): boolean => {
  const message = (body as { error?: { message?: unknown } }).error?.message;
  // Upstream has used "input item ID does not belong to this connection",
  // "input item id does not belong to this connection", and
  // "input item does not belong to this connection" at different times.
  // Case-insensitive substring match covers all known variants.
  return typeof message === 'string' && message.toLowerCase().includes('does not belong to this connection');
};

const isConnectionMismatchUpstreamError = (body: Uint8Array): boolean => {
  try {
    return isConnectionMismatchError(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    return false;
  }
};

// Regular items with a spotted ID get the ID replaced with a hash-derived
// short ID. item_reference items with a spotted ID are dropped entirely
// (they have no inline content to preserve). Both share the same cache space.

const fixSpottedIds = async (payload: ResponsesPayload): Promise<boolean> => {
  const items = getItems(payload);
  const withId = items.filter(item => typeof item.id === 'string' && Boolean(item.id));
  if (withId.length === 0) return false;

  const originals = withId.map(item => item.id as string);
  const results = await Promise.all(originals.map(id => cacheGet(`${SPOTTED_ID_PREFIX}${id}`)));

  let changed = false;
  const refreshed: string[] = [];
  const dropIds = new Set<string>();

  for (let i = 0; i < withId.length; i++) {
    if (results[i] === null) continue;

    if (isItemReference(withId[i])) {
      dropIds.add(originals[i]);
    } else {
      withId[i].id = await deriveReplacementId((withId[i].type as string) || 'message', originals[i]);
    }
    changed = true;
    refreshed.push(originals[i]);
  }

  if (dropIds.size > 0) {
    payload.input = items.filter(item => !isItemReference(item) || !dropIds.has(item.id as string)) as unknown as typeof payload.input;
  }

  if (refreshed.length > 0) {
    await Promise.all(refreshed.map(id => cacheSet(`${SPOTTED_ID_PREFIX}${id}`)));
  }
  return changed;
};

const collectBase64Ids = (items: AnyItem[]): string[] =>
  items.flatMap(item => {
    const id = item.id;
    return typeof id === 'string' && isBase64Id(id) ? [id] : [];
  });

const applySpottedFixes = async (payload: ResponsesPayload): Promise<void> => {
  await fixSpottedIds(payload);
};

const collectAndFixAll = async (payload: ResponsesPayload): Promise<boolean> => {
  const items = getItems(payload);

  const base64Ids = collectBase64Ids(items);

  if (base64Ids.length === 0) return false;

  await Promise.all(base64Ids.map(id => cacheSet(`${SPOTTED_ID_PREFIX}${id}`)));

  await applySpottedFixes(payload);
  return true;
};

export const withConnectionMismatchRetried: ResponsesInterceptor = async (ctx, _request, run) => {
  await applySpottedFixes(ctx.payload);

  const first = await run();
  if (first.type !== 'upstream-error' || !isConnectionMismatchUpstreamError(first.body)) {
    return first;
  }

  const fixed = await collectAndFixAll(ctx.payload);
  if (!fixed) return first;

  return await run();
};
