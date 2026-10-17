// Use `export type *` for types: these exports are erased at runtime.
// Export runtime functions, classes, and constants individually by name.
// Never use `export *` here: new source exports would silently expand
// the browser runtime API without an explicit review.

export type * from './common/index.ts';
export type * from './openai-completions/index.ts';
export type * from './openai-chat-completions/index.ts';
export type * from './openai-responses/index.ts';
export type * from './anthropic-messages/index.ts';
export type * from './gemini-generate-content/index.ts';
export type * from './openai-embeddings/index.ts';
export type * from './openai-images/index.ts';
export type * from './openai-audio/index.ts';
export type * from './rerank/index.ts';

export { parseAnthropicBetaHeader } from './anthropic-messages/beta-header.ts';

export {
  ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS,
  ANTHROPIC_MESSAGES_WEB_SEARCH_ERROR_CODES,
} from './anthropic-messages/constants.ts';

export { reassembleAnthropicMessagesEvents } from './anthropic-messages/reassemble.ts';

export { parseAnthropicMessagesStream } from './anthropic-messages/stream.ts';

export {
  ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE,
  collectAnthropicMessagesProtocolEventsToResult,
} from './anthropic-messages/to-result.ts';

export { anthropicMessagesProtocolFrameToSSEFrame } from './anthropic-messages/to-sse.ts';

export {
  createAnthropicMessagesUsage,
  toAnthropicMessagesUsageDelta,
  toAnthropicMessagesUsageDeltaEx,
  mergeAnthropicMessagesUsageSnapshot,
  anthropicMessagesUsageSnapshot,
  splitAnthropicMessagesCacheCreationTokens,
} from './anthropic-messages/usage.ts';

export {
  isFastServiceTier,
  FAST_SERVICE_TIER,
  ALIAS_RULE_BADGE_FIELDS,
  formatAliasRuleBadges,
  formatAliasRulesInline,
  composeAliasDisplayName,
} from './common/aliases.ts';

export {
  normalizeForgivingBase64,
  decodeForgivingBase64,
  decodeForgivingBase64url,
  encodeBase64,
  encodeBase64url,
  encodeHex,
  decodeHex,
  decodeCanonicalBase64,
  decodeCanonicalBase64url,
} from './common/base-encoding.ts';

export { PUBLIC_DATA_PLANE_ROUTES } from './common/data-plane-routes.ts';

export {
  parseDecimalString,
  parseNonNegativeDecimalString,
  addDecimalStrings,
  multiplyDecimalStrings,
  divideDecimalString,
  decimalStringIsZero,
  decimalStringToNumber,
} from './common/decimal.ts';

export { MODEL_KINDS, parseModelKind, kindForEndpoints } from './common/endpoints.ts';

export { isJsonObject, jsonInteger } from './common/json.ts';

export {
  parseMediaType,
  mediaTypeEssence,
  isJsonMediaType,
  isXmlMediaType,
  isTextualMediaType,
  isEventStreamMediaType,
  isImageMediaType,
  isMultipartFormDataMediaType,
} from './common/media-type.ts';

export { RERANK_PROTOCOLS, materializeOpaqueBlobCompatibilityIdentity } from './common/models.ts';

export {
  MAX_OPAQUE_TRAILER_BYTES,
  concatBytes,
  uint16be,
  decodeOpaqueValue,
  encodeOpaqueValue,
  appendOpaqueTrailer,
  splitOpaqueTrailer,
} from './common/opaque-value.ts';

export { isOpenAIUsageOnlyEventShape } from './common/openai-stream.ts';

export { parseTargetStreamFrames } from './common/parse-events.ts';

export { parseSSEStream } from './common/parse-sse.ts';

export {
  BILLING_METRICS,
  parseBillingMetric,
  PRICING_AXES,
  validatePriceVector,
  canonicalizePricingSelector,
  canonicalPricingSelectorKey,
  parsePricingSelectorKey,
  collectModelPricingIssues,
  validateModelPricing,
  pricingEntry,
  modelPricing,
  basePricing,
  perMillionTokenRates,
  tokenPricingEntry,
  tokenBasePricing,
  priceRequest,
} from './common/pricing.ts';

export { captureExtras } from './common/reassemble-extras.ts';

export { sseFrame, sseCommentFrame, eventFrame, doneFrame } from './common/sse.ts';

export { createTelemetryBucket, isTelemetryHourlyBucket, TELEMETRY_HOUR_MS, telemetryDayOrdinal, telemetryHourBucketSizes, telemetryHourKey } from './common/telemetry-time.ts';

export {
  usageUpstreamDimensionPrefix,
  usageWithoutUpstreamDimensionValue,
  tokenUsageUnattributedUserId,
  usageUpstreamDimensionValue,
  usageUpstreamFromDimensionValue,
  sumBillableUsage,
  billableServiceTier,
  splitCacheWriteTokens,
  splitInclusiveInputTokens,
  splitInclusiveOutputTokens,
} from './common/usage.ts';

export {
  GEMINI_GENERATE_CONTENT_CANDIDATE_KEYS,
  GEMINI_GENERATE_CONTENT_RESULT_KEYS,
} from './gemini-generate-content/field-keys.ts';

export { reassembleGeminiGenerateContentEvents } from './gemini-generate-content/reassemble.ts';

export {
  GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE,
  isGeminiGenerateContentErrorEvent,
  isGeminiGenerateContentTerminalEvent,
  collectGeminiGenerateContentProtocolEventsToResult,
} from './gemini-generate-content/to-result.ts';

export { geminiGenerateContentProtocolFrameToSSEFrame } from './gemini-generate-content/to-sse.ts';

export { isOpenAIAudioTranscriptionDoneEvent } from './openai-audio/index.ts';

export { openaiChatCompletionsErrorPayloadMessage } from './openai-chat-completions/errors.ts';

export { reassembleOpenAIChatCompletionsEvents } from './openai-chat-completions/reassemble.ts';

export { parseOpenAIChatCompletionsStream } from './openai-chat-completions/stream.ts';

export { collectOpenAIChatCompletionsProtocolEventsToResult } from './openai-chat-completions/to-result.ts';

export { openaiChatCompletionsProtocolFrameToSSEFrame } from './openai-chat-completions/to-sse.ts';

export { reassembleOpenAICompletionsEvents } from './openai-completions/reassemble.ts';

export { openaiCompletionsProtocolFrameToSSEFrame } from './openai-completions/to-sse.ts';

export { isOpenAIResponsesCompactionItem, toCompactPayloadShape } from './openai-responses/compact.ts';

export { reassembleOpenAIResponsesEvents } from './openai-responses/reassemble.ts';

export {
  isOpenAIResponsesTerminalEvent,
  openaiResponsesResultFromStreamEvent,
} from './openai-responses/terminal-event.ts';

export {
  OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE,
  collectOpenAIResponsesProtocolEventsToResult,
} from './openai-responses/to-result.ts';

export { openaiResponsesProtocolFrameToSSEFrame } from './openai-responses/to-sse.ts';

export {
  WEB_SEARCH_HOSTED_TYPE_NAMES,
  collectOpenAIResponsesToolEntries,
  collectOpenAIResponsesTools,
  mapOpenAIResponsesTools,
} from './openai-responses/tools.ts';

export { DEFAULT_RERANK_PATHS } from './rerank/default-paths.ts';

export {
  parseRerankRequest,
  parseRerankResponse,
  parseRerankUsage,
  rerankRequestIncompatibility,
  renderRerankResponse,
  serializeRerankRequest,
} from './rerank/translate.ts';
