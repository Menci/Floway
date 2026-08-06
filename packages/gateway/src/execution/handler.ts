import { executeModelsRefresh, type ModelsRefreshExecutionInput } from './models-refresh.ts';

export const handleExecutionRequest = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname !== '/models/refresh' || request.method !== 'POST') {
    return new Response('Execution operation not found', { status: 404 });
  }
  const input = parseModelsRefreshInput(await request.json());
  await executeModelsRefresh(input);
  return new Response(null, { status: 204 });
};

const parseModelsRefreshInput = (value: unknown): ModelsRefreshExecutionInput => {
  if (typeof value !== 'object' || value === null) throw new TypeError('Models refresh execution input must be an object');
  const input = value as Record<string, unknown>;
  if (typeof input.upstreamId !== 'string' || input.upstreamId === '') throw new TypeError('Models refresh upstreamId must be a non-empty string');
  if (!Number.isSafeInteger(input.configVersion) || (input.configVersion as number) < 1) throw new TypeError('Models refresh configVersion must be a positive integer');
  if (input.cacheEpoch !== null && (!Number.isSafeInteger(input.cacheEpoch) || (input.cacheEpoch as number) < 0)) throw new TypeError('Models refresh cacheEpoch must be a non-negative integer or null');
  if (input.runtimeLocation !== null && typeof input.runtimeLocation !== 'string') throw new TypeError('Models refresh runtimeLocation must be a string or null');
  return {
    upstreamId: input.upstreamId,
    configVersion: input.configVersion as number,
    cacheEpoch: input.cacheEpoch as number | null,
    runtimeLocation: input.runtimeLocation as string | null,
  };
};
