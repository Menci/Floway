import { isDecodedSecret, isDecodedStreamRef } from './dump-decoder.ts';
import type { DecodedStageNode, DecodedStreamFrame, DumpViewModel } from './dump-decoder.ts';
import { SECRET_BRAND } from './types.ts';
import type { WireHttpUrl } from './types.ts';

export interface ProjectedWireFrame {
  readonly index: number;
  readonly seq: number;
  readonly tMs: number;
  readonly deltaMs: number;
  readonly value: unknown;
}

export interface ProjectedWireRequest {
  readonly stageId: number;
  readonly tMs: number;
  readonly method: string;
  readonly url: WireHttpUrl | string;
  readonly headers: readonly (readonly [string, unknown])[];
  readonly body: unknown;
  readonly protocol?: string;
}

export interface ProjectedWireResponse {
  readonly status?: number;
  readonly statusText?: string;
  readonly headers: readonly (readonly [string, unknown])[];
  readonly body?: unknown;
  readonly rawBody?: unknown;
  readonly rawStreamId?: number;
  readonly rawFrames: readonly ProjectedWireFrame[];
  readonly protocolStreamId?: number;
  readonly protocolFrames: readonly ProjectedWireFrame[];
  readonly clientStreamId?: number;
  readonly clientFrames?: readonly ProjectedWireFrame[];
}

export interface UpstreamCandidateProjection {
  readonly upstreamId?: string;
  readonly kind?: string;
  readonly modelId?: string;
  readonly upstreamModelId?: string;
}

export interface UpstreamAttemptProjection {
  readonly attemptIndex: number;
  readonly stageId: number;
  readonly isSubRun: boolean;
  readonly candidate?: UpstreamCandidateProjection;
  readonly startedAtMs: number;
  readonly headersAtMs?: number;
  readonly ttfbMs?: number;
  readonly endedAtMs?: number;
  readonly winning: boolean;
  readonly request: ProjectedWireRequest | null;
  readonly response: ProjectedWireResponse | null;
  readonly error?: unknown;
}

export interface WireProjection {
  readonly downstreamRequest: ProjectedWireRequest | null;
  readonly upstreamAttempts: readonly UpstreamAttemptProjection[];
  readonly downstreamResponse: ProjectedWireResponse | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSecretValue = (value: unknown): boolean => {
  if (isDecodedSecret(value)) return true;
  return typeof value === 'object' && value !== null && SECRET_BRAND in value;
};

const normalizeHeaders = (value: unknown): readonly (readonly [string, unknown])[] => {
  if (!Array.isArray(value)) return [];
  const headers: Array<readonly [string, unknown]> = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 2 || typeof entry[0] !== 'string') continue;
    headers.push(Object.freeze([entry[0], entry[1]] as const));
  }
  return Object.freeze(headers);
};

const requestFromStage = (stage: DecodedStageNode): ProjectedWireRequest | null => {
  const snapshot = isRecord(stage.facts['request.http']) ? stage.facts['request.http'] : stage.facts;
  if (typeof snapshot.method !== 'string' || (typeof snapshot.url !== 'string' && !isRecord(snapshot.url))) return null;
  return Object.freeze({
    stageId: stage.stageId,
    tMs: stage.enteredAtMs,
    method: snapshot.method,
    url: snapshot.url as WireHttpUrl | string,
    headers: normalizeHeaders(snapshot.headers),
    body: snapshot.body,
    ...(typeof snapshot.protocol === 'string' ? { protocol: snapshot.protocol } : {}),
  });
};

const findStreamId = (outcome: unknown): number | undefined => {
  if (!isRecord(outcome) || !isDecodedStreamRef(outcome.body)) return undefined;
  return outcome.body.$stream;
};

const projectFrames = (frames: readonly DecodedStreamFrame[]): readonly ProjectedWireFrame[] =>
  Object.freeze(frames.map(frame => Object.freeze({
    index: frame.index,
    seq: frame.seq,
    tMs: frame.tMs,
    deltaMs: frame.deltaMs,
    value: frame.value,
  })));

