import type { MessagesRedactedThinkingBlock, MessagesThinkingBlock } from '@floway-dev/protocols/messages';
import { createRandomResponsesItemId, type ResponsesInputReasoning, type ResponsesReasoningItem } from '@floway-dev/protocols/responses';

export type MessagesReasoningBlock = MessagesThinkingBlock | MessagesRedactedThinkingBlock;

/**
 * Pack a Responses reasoning item's `id` and `encrypted_content` into an
 * Anthropic `thinking.signature` / `redacted_thinking.data` string using
 * `${encrypted_content}@${id}`.
 *
 * Why: an OpenAI Responses upstream signs `encrypted_content` against
 * `(account, item_id)` and rejects a next-turn submission whose `id` does not
 * match the id baked into the blob with `400 invalid_request_body: "Encrypted
 * content item_id did not match the target item id."`. Anthropic `thinking` /
 * `redacted_thinking` blocks have no id slot, so when we project a Responses
 * reasoning item into a Messages carrier for a downstream Messages CLIENT we
 * must smuggle the original Responses id alongside the blob, then recover it
 * when that client echoes the carrier back. We adopt the `${encrypted_content}@${id}`
 * layout used by the gateway implementations referenced below, so signatures
 * stay interchangeable if a user switches gateways mid-session.
 *
 * `encryptedContent` may be empty: a Responses-origin reasoning item can have
 * an id but no opaque content (we never auto-request
 * `reasoning.encrypted_content`), in which case `@rs_abc` is a valid,
 * round-trippable carrier.
 *
 * Scope: this packing is the bridge contract between the gateway and a
 * Messages CLIENT only. Toward a real Messages UPSTREAM we send the genuine
 * `encrypted_content` with no packing, and a genuine upstream signature is
 * never overwritten — see {@link unpackReasoningSignature}.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/79b9f491aad13259cb27e8a82faf690474b159a4/src/routes/messages/responses-translation.ts#L427-L440
 * - https://github.com/caozhiyuan/copilot-api/blob/79b9f491aad13259cb27e8a82faf690474b159a4/src/routes/messages/responses-translation.ts#L565
 * - https://github.com/caozhiyuan/copilot-api/blob/79b9f491aad13259cb27e8a82faf690474b159a4/src/routes/messages/responses-stream-translation.ts#L237
 * - https://github.com/caozhiyuan/copilot-api/issues/63
 * - https://github.com/caozhiyuan/copilot-api/issues/73
 */
export const packReasoningSignature = (id: string, encryptedContent: string): string => `${encryptedContent}@${id}`;

/**
 * Inverse of {@link packReasoningSignature}. Splits on the LAST `@`:
 *
 * - `enc@rs_1` → `{ id: 'rs_1', encryptedContent: 'enc' }`.
 * - `@rs_1` → `{ id: 'rs_1', encryptedContent: '' }` — empty front half is a
 *   valid packing (a Responses reasoning with an id but no opaque content).
 * - `opaque-sig` (no `@`) → `{ id: null, encryptedContent: 'opaque-sig' }` —
 *   a genuine upstream signature (native Anthropic encrypted reasoning, or a
 *   base64 blob that contains no `@`). It is preserved verbatim and the caller
 *   synthesizes a fresh reasoning id; we NEVER overwrite the signature.
 * - `enc@` (trailing `@`, empty id) → treated as a native signature.
 *
 * Splitting on the LAST `@` is safe because genuine upstream signatures are
 * base64/base64url (Anthropic, OpenAI), whose alphabet excludes `@`; only our
 * packing injects one, so the final `@` is always our delimiter.
 */
export const unpackReasoningSignature = (signature: string): { id: string | null; encryptedContent: string } => {
  const splitIndex = signature.lastIndexOf('@');
  if (splitIndex === -1 || splitIndex === signature.length - 1) {
    return { id: null, encryptedContent: signature };
  }
  return { id: signature.slice(splitIndex + 1), encryptedContent: signature.slice(0, splitIndex) };
};

/**
 * Project a Messages reasoning carrier echoed by a downstream Messages CLIENT
 * into a Responses reasoning item bound for the Responses UPSTREAM. Unpacks the
 * carrier so the upstream sees the original id and a clean `encrypted_content`
 * blob. A fresh random id is used when the carrier holds a genuine (unpacked)
 * upstream signature.
 */
export const messagesReasoningBlockToResponsesReasoning = (block: MessagesReasoningBlock): ResponsesInputReasoning => {
  const carrier = block.type === 'thinking' ? block.signature : block.data;
  const { id, encryptedContent } = carrier !== undefined ? unpackReasoningSignature(carrier) : { id: null, encryptedContent: undefined };
  const summary = block.type === 'thinking' && block.thinking ? [{ type: 'summary_text' as const, text: block.thinking }] : [];

  return {
    type: 'reasoning',
    id: id ?? createRandomResponsesItemId('reasoning'),
    summary,
    ...(encryptedContent !== undefined ? { encrypted_content: encryptedContent } : {}),
  };
};

/**
 * Project a Responses reasoning item into a Messages reasoning carrier bound
 * for a downstream Messages CLIENT. The id and opaque content are packed into
 * the carrier so they survive the round trip. Placement follows readable text:
 * readable summary text → `thinking` with the packed value in `signature`; no
 * readable text → `redacted_thinking` with the packed value in `data` (Copilot
 * rejects `thinking: null` / empty `thinking`).
 */
export const responsesReasoningToMessagesBlock = (item: ResponsesReasoningItem): MessagesReasoningBlock => {
  const thinking = item.summary?.length
    ? item.summary
        .map(part => part.text)
        .join('')
        .trim()
    : '';
  const packed = packReasoningSignature(item.id, item.encrypted_content ?? '');

  return thinking ? { type: 'thinking', thinking, signature: packed } : { type: 'redacted_thinking', data: packed };
};

/**
 * Project a Responses reasoning item into a Messages reasoning carrier bound
 * for a real Messages UPSTREAM. Unlike {@link responsesReasoningToMessagesBlock}
 * this sends the GENUINE signature only — the upstream owns and validates that
 * field, so we never wrap it in a gateway envelope. The opaque
 * `encrypted_content` rides verbatim: as `thinking.signature` when there is
 * readable text, else as `redacted_thinking.data`.
 *
 * No-opaque sub-case: a Responses-origin reasoning with an id but no
 * `encrypted_content` (we never auto-request it) has nothing the upstream can
 * verify. We stay honest — emit readable `thinking` with no signature when
 * there is text, and drop the item entirely when there is neither text nor an
 * opaque blob — rather than fabricating a signature the upstream would reject.
 */
export const responsesReasoningToMessagesUpstreamBlock = (item: ResponsesReasoningItem): MessagesReasoningBlock | null => {
  const thinking = item.summary?.length
    ? item.summary
        .map(part => part.text)
        .join('')
        .trim()
    : '';

  if (!thinking) {
    return item.encrypted_content ? { type: 'redacted_thinking', data: item.encrypted_content } : null;
  }

  return { type: 'thinking', thinking, ...(item.encrypted_content ? { signature: item.encrypted_content } : {}) };
};
