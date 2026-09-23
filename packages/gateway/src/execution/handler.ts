import { encodeModelsRefreshResult, executeModelsRefresh, isModelsRefreshConfigurationError, modelsRefreshErrorMessage, type ModelsRefreshExecutionInput } from './models-refresh.ts';
import { ProviderModelsUnavailableError, type UpstreamRecord } from '@floway-dev/provider';

export const handleExecutionRequest = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname !== '/models/refresh' || request.method !== 'POST') {
    return new Response('Execution operation not found', { status: 404 });
  }
  const input = parseModelsRefreshInput(await request.json());
  try {
    return Response.json(encodeModelsRefreshResult(await executeModelsRefresh(input)));
  } catch (error) {
    if (isModelsRefreshConfigurationError(error)) {
      return Response.json({ kind: 'invalid-configuration', message: error.message }, { status: 400 });
    }
    if (!(error instanceof ProviderModelsUnavailableError)) throw error;
    return Response.json({ kind: 'provider-unavailable', message: modelsRefreshErrorMessage(error), upstreamResponse: error.displayResponse }, { status: 502 });
  }
};

const parseModelsRefreshInput = (value: unknown): ModelsRefreshExecutionInput => {
  if (typeof value !== 'object' || value === null) throw new TypeError('Models refresh execution input must be an object');
  const input = value as Record<string, unknown>;
  if (input.runtimeLocation !== null && typeof input.runtimeLocation !== 'string') throw new TypeError('Models refresh runtimeLocation must be a string or null');
  if (input.kind === 'draft') {
    if (typeof input.nonce !== 'string' || input.nonce === '') throw new TypeError('Draft discovery nonce must be non-empty');
    if (typeof input.record !== 'object' || input.record === null) throw new TypeError('Draft discovery record must be an object');
    return { kind: 'draft', record: input.record as UpstreamRecord, nonce: input.nonce, runtimeLocation: input.runtimeLocation as string | null };
  }
  if (input.kind !== 'saved') throw new TypeError('Models refresh kind must be saved or draft');
  if (typeof input.upstreamId !== 'string' || input.upstreamId === '') throw new TypeError('Models refresh upstreamId must be a non-empty string');
  if (!Number.isSafeInteger(input.configVersion) || (input.configVersion as number) < 1) throw new TypeError('Models refresh configVersion must be a positive integer');
  if (typeof input.inputHash !== 'string' || input.inputHash === '') throw new TypeError('Models refresh inputHash must be non-empty');
  if (input.mode !== 'automatic' && input.mode !== 'explicit') throw new TypeError('Models refresh mode must be automatic or explicit');
  return {
    kind: 'saved',
    upstreamId: input.upstreamId,
    configVersion: input.configVersion as number,
    inputHash: input.inputHash,
    runtimeLocation: input.runtimeLocation as string | null,
    mode: input.mode,
  };
};