const isProtocolLabeled = (model: DumpViewModel, streamId: number): boolean => {
  const label = model.streams.get(streamId)?.label?.toLowerCase();
  return label?.includes('protocol') === true || label?.includes('event') === true;
};

const findUpstreamProtocolStreamId = (model: DumpViewModel, rawStreamId: number): number | undefined => {
  const raw = model.streams.get(rawStreamId);
  if (raw === undefined) return undefined;
  if (raw.derivedStreamIds.length === 0) return isProtocolLabeled(model, rawStreamId) ? rawStreamId : undefined;
  const labeledChild = raw.derivedStreamIds.find(id => isProtocolLabeled(model, id));
  return labeledChild ?? raw.derivedStreamIds[0];
};

const findDownstreamProtocolStreamId = (model: DumpViewModel, rawStreamId: number): number | undefined => {
  const raw = model.streams.get(rawStreamId);
  if (raw === undefined) return undefined;
  if (raw.wraps !== undefined) return raw.wraps;
  return isProtocolLabeled(model, rawStreamId) ? rawStreamId : undefined;
};

const findClientStreamId = (model: DumpViewModel, rawStreamId: number): number | undefined => {
  const pending = [...(model.streams.get(rawStreamId)?.derivedStreamIds ?? [])];
  const visited = new Set<number>();
  let last: number | undefined;
  while (pending.length > 0) {
    const candidate = pending.shift()!;
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    last = candidate;
    pending.push(...(model.streams.get(candidate)?.derivedStreamIds ?? []));
  }
  return last;
};

const responseFromStage = (
  stage: DecodedStageNode,
  model: DumpViewModel,
  direction: 'upstream' | 'downstream',
): ProjectedWireResponse | null => {
  const outcome = isRecord(stage.outcome) ? stage.outcome : undefined;
  if (outcome === undefined) return null;
  const body = outcome?.body;
  const rawStreamId = findStreamId(outcome);
  const rawStream = rawStreamId === undefined ? undefined : model.streams.get(rawStreamId);
  const protocolStreamId = rawStreamId === undefined
    ? undefined
    : direction === 'upstream'
      ? findUpstreamProtocolStreamId(model, rawStreamId)
      : findDownstreamProtocolStreamId(model, rawStreamId);
  const protocolStream = protocolStreamId === undefined ? undefined : model.streams.get(protocolStreamId);
  const clientStreamId = rawStreamId === undefined ? undefined : findClientStreamId(model, rawStreamId);
  const clientStream = clientStreamId === undefined ? undefined : model.streams.get(clientStreamId);
  return Object.freeze({
    ...(typeof outcome?.status === 'number' ? { status: outcome.status } : {}),
    ...(typeof outcome?.statusText === 'string' ? { statusText: outcome.statusText } : {}),
    headers: normalizeHeaders(outcome?.headers),
    ...(body === undefined ? {} : { body, rawBody: body }),
    rawFrames: projectFrames(rawStream?.frames ?? []),
    protocolFrames: projectFrames(protocolStream?.frames ?? []),
    ...(rawStreamId === undefined ? {} : {
      rawStreamId,
    }),
    ...(protocolStreamId === undefined ? {} : {
      protocolStreamId,
    }),
    ...(clientStreamId === undefined ? {} : {
      clientStreamId,
      clientFrames: projectFrames(clientStream?.frames ?? []),
    }),
  });
};

const candidateFromStage = (stage: DecodedStageNode): UpstreamCandidateProjection | undefined => {
  const value = stage.facts['route.candidate'];
  if (!isRecord(value)) return undefined;
  const candidate: {
    upstreamId?: string;
    kind?: string;
    modelId?: string;
    upstreamModelId?: string;
  } = {};
  if (typeof value.upstreamId === 'string') candidate.upstreamId = value.upstreamId;
  if (typeof value.kind === 'string') candidate.kind = value.kind;
  if (typeof value.modelId === 'string') candidate.modelId = value.modelId;
  if (typeof value.upstreamModelId === 'string') candidate.upstreamModelId = value.upstreamModelId;
  return Object.keys(candidate).length === 0 ? undefined : Object.freeze(candidate);
};

