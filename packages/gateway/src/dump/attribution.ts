// Listing metadata summarizes the run's observed model, upstream and quantities.
// The requested model survives failures before resolution; successful observations
// replace its identity and add only quantities that were actually reported.
// Explicit protocol or stage failures outrank transport and settlement fallbacks.

import { getRepo } from '../repo/index.ts';
import type { TokenUsage } from '../repo/types.ts';
import type { DumpErrorMeta, DumpMetadata, DumpUpstreamRef } from '@floway-dev/dump/types';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

export const oneLineError = (err: unknown): string => {
  const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  return msg.length > 500 ? `${msg.slice(0, 497)}…` : msg;
};

// Anthropic-style disjoint per-category counts: input excludes cache reads
// and cache writes; sum the present ones onto the dump's single inputTokens
// column. Missing categories stay null (not measured) instead of zero so a
// recorded zero genuinely means "upstream said zero".
const tokenTotal = (usage: TokenUsage | null, keys: readonly (keyof TokenUsage)[]): number | null => {
  if (usage === null) return null;
  const present = keys.map(key => usage[key]).filter((value): value is number => typeof value === 'number');
  return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0);
};

const resolveUpstreamRef = async (id: string | null): Promise<DumpUpstreamRef | null> => {
  if (!id) return null;
  const upstream = await getRepo().upstreams.getById(id);
  if (!upstream) return null;
  return { id: upstream.id, name: upstream.name, kind: upstream.kind, hue: upstream.hue };
};

// What only the recording side knows: identity, timing and the measured sizes
// of the request and response. Attribution hooks provide the remaining fields.
export interface DumpTurnOutcome {
  readonly id: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly ttftMs: number | null;
  // Applied only when no hook stamped an error, so an explicit stamp from the
  // pipeline or transport edge outranks a transport-level read failure.
  readonly fallbackError: DumpErrorMeta | null;
}

// A request-body read failure — the operator-side payload did not arrive intact
// — outranks a failure reading back what was answered. Both surface as
// `kind: 'failed'`.
export const streamReadError = (request: string | null, response: string | null): DumpErrorMeta | null => {
  if (request !== null) return { kind: 'failed', reason: request };
  if (response !== null) return { kind: 'failed', reason: response };
  return null;
};

export class DumpAttribution {
  private model: string | null = null;
  private upstreamId: string | null = null;
  private inputTokens: number | null = null;
  private outputTokens: number | null = null;
  private errorMeta: DumpErrorMeta | null = null;
  private settlementError: DumpErrorMeta | null = null;

  requestedModel(model: string): void {
    this.model = model;
  }

  error(kind: 'upstream' | 'gateway', upstream?: string): void {
    this.errorMeta = { kind };
    if (upstream !== undefined) this.upstreamId = upstream;
  }

  failed(reason: unknown, options?: { readonly fallback: boolean }): void {
    const error: DumpErrorMeta = { kind: 'failed', reason: typeof reason === 'string' ? reason : oneLineError(reason) };
    if (options?.fallback === true) this.settlementError = error;
    else this.errorMeta = error;
  }

  success(identity: TelemetryModelIdentity, usage: TokenUsage | null): void {
    this.model = identity.model;
    this.upstreamId = identity.upstream;
    const input = tokenTotal(usage, ['input', 'input_cache_read', 'input_cache_write', 'input_cache_write_1h', 'input_image']);
    if (input !== null) this.inputTokens = (this.inputTokens ?? 0) + input;
    const output = tokenTotal(usage, ['output', 'output_image']);
    if (output !== null) this.outputTokens = (this.outputTokens ?? 0) + output;
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
      ttftMs: outcome.ttftMs,
      error: this.errorMeta ?? outcome.fallbackError ?? this.settlementError,
    };
  }
}
