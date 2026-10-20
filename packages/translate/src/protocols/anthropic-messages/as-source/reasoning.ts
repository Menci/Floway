/**
 * Pack a reasoning item's `id` and opaque content into the Messages signature
 * carrier used for a later Responses round trip.
 *
 * https://github.com/caozhiyuan/copilot-api/blob/79b9f491aad13259cb27e8a82faf690474b159a4/src/routes/messages/responses-translation.ts#L427-L440
 * https://github.com/caozhiyuan/copilot-api/blob/79b9f491aad13259cb27e8a82faf690474b159a4/src/routes/messages/responses-stream-translation.ts#L237
 */
export const packReasoningSignature = (id: string, encryptedContent: string): string => `${encryptedContent}@${id}`;