const isSubRunAttempt = (stage: DecodedStageNode, stages: ReadonlyMap<number, DecodedStageNode>): boolean => {
  let current: DecodedStageNode | undefined = stage;
  const seen = new Set<number>();
  while (current !== undefined && !seen.has(current.stageId)) {
    if (current.edgeKind === 'subrun') return true;
    seen.add(current.stageId);
    current = current.parentStageId === null ? undefined : stages.get(current.parentStageId);
  }
  return false;
};

const attemptEnd = (stage: DecodedStageNode, model: DumpViewModel): number | undefined => {
  const streamId = findStreamId(stage.outcome);
  const stream = streamId === undefined ? undefined : model.streams.get(streamId);
  const candidates = [stream?.frames.at(-1)?.tMs, stream?.end?.tMs, stage.leftAtMs]
    .filter((value): value is number => value !== undefined);
  return candidates.length === 0 ? undefined : Math.max(...candidates);
};

const successfulStatus = (response: ProjectedWireResponse | null): boolean =>
  response?.status === undefined || (response.status >= 200 && response.status < 400);

const selectDownstreamStage = (stages: readonly DecodedStageNode[]): DecodedStageNode | undefined =>
  stages
    .filter(stage => stage.tap === 'downstream' && (stage.outcome !== undefined || stage.error !== undefined))
    .at(-1);

export const projectWireView = (model: DumpViewModel): WireProjection => {
  const allStages = [...model.stages.values()];
  const downstreamStages = allStages
    .filter(stage => stage.tap === 'downstream')
    .sort((left, right) => left.enteredAtMs - right.enteredAtMs || left.stageId - right.stageId);
  const downstreamRequestStage = downstreamStages.find(stage => requestFromStage(stage) !== null);
  const downstreamResponseStage = selectDownstreamStage(downstreamStages);

  const upstreamStages = allStages
    .filter(stage => stage.tap === 'upstream')
    .sort((left, right) => left.enteredAtMs - right.enteredAtMs || left.stageId - right.stageId);
  const attempts: UpstreamAttemptProjection[] = upstreamStages.map((stage, attemptIndex) => {
    const response = responseFromStage(stage, model, 'upstream');
    const timing = isRecord(stage.outcome) && isRecord(stage.outcome.timing) ? stage.outcome.timing : undefined;
    const headersAtMs = typeof timing?.headersAtMs === 'number' ? timing.headersAtMs : stage.leftAtMs;
    const responseStreamId = findStreamId(stage.outcome);
    const responseStream = responseStreamId === undefined ? undefined : model.streams.get(responseStreamId);
    const streamError = responseStream?.end?.how === 'errored' ? responseStream.end.error : undefined;
    return Object.freeze({
      attemptIndex,
      stageId: stage.stageId,
      isSubRun: isSubRunAttempt(stage, model.stages),
      ...(candidateFromStage(stage) === undefined ? {} : { candidate: candidateFromStage(stage) }),
      startedAtMs: stage.enteredAtMs,
      ...(headersAtMs === undefined ? {} : { headersAtMs, ttfbMs: headersAtMs - stage.enteredAtMs }),
      ...(attemptEnd(stage, model) === undefined ? {} : { endedAtMs: attemptEnd(stage, model) }),
      winning: false,
      request: requestFromStage(stage),
      response,
      ...(stage.error === undefined && streamError === undefined ? {} : { error: stage.error ?? streamError }),
    });
  });

  const groupsWithFailure = new Set<string>();
  for (const attempt of attempts) {
    const stage = model.stages.get(attempt.stageId);
    if (stage !== undefined && (stage.status === 'failed' || !successfulStatus(attempt.response)))
      groupsWithFailure.add(`${String(stage.parentStageId)}:${attempt.isSubRun}`);
  }
  const winningAttempts = attempts.map(attempt => {
    const stage = model.stages.get(attempt.stageId);
    if (stage === undefined || attempt.isSubRun || stage.status === 'failed' || !successfulStatus(attempt.response)) return attempt;
    const group = `${String(stage.parentStageId)}:${attempt.isSubRun}`;
    const superseded = groupsWithFailure.has(group) && attempts.some(other => other.attemptIndex > attempt.attemptIndex
      && other.isSubRun === attempt.isSubRun
      && model.stages.get(other.stageId)?.parentStageId === stage.parentStageId
      && successfulStatus(other.response));
    return superseded ? attempt : Object.freeze({ ...attempt, winning: true });
  });

  return Object.freeze({
    downstreamRequest: downstreamRequestStage === undefined ? null : requestFromStage(downstreamRequestStage),
    upstreamAttempts: Object.freeze(winningAttempts),
    downstreamResponse: downstreamResponseStage === undefined ? null : responseFromStage(downstreamResponseStage, model, 'downstream'),
  });
};

