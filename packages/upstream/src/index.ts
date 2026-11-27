export type { InternalDebugError } from './error.ts';
export { internalDebugErrorFields, protocolErrorDebugFields, toInternalDebugError } from './error.ts';

export { discardUpstreamResponse } from './discard-response.ts';

export type {
  InternalAliasedFrom,
  InternalModel,
  UpstreamModel,
  ProxyFallbackEntry,
  UpstreamModelSource,
  UpstreamKind,
  UpstreamRecord,
} from './model.ts';
export { ALL_UPSTREAM_KINDS, assertUpstreamKind, normalizeUpstreamHue, UPSTREAM_HUE_DEGREES } from './model.ts';
export type { PerformanceOperation, PerformanceTelemetryContext, TelemetryModelIdentity } from './telemetry.ts';
export { parsePerformanceOperation, PERFORMANCE_OPERATIONS } from './telemetry.ts';

export type { AddressableForm, ModelPrefixConfig } from './model-prefix.ts';
export { MODEL_PREFIX_MAX_LENGTH, MODEL_PREFIX_REGEX, normalizeModelPrefix } from './model-prefix.ts';

export type { UpstreamModule } from './module.ts';
export type { OpenAIImagesEditsRequest, OpenAIImagesEditsSource } from './images.ts';
export { serializeOpenAIImagesEditsBody, serializeOpenAIImagesEditsJsonPayload, serializeOpenAIImagesEditsRequest } from './images.ts';
export type { OpenAIAudioTranscriptionFormEntry, OpenAIAudioTranscriptionRequest } from './audio.ts';
export { serializeModelFieldOpenAIAudioTranscriptionRequest, serializeModelPathOpenAIAudioTranscriptionRequest, serializeOpenAIAudioTranscriptionsBody } from './audio.ts';

export { httpTerminal } from './http-terminal.ts';
export type { UpstreamHttpResponseFacts, UpstreamHttpServices } from './http-terminal.ts';
export { httpDialError, parseJsonBody, parseUpstreamResult, parseUpstreamStream } from './parse-response.ts';
export type { FormatProtocolError, ProtocolStreamDecoder } from './parse-response.ts';
export { toUpstreamModelSnapshot, toUpstreamSnapshot } from './pipeline-facts.ts';
export type {
  ChatTargetApi,
  ProtocolError,
  ProtocolOutcome,
  ProtocolResult,
  ProtocolStream,
  ProtocolStreamError,
  UpstreamEvent,
  UpstreamModelSnapshot,
  UpstreamOperation,
  UpstreamOutcome,
  UpstreamPipeline,
  UpstreamRequest,
  UpstreamRequestFacts,
  UpstreamResponse,
  UpstreamResponseFacts,
  UpstreamResult,
  UpstreamSnapshot,
} from './pipeline-facts.ts';

export { formatUpstreamMetricIdentity, groupUpstreamMetricSamples, quotaPercentDisplay, recordUpstreamMetric, recordUpstreamMetrics, resolveUpstreamMetricDisplaySeries, upstreamMetricAxisPriority } from './upstream-metrics.ts';
export type { GroupedUpstreamMetricSamples, UpstreamMetrics, UpstreamMetricDisplay, UpstreamMetricDisplayOptions, UpstreamMetricDisplaySeries, UpstreamMetricLabelKey, UpstreamMetricObservation, UpstreamMetricSample, UpstreamMetricUnit } from './upstream-metrics.ts';
export { normalizeUpstreamMetricIdentity, upstreamMetricIdentityKey } from './upstream-metric-identity.ts';
export type { UpstreamMetricIdentity, UpstreamMetricLabels, UpstreamMetricLabelValue } from './upstream-metric-identity.ts';
export { runScheduledUsageRefresh } from './scheduled.ts';
export type { UpstreamScheduledOptions } from './scheduled.ts';

export type { UpstreamRuntimeRepo, UpstreamsRepoSlim } from './repo.ts';
export { getUpstreamRuntimeRepo, initUpstreamRuntimeRepo, UpstreamGoneError } from './repo.ts';

export {
  UpstreamModelsUnavailableError,
  fetchUpstreamModels,
} from './models-fetch.ts';
export type { UpstreamModelsFailureResponse } from './models-fetch.ts';

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

export type { Fetcher, FetchInit, HttpHeaderLines, ReplayableBody } from './options.ts';
export { directFetcher, isReplayableBody, toRequestInit } from './options.ts';

export { isAbortError } from './abort.ts';

export { jsonRequestBody } from './json-request.ts';
export { sha256Json, sha256JsonHex } from './json-hash.ts';

export {
  base64ToBytes,
  bytesToBase64,
  isBase64ImageDataUrl,
  parseBase64ImageDataUrl,
} from './image-helpers.ts';
