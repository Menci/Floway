import type { MessagesRefusalStopDetails } from '@floway-dev/protocols/messages';
import type { ResponsesResult } from '@floway-dev/protocols/responses';

const CODEX_BIO_POLICY_PREFIX = 'This content was flagged for possible biological risk.';

export const messagesRefusalExplanation = (details: MessagesRefusalStopDetails | null | undefined): string => {
  if (details?.explanation !== null && details?.explanation !== undefined) return details.explanation;

  const category = details?.category === null || details?.category === undefined
    ? 'an unspecified policy category'
    : `the ${details.category} policy category`;
  return `Anthropic refused this request under ${category}.`;
};

export const messagesRefusalResponsesError = (
  details: MessagesRefusalStopDetails | null | undefined,
): NonNullable<ResponsesResult['error']> => {
  const explanation = messagesRefusalExplanation(details);

  // `bio_policy` and `invalid_prompt` are public Responses failure codes;
  // `cyber_policy` is the first-party Codex backend extension that selects
  // its dedicated cyber safety UI. Unknown codes are retryable in Codex, so
  // all other current and future Anthropic categories deliberately converge
  // on the non-retryable `invalid_prompt` carrier while the explanation keeps
  // their upstream reason visible.
  // https://github.com/openai/openai-node/blob/32ed4b595ee2e21ab2e2eed7e382cd10d72eb059/src/resources/responses/responses.ts#L2745-L2778
  // https://github.com/openai/codex/blob/e8f0f64f2057740ca18d66dbeebe077156d7a2a9/codex-rs/codex-api/src/sse/responses.rs#L387-L421
  switch (details?.category) {
  case 'cyber':
    return { code: 'cyber_policy', message: explanation };
  case 'bio':
    // Codex recognizes this exact first-party prefix as the biology safety
    // surface and shows its dedicated Trusted Access notice. Keep Anthropic's
    // explanation after the stable discriminator so the upstream reason stays
    // visible without misclassifying it as cyber.
    // https://github.com/openai/codex/blob/e8f0f64f2057740ca18d66dbeebe077156d7a2a9/codex-rs/tui/src/chatwidget/turn_runtime.rs#L8-L16
    return {
      code: 'bio_policy',
      message: details.explanation ? `${CODEX_BIO_POLICY_PREFIX} ${details.explanation}` : CODEX_BIO_POLICY_PREFIX,
    };
  default:
    return { code: 'invalid_prompt', message: explanation };
  }
};