const SENSITIVE_QUERY_KEYS = new Set([
  'key',
  'api_key',
  'apikey',
  'access_token',
  'token',
  'auth',
  'sig',
  'signature',
]);

const maskStringUrlQuery = (value: string): string => {
  const fragmentIndex = value.indexOf('#');
  const fragment = fragmentIndex < 0 ? '' : value.slice(fragmentIndex);
  const withoutFragment = fragmentIndex < 0 ? value : value.slice(0, fragmentIndex);
  const queryIndex = withoutFragment.indexOf('?');
  if (queryIndex < 0) return value;
  const query = withoutFragment.slice(queryIndex + 1);
  const masked = query.split('&').map(part => {
    const separator = part.indexOf('=');
    if (separator < 0) return part;
    const rawName = part.slice(0, separator);
    const decodedName = decodeURIComponent(rawName).toLowerCase();
    return SENSITIVE_QUERY_KEYS.has(decodedName) ? `${rawName}=***REDACTED***` : part;
  }).join('&');
  return `${withoutFragment.slice(0, queryIndex + 1)}${masked}${fragment}`;
};

export const formatWireUrl = (
  url: WireHttpUrl | string | unknown,
  options: { readonly maskSecrets?: boolean } = {},
): string => {
  if (typeof url === 'string') return options.maskSecrets === true ? maskStringUrlQuery(url) : url;
  if (!isRecord(url) || typeof url.origin !== 'string' || typeof url.pathname !== 'string')
    throw new TypeError('Invalid wire URL');
  const base = `${url.origin}${url.pathname}`;
  if (!Array.isArray(url.query) || url.query.length === 0) return base;
  const query = url.query.map(entry => {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') throw new TypeError('Invalid wire URL query entry');
    const keyLower = entry[0].toLowerCase();
    const value = isSecretValue(entry[1]) || (options.maskSecrets === true && SENSITIVE_QUERY_KEYS.has(keyLower))
      ? '***REDACTED***'
      : String(entry[1]);
    return `${encodeURIComponent(entry[0])}=${encodeURIComponent(value)}`;
  }).join('&');
  return `${base}?${query}`;
};

const shellQuote = (value: string): string => `'${value.replaceAll('\'', `'\\''`)}'`;

const bodyText = (body: unknown): string | undefined => {
  if (body === undefined) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  const seen = new WeakSet<object>();
  const redact = (value: unknown): unknown => {
    if (isSecretValue(value)) return '***REDACTED***';
    if (typeof value !== 'object' || value === null) return value;
    if (seen.has(value)) throw new TypeError('Cannot format a cyclic wire request body');
    seen.add(value);
    if (Array.isArray(value)) return value.map(redact);
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) result[key] = redact(child);
    return result;
  };
  return JSON.stringify(redact(body));
};

export const formatCurlCommand = (req: ProjectedWireRequest): string => {
  const parts = ['curl', '--request', shellQuote(req.method), shellQuote(formatWireUrl(req.url, { maskSecrets: true }))];
  for (const [name, value] of req.headers) {
    const rendered = isSecretValue(value) ? '***REDACTED***' : String(value);
    parts.push('--header', shellQuote(`${name}: ${rendered}`));
  }
  const body = bodyText(req.body);
  if (body !== undefined) parts.push('--data-raw', shellQuote(body));
  return parts.join(' ');
};
