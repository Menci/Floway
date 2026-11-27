import type { MeasuredUsage } from './compute-usage.ts';
import type { Candidate } from './facts.ts';
import type { PerformanceMeasurement } from './performance.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import type { DumpAccumulator } from '../../dump/accumulator.ts';
import { getRepo } from '../../repo/index.ts';
import type { ApiKey, User } from '../../repo/types.ts';
import { createOpenAIResponsesHttpStore, type OpenAIResponsesStatefulStore } from '../chat/openai-responses/items/store.ts';
import { AffinityCodec } from '../chat/shared/affinity/carrier.ts';
import { resolveLegacyOpaqueBlobCompatibilityIdentity } from '../chat/shared/affinity/legacy.ts';
import { createSidecarCodecFactory, type SidecarCodecFactory } from '../chat/shared/sidecar-codec.ts';
import { createLocalWebSearchService, type LocalWebSearchService } from '../non-chat/local-web-search/services.ts';
import { currentHour } from '../shared/telemetry/hour.ts';
import { recordUsage } from '../shared/telemetry/usage.ts';
import { resolveModelCandidates } from '../upstreams/resolution.ts';
import type { Fetcher } from '@floway-dev/http';
import type { ModelKind } from '@floway-dev/protocols/common';
import { getUpstreamRuntimeRepo, toUpstreamModelSnapshot, toUpstreamSnapshot, type TelemetryModelIdentity, type UpstreamsRepoSlim } from '@floway-dev/upstream';
import { createChatGPTService, type ChatGPTServices } from '@floway-dev/upstream-chatgpt';
import { createClaudeCodeService, type ClaudeCodeServices } from '@floway-dev/upstream-claude-code';
import { createCopilotServices, type CopilotServices } from '@floway-dev/upstream-copilot';
import { createKimiCodeService, type KimiCodePipelineServices } from '@floway-dev/upstream-kimi-code';
import { createOllamaActiveUsageService, type OllamaPipelineServices } from '@floway-dev/upstream-ollama';

export type GatewayDump = Pick<DumpAccumulator,
  'requestedModel' | 'firstOutput' | 'frame' | 'setUpstreamTargetApi' | 'upstreamFrame' | 'upstreamApiError'
  | 'stageUpstreamTranslationError' | 'selectUpstreamTranslationError' | 'error' | 'failed' | 'success'>;

export interface CatalogCandidateRequest {
  model: string;
  kind: ModelKind;
  upstreamId?: string;
}

type OpenAIResponsesStore = (startedAt: number, store: boolean | undefined) => OpenAIResponsesStatefulStore;

export interface GatewayServices extends ChatGPTServices, ClaudeCodeServices, CopilotServices, KimiCodePipelineServices, OllamaPipelineServices {
  readonly affinity: Pick<AffinityCodec, 'wrap' | 'unwrap'>;
  readonly sidecarCodec: SidecarCodecFactory;
  readonly openaiResponsesStore: OpenAIResponsesStore;
  readonly localWebSearch: LocalWebSearchService;
  readonly dump: GatewayDump | null;
  catalogCandidates(request: CatalogCandidateRequest): Promise<{ candidates: readonly Candidate[]; sawModel: boolean }>;
  recordUsage(model: TelemetryModelIdentity, usage: MeasuredUsage): Promise<void>;
  recordPerformance(measurement: PerformanceMeasurement): Promise<void>;
}

interface GatewayServiceOptions {
  apiKey: Pick<ApiKey, 'id' | 'serverSecret' | 'openaiResponsesRetentionSeconds' | 'upstreamIds' | 'randomizeUpstreams'>;
  subject: Pick<User, 'id' | 'isAdmin'>;
  runtimeLocation: string | null;
  dump: DumpAccumulator | null;
  openaiResponsesStore?: OpenAIResponsesStore;
}

const chatgpt = createChatGPTService();
const kimiCode = createKimiCodeService();
const serviceByRepo = new WeakMap<UpstreamsRepoSlim, Pick<GatewayServices, 'claudeCode' | 'ollama'>>();

