import type { ResponsesBoundaryCtx } from './types.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';

export const sanitizeMessageIds = async <TResult>(
  ctx: ResponsesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  if (!Array.isArray(ctx.payload.input)) return await run();

  const input = sanitizeInputItems(ctx.payload.input);
  if (input !== ctx.payload.input) ctx.payload = { ...ctx.payload, input };
  return await run();
};

const sanitizeInputItems = (items: ResponsesInputItem[]): ResponsesInputItem[] => {
  let changed = false;
  const sanitized = items.map(item => {
    if (!isMessageInputItem(item)) return item;
    const id = (item as { id?: unknown }).id;
    if (id === undefined || (typeof id === 'string' && id.startsWith('msg'))) return item;

    const next: Record<string, unknown> = { ...item };
    delete next.id;
    changed = true;
    return next as unknown as ResponsesInputItem;
  });
  return changed ? sanitized : items;
};

const isMessageInputItem = (item: ResponsesInputItem): boolean => {
  const obj = item as { type?: unknown; role?: unknown };
  return obj.type === undefined ? isMessageRole(obj.role) : obj.type === 'message';
};

const isMessageRole = (role: unknown): boolean =>
  role === 'user' || role === 'assistant' || role === 'system' || role === 'developer';
