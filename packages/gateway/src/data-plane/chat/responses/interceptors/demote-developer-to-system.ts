// Demote `developer` role to `system` in Responses input items for
// upstreams that don't recognise the `developer` role (e.g. DeepSeek).
// Always-attached; flag-gated by `demote-developer-to-system`. Runs before
// vendor normalizers so the role-mapped items feed into any later vendor
// dialect rewrites.
//
// Outbound (request → upstream):
//
// - Every `ResponsesInputMessage` with `role: 'developer'` is rewritten to
//   `role: 'system'`. String input and non-message items are passed through
//   unchanged.
//
// Inbound: nothing — responses don't carry message roles.

import type { ResponsesInterceptor } from './types.ts';
import type { ResponsesInputItem, ResponsesInputMessage } from '@floway-dev/protocols/responses';

const isInputMessage = (item: ResponsesInputItem): item is ResponsesInputMessage =>
  item.type === 'message';

const downgradeRole = (item: ResponsesInputItem): ResponsesInputItem => {
  if (!isInputMessage(item) || item.role !== 'developer') return item;
  return { ...item, role: 'system' as const };
};

export const withDemoteDeveloperToSystem: ResponsesInterceptor = async (ctx, _request, run) => {
  if (!ctx.candidate.model.enabledFlags.has('demote-developer-to-system')) return await run();

  if (Array.isArray(ctx.payload.input)) {
    ctx.payload = {
      ...ctx.payload,
      input: ctx.payload.input.map(downgradeRole),
    };
  }

  return await run();
};
