export type {
  ChatCompletionsInvocation,
  GeminiInvocation,
  ChatTargetApi,
  MessagesInvocation,
  ProviderCandidate,
  ResponsesInvocation,
} from './invocation.ts';

export type { InternalDebugError } from './error.ts';
export { toInternalDebugError } from './error.ts';

export type {
  ApiErrorResult,
  EventResult,
  EventResultMetadata,
  ExecuteResult,
  InternalErrorResult,
  PlainResult,
} from './result.ts';
export {
  apiErrorToResponse,
  decodeApiErrorBody,
  eventResult,
  internalErrorResult,
  plainResult,
  readUpstreamApiError,
} from './result.ts';

export type {
  InternalModel,
  PerformanceTelemetryContext,
  ProxyFallbackEntry,
  TelemetryModelIdentity,
  UpstreamModel,
  UpstreamProviderKind,
  UpstreamRecord,
} from './model.ts';
export { ALL_PROVIDER_KINDS } from './model.ts';

export type { AddressableForm, ModelPrefixConfig } from './model-prefix.ts';
export { MODEL_PREFIX_MAX_LENGTH, MODEL_PREFIX_REGEX, normalizeModelPrefix } from './model-prefix.ts';

export type {
  ModelProvider,
  ModelProviderInstance,
  ProviderCallResult,
  ProviderResponsesResult,
  ProviderStreamResult,
  ResponsesAction,
  UpstreamCallOptions,
} from './provider.ts';
export type { ProviderStreamParser } from './streaming.ts';
export { streamingProviderCall } from './streaming.ts';

export type { ProviderRepo, UpstreamsRepoSlim } from './repo.ts';
export { getProviderRepo, initProviderRepo } from './repo.ts';

export {
  ProviderModelsUnavailableError,
  fetchUpstreamModels,
  httpResponseToResponse,
} from './models-fetch.ts';

export type { Flag, FlagOverrides, OptionalFlagId } from './flags.ts';
export {
  OPTIONAL_FLAGS,
  defaultsForProvider,
  getFlagCatalog,
  isKnownFlagId,
  parseFlagOverridesWire,
  resolveEffectiveFlags,
} from './flags.ts';

export type {
  UpstreamModelConfig,
  UpstreamModelFlagOverrides,
  UpstreamModelLimits,
  Modality,
  UpstreamChatModelConfig,
} from './model-config.ts';
export {
  chatField,
  endpointsField,
  flagOverridesField,
  isRecord,
  limitsField,
  modelsField,
  nonEmptyStringField,
  optionalStringField,
  pricingField,
  publicModelId,
} from './model-config.ts';

export type { ValidatePathErr, ValidatePathOk } from './join.ts';
export { joinBaseAndPath, validateUpstreamPath } from './join.ts';

export type { Fetcher, UpstreamFetchOptions } from './options.ts';
export { directFetcher } from './options.ts';

export { isAbortError } from './abort.ts';

export {
  isBase64ImageDataUrl,
  memoizedBase64Compressor,
  memoizedDataUrlCompressor,
} from './image-helpers.ts';

export { COMPACTION_TRIGGER, compactionResponse } from './compaction.ts';
