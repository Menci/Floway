import { base64 } from '@scure/base';

import { isDecodedSecret, isDecodedStreamRef } from './decoder.ts';
import type { DecodedSecret, DecodedStageNode, DecodedStreamNode, DecodedStreamRef, DumpViewModel } from './decoder.ts';
import type { Secret } from '@floway-dev/pipeline';
import { Bytes, isSecret } from '@floway-dev/pipeline';

type WireString = string | DecodedSecret | Secret<string>;
type WireEntry = readonly [name: string, value: WireString];
type WireBody = Bytes | DecodedStreamRef | null;

export interface WireHttpUrl {
  readonly origin: string;
  readonly pathname: string;
  readonly query?: readonly WireEntry[];
}

export interface WireHttpRequest {
  readonly method: string;
  readonly url: WireHttpUrl;
  readonly headers: readonly WireEntry[];
  readonly body: WireBody;
}

export interface WireHttpResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly WireEntry[];
  readonly body: WireBody;
  readonly timing: { readonly startedAt: number; readonly headersAt: number };
}

export interface ProjectedWireRequest extends WireHttpRequest {
  readonly stageId: number;
  readonly tMs: number;
  readonly stream?: DecodedStreamNode;
}

export interface ProjectedWireResponse extends WireHttpResponse {
  readonly stream?: DecodedStreamNode;
}

export interface UpstreamExchange {
  readonly stageId: number;
  readonly request: ProjectedWireRequest;
  readonly response: ProjectedWireResponse;
}

export interface UpstreamExchangeGroup {
  readonly candidateStageId: number | null;
  readonly candidate?: unknown;
  readonly exchanges: readonly UpstreamExchange[];
}

export interface WireProjection {
  readonly downstreamRequest: ProjectedWireRequest | null;
  readonly downstreamResponse: ProjectedWireResponse | null;
  readonly upstreamExchanges: readonly UpstreamExchange[];
  readonly upstreamGroups: readonly UpstreamExchangeGroup[];
}

const getRequest = (stage: DecodedStageNode, model: DumpViewModel): ProjectedWireRequest | null => {
  const request = stage.facts['request.http'] as WireHttpRequest | undefined;
  if (request === undefined) return null;
  const stream = isDecodedStreamRef(request.body) ? model.streams.get(request.body.$stream) : undefined;
  return { ...request, stageId: stage.stageId, tMs: stage.enteredAtMs, ...(stream === undefined ? {} : { stream }) };
};

const getResponse = (stage: DecodedStageNode, model: DumpViewModel): ProjectedWireResponse | null => {
  const response = stage.responseFacts?.['response.http'] as WireHttpResponse | undefined;
  if (response === undefined) return null;
  const stream = isDecodedStreamRef(response.body) ? model.streams.get(response.body.$stream) : undefined;
  return { ...response, ...(stream === undefined ? {} : { stream }) };
};

const findCandidateStage = (stage: DecodedStageNode, model: DumpViewModel): DecodedStageNode | undefined => {
  let candidateStage: DecodedStageNode | undefined;
  let parentId = stage.parentStageId;
  while (parentId !== null) {
    const parent = model.stages.get(parentId);
    if (parent === undefined) throw new Error(`Missing dump parent stage ${parentId}`);
    const hasCandidate = Object.hasOwn(parent.facts, 'route.candidate');
    if (candidateStage !== undefined
      && (!hasCandidate || !Object.is(parent.facts['route.candidate'], candidateStage.facts['route.candidate']))) break;
    if (hasCandidate) candidateStage = parent;
    parentId = parent.parentStageId;
  }
  return candidateStage;
};

export const projectWireExchanges = (model: DumpViewModel): WireProjection => {
  const stages = [...model.stages.values()];
  const root = stages.find(stage => stage.edge === 'root');
  const upstreamExchanges: UpstreamExchange[] = [];
  const groups = new Map<number | null, UpstreamExchangeGroup & { exchanges: UpstreamExchange[] }>();
  for (const stage of stages) {
    if (stage.childStageIds.length !== 0) continue;
    const request = getRequest(stage, model);
    const response = getResponse(stage, model);
    if (request === null || response === null) continue;
    const exchange = { stageId: stage.stageId, request, response };
    upstreamExchanges.push(exchange);

    const candidateStage = findCandidateStage(stage, model);
    const key = candidateStage?.stageId ?? null;
    let group = groups.get(key);
    if (group === undefined) {
      group = candidateStage === undefined
        ? { candidateStageId: null, exchanges: [] }
        : { candidateStageId: key, candidate: candidateStage.facts['route.candidate'], exchanges: [] };
      groups.set(key, group);
    }
    group.exchanges.push(exchange);
  }

  return {
    downstreamRequest: root === undefined ? null : getRequest(root, model),
    downstreamResponse: root === undefined ? null : getResponse(root, model),
    upstreamExchanges,
    upstreamGroups: [...groups.values()],
  };
};

const sensitiveQueryKeys = new Set([
  'key', 'api_key', 'apikey', 'access_token', 'token', 'auth', 'sig', 'signature',
]);
const redacted = '***REDACTED***';
const renderString = (value: WireString): string => isDecodedSecret(value) || isSecret(value) ? redacted : value;

export const formatWireUrl = (url: WireHttpUrl, { maskSecrets = false }: { readonly maskSecrets?: boolean } = {}): string => {
  const base = `${url.origin}${url.pathname}`;
  if (!url.query?.length) return base;
  const query = url.query.map(([name, value]) => {
    const rendered = maskSecrets && sensitiveQueryKeys.has(name.toLowerCase()) ? redacted : renderString(value);
    return `${encodeURIComponent(name)}=${encodeURIComponent(rendered)}`;
  }).join('&');
  return `${base}?${query}`;
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const ansiCQuote = (value: string): string =>
  `$'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\r', '\\r').replaceAll('\n', '\\n').replaceAll('\t', '\\t')}'`;

const printableUtf8 = (bytes: Uint8Array): string | undefined => {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code !== 9 && code !== 10 && code !== 13 && (code < 32 || code === 127)) return undefined;
    }
    return text;
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
};

export const formatCurlCommand = (request: WireHttpRequest): string => {
  const parts = ['curl', '--request', shellQuote(request.method), shellQuote(formatWireUrl(request.url, { maskSecrets: true }))];
  for (const [name, value] of request.headers) parts.push('--header', shellQuote(`${name}: ${renderString(value)}`));
  if (!(request.body instanceof Bytes)) return parts.join(' ');
  const bytes = request.body.toUint8Array();
  const text = printableUtf8(bytes);
  if (text === undefined) {
    parts.push('--data-binary', '@-');
    return `printf '%s' ${shellQuote(base64.encode(bytes))} | base64 -d | ${parts.join(' ')}`;
  }
  if (text.includes('\r')) parts.push('--data-binary', ansiCQuote(text));
  else parts.push('--data-raw', shellQuote(text));
  return parts.join(' ');
};
