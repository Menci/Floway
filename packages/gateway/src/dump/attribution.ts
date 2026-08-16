// What a turn's record says about the turn, and what fills it.
//
// `DumpMetadata` is common to both record shapes — the dashboard lists a run
// and a pair of edges in the same list, and a turn's model, upstream and token
// counts do not depend on which mechanism served it — so the hooks that stamp
// attribution and the assembly that turns it into metadata are one thing rather
// than one per shape.
//
// Four independent slots the mid-flight hooks fill: `model` and `upstreamId`
// identify what the turn was about, `inputTokens` / `outputTokens` quantify
// what the upstream reported. They're independent because different outcomes
// set different subsets:
//
//   • Every protocol handler calls `requestedModel(model)` immediately after
//     parsing the payload, so `model` is set regardless of outcome.
//   • `success(identity, usage)` fills all four; the upstream-resolved model
//     id may overwrite what `requestedModel` had.
//   • `error(kind, upstream?)` records a categorized api-error envelope
//     (`kind` matches `ApiErrorResult.source`). Real upstream non-2xx pass
//     `upstream` so a 4xx/5xx row in the dashboard names the upstream that
//     rejected the call; the gateway arm may also pass it when a candidate
//     was already chosen (item-not-found rewrite, server-tool input
//     rejection).
//   • `failed(reason)` records an uncategorized terminal failure: a thrown
//     exception, a source-emitted error frame, a downstream cancel, or a
//     writer error. Caller passes a string or Error; this one-line-formats it
//     (`.message` only — never the stack, which lives in the response body's
//     debug envelope).
//
// `requestedModel`-set model survives across both error variants so even an
// outright-failed turn carries model attribution.

import type { DumpErrorMeta, DumpMetadata, DumpUpstreamRef } from './types.ts';
import { getRepo } from '../repo/index.ts';
import type { TokenUsage } from '../repo/types.ts';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

export const oneLineError = (err: unknown): string => {
  const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  return msg.length > 500 ? `${msg.slice(0, 497)}…` : msg;
};

// Anthropic-style disjoint per-category counts: input excludes cache reads
// and cache writes; sum the present ones onto the dump's single inputTokens
// column. Missing categories stay null (not measured) instead of zero so a
// recorded zero genuinely means "upstream said zero".
const tokenUsageInput = (usage: TokenUsage | null): number | null => {
  if (!usage) return null;
  const { input, input_cache_read, input_cache_write } = usage;
  if (input === undefined && input_cache_read === undefined && input_cache_write === undefined) return null;
  return (input ?? 0) + (input_cache_read ?? 0) + (input_cache_write ?? 0);
};

const resolveUpstreamRef = async (id: string | null): Promise<DumpUpstreamRef | null> => {
  if (!id) return null;
  const upstream = await getRepo().upstreams.getById(id);
  if (!upstream) return null;
  return { id: upstream.id, name: upstream.name, kind: upstream.kind, hue: upstream.hue };
};

// What only the recording side knows: identity, timing and the measured sizes
// of the two edges. Everything else on the metadata comes from the hooks.
export interface DumpTurnOutcome {
  readonly id: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
  readonly requestBytes: number;
  readonly responseBytes: number;
  // Applied only when no hook stamped an error, so an explicit stamp from the
  // respond path always outranks a transport-level read failure.
  readonly fallbackError: DumpErrorMeta | null;
}

export class DumpAttribution {
  private model: string | null = null;
  private upstreamId: string | null = null;
  private inputTokens: number | null = null;
  private outputTokens: number | null = null;
  private errorMeta: DumpErrorMeta | null = null;

  requestedModel(model: string): void {
    this.model = model;
  }

  error(kind: 'upstream' | 'gateway', upstream?: string): void {
    this.errorMeta = { kind };
    if (upstream !== undefined) this.upstreamId = upstream;
  }

  failed(reason: unknown): void {
    this.errorMeta = { kind: 'failed', reason: typeof reason === 'string' ? reason : oneLineError(reason) };
  }

  success(identity: TelemetryModelIdentity, usage: TokenUsage | null): void {
    this.model = identity.model;
    this.upstreamId = identity.upstream;
    this.inputTokens = tokenUsageInput(usage);
    this.outputTokens = usage?.output ?? null;
  }

  async metadata(outcome: DumpTurnOutcome): Promise<DumpMetadata> {
    return {
      id: outcome.id,
      startedAt: outcome.startedAt,
      completedAt: outcome.completedAt,
      method: outcome.method,
      path: outcome.path,
      status: outcome.status,
      upstream: await resolveUpstreamRef(this.upstreamId),
      model: this.model,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      requestBytes: outcome.requestBytes,
      responseBytes: outcome.responseBytes,
      durationMs: outcome.completedAt - outcome.startedAt,
      error: this.errorMeta ?? outcome.fallbackError,
    };
  }
}