const storedServices = () => {
  const repo = getUpstreamRuntimeRepo();
  const existing = serviceByRepo.get(repo.upstreams);
  if (existing !== undefined) return existing;
  const created = {
    claudeCode: createClaudeCodeService(repo),
    ollama: createOllamaActiveUsageService(repo),
  };
  serviceByRepo.set(repo.upstreams, created);
  return created;
};

export const createGatewayServices = ({
  apiKey, subject, runtimeLocation, dump, openaiResponsesStore,
}: GatewayServiceOptions): GatewayServices => {
  const createResponsesStore = openaiResponsesStore ?? ((startedAt, store) => createOpenAIResponsesHttpStore(apiKey, startedAt, store));
  let responsesStore: { startedAt: number; persist: boolean; value: OpenAIResponsesStatefulStore } | undefined;
  const fetcherByUpstream = new Map<string, Fetcher>();
  const fetcher = (upstreamId: string): Fetcher => {
    const matched = fetcherByUpstream.get(upstreamId);
    if (matched === undefined) throw new Error(`No data-plane fetcher for resolved upstream ${upstreamId}`);
    return matched;
  };

  return {
    ...createCopilotServices({ fetcher }),
    ...storedServices(),
    chatgpt,
    kimiCode,
    affinity: new AffinityCodec(apiKey.serverSecret, resolveLegacyOpaqueBlobCompatibilityIdentity),
    sidecarCodec: createSidecarCodecFactory(apiKey.serverSecret),
    localWebSearch: createLocalWebSearchService(apiKey.id),
    openaiResponsesStore(startedAt, store) {
      const persist = store !== false;
      if (responsesStore === undefined) {
        responsesStore = { startedAt, persist, value: createResponsesStore(startedAt, store) };
      } else if (responsesStore.startedAt !== startedAt || responsesStore.persist !== persist) {
        throw new Error('OpenAI Responses stages changed the client storage preferences within one run');
      }
      return responsesStore.value;
    },
    dump,
    async catalogCandidates({ model, kind, upstreamId }) {
      const { upstreamIds, randomizeUpstreams } = apiKey;
      if (upstreamId !== undefined && upstreamIds !== null && !upstreamIds.includes(upstreamId)) {
        return { candidates: [], sawModel: false };
      }
      const { candidates, sawModel } = await resolveModelCandidates({
        subject,
        upstreamIds: upstreamId === undefined ? upstreamIds : [upstreamId],
        randomizeUpstreams,
        model,
        kind,
      });
      const records = new Map(candidates
        .filter(({ upstream }) => !fetcherByUpstream.has(upstream.id))
        .map(({ upstream }) => [upstream.id, upstream]));
      if (records.size > 0) {
        const resolveFetcher = await createPerRequestFetcher(runtimeLocation, [...records.values()]);
        for (const id of records.keys()) {
          if (fetcherByUpstream.has(id)) continue;
          const resolved = resolveFetcher(id);
          fetcherByUpstream.set(id, dump === null ? resolved : dump.http.wrapFetcher(resolved, id));
        }
      }
      return {
        candidates: candidates.map(({ upstream, model, rules }) => ({
          upstream: toUpstreamSnapshot(upstream),
          model: toUpstreamModelSnapshot(model),
          ...(rules === undefined ? {} : { rules }),
        })),
        sawModel,
      };
    },
    recordUsage: (model, usage) => recordUsage(apiKey.id, model, usage.quantities, usage.pricingFacts),
    async recordPerformance({ operation, upstream, model, failed, ttftMs, tpotUs }) {
      const dimensions = { keyId: apiKey.id, runtimeLocation: runtimeLocation ?? 'UNKNOWN', operation, upstream, model, hour: currentHour() };
      const performance = getRepo().performance;
      if (ttftMs !== null) {
        await performance.recordSample({ ...dimensions, ttftMs, success: !failed, ...(tpotUs === undefined ? {} : { tpotUs }) });
      } else if (failed) {
        await performance.recordZeroOutputError(dimensions);
      } else {
        await performance.recordNeutral(dimensions);
      }
    },
  };
};
