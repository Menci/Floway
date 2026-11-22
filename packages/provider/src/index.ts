export type { InternalDebugError } from './error.ts';
export { internalDebugErrorFields, toInternalDebugError } from './error.ts';

export { decodeResponseBody, discardUpstreamResponse } from './result.ts';

export type {
  InternalAliasedFrom,
  InternalModel,
  ProviderModel,
  ProxyFallbackEntry,
  UpstreamModelsCache,
  UpstreamProviderKind,
  UpstreamRecord,
} from './model.ts';
export { ALL_PROVIDER_KINDS, assertUpstreamProviderKind, normalizeUpstreamHue, UPSTREAM_HUE_DEGREES } from './model.ts';
export type { PerformanceOperation, PerformanceTelemetryContext, TelemetryModelIdentity } from './telemetry.ts';
export { parsePerformanceOperation, PERFORMANCE_OPERATIONS } from './telemetry.ts';

export type { AddressableForm, ModelPrefixConfig } from './model-prefix.ts';
export { MODEL_PREFIX_MAX_LENGTH, MODEL_PREFIX_REGEX, normalizeModelPrefix } from './model-prefix.ts';

export type {
  InboundHeaderMatcher,
  Provider,
  ProviderInstance,
  ProviderModule,
} from './provider.ts';
export type {
  AudioTranscriptionPipelineRequest,
  ChatTargetApi,
  HttpOutcome,
  HttpRequestBody,
  ImageEditPartSource,
  ImageEditsPipelineRequest,
  MultipartField,
  OpenAIResponsesAction,
  ProviderModelFacts,
  ProviderPipelineAlphaSearchInput,
  ProviderPipelineAnthropicMessagesCountTokensInput,
  ProviderPipelineAnthropicMessagesInput,
  ProviderPipelineCompactionOutcome,
  ProviderPipelineDecisionInput,
  ProviderPipelineDecisionOutcome,
  ProviderPipelineGeminiGenerateContentCountTokensInput,
  ProviderPipelineGeminiGenerateContentInput,
  ProviderPipelineOpenAIAudioTranscriptionsInput,
  ProviderPipelineOpenAIChatCompletionsInput,
  ProviderPipelineOpenAICompletionsInput,
  ProviderPipelineOpenAIEmbeddingsInput,
  ProviderPipelineOpenAIImagesEditsInput,
  ProviderPipelineOpenAIImagesGenerationsInput,
  ProviderPipelineOpenAIResponsesInput,
  ProviderPipelineRerankInput,
  ProviderPipelineRerankOutcome,
  ProviderPipelineResponsesOutcome,
  ProviderPipelineServices,
  ProviderPipelineStreamOutcome,
  ProviderPipelines,
  ProviderStreamParser,
  RouteCandidate,
  UpstreamHttpRequest,
} from './pipeline.ts';
export {
  SENSITIVE_HTTP_HEADER_NAMES,
  asyncIterableToReadableStream,
  buildAudioTranscriptionMultipartBody,
  buildImagesEditsHttpBody,
  buildImagesEditsJsonPayload,
  buildWireHttpUrl,
  bytesToManagedStream,
  encodeMultipartFormData,
  hasEnabledFlag,
  headersFromEntries,
  httpTerminal,
  isSensitiveHttpHeaderName,
  materializeHeaderLines,
  materializeWireUrl,
  parseUpstreamSseOutcome,
  readManagedBytes,
  syntheticJsonOutcome,
  toProviderModelFacts,
  wrapSensitiveHeaderEntries,
} from './pipeline.ts';
export { headersForAnthropicMessagesCall } from './anthropic-messages.ts';

export { formatUpstreamMetricIdentity, groupUpstreamMetricSamples, quotaPercentDisplay, recordUpstreamMetric, recordUpstreamMetrics, resolveUpstreamMetricDisplaySeries, upstreamMetricAxisPriority } from './upstream-metrics.ts';
export type { GroupedUpstreamMetricSamples, UpstreamMetrics, UpstreamMetricDisplay, UpstreamMetricDisplayOptions, UpstreamMetricDisplaySeries, UpstreamMetricLabelKey, UpstreamMetricObservation, UpstreamMetricSample, UpstreamMetricUnit } from './upstream-metrics.ts';
export { normalizeUpstreamMetricIdentity, upstreamMetricIdentityKey } from './upstream-metric-identity.ts';
export type { UpstreamMetricIdentity, UpstreamMetricLabels, UpstreamMetricLabelValue } from './upstream-metric-identity.ts';
export { runScheduledUsageRefresh } from './scheduled.ts';
export type { ProviderScheduledOptions } from './scheduled.ts';

export type { ProviderRepo, UpstreamsRepoSlim } from './repo.ts';
export { getProviderRepo, initProviderRepo, UpstreamGoneError } from './repo.ts';

export {
  ProviderModelsUnavailableError,
  fetchUpstreamModels,
} from './models-fetch.ts';
export type { ProviderModelsFailureResponse } from './models-fetch.ts';

export type { FlagDefaults, FlagId, FlagOverrides } from './flags.ts';
export {
  OPTIONAL_FLAG_IDS,
  parseFlagOverridesWire,
  resolveEffectiveFlags,
} from './flags.ts';

export type {
  UpstreamModelConfig,
  UpstreamChatModelConfig,
} from './model-config.ts';
export {
  chatField,
  endpointsField,
  isRecord,
  modelsField,
  nonEmptyStringField,
  optionalStringField,
  opaqueBlobCompatibilityScopeField,
  pricingField,
  publicModelId,
} from './model-config.ts';

export type { ValidatePathErr, ValidatePathOk } from './join.ts';
export { joinBaseAndPath, validateUpstreamPath } from './join.ts';

export type { Fetcher, FetchInit, HttpHeaderLines, ReplayableBody, UpstreamFetchOptions } from './options.ts';
export { directFetcher, dispatchUpstreamFetch, identityWrapUpstreamCall, isReplayableBody } from './options.ts';

export { isAbortError } from './abort.ts';

export { frozenJsonRequestBody, jsonRequestBody } from './json-request.ts';
export { sha256Json, sha256JsonHex } from './json-hash.ts';

export {
  base64ToBytes,
  bytesToBase64,
  isBase64ImageDataUrl,
  parseBase64ImageDataUrl,
} from './image-helpers.ts';
