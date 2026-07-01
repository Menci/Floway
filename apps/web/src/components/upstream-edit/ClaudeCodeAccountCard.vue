<script setup lang="ts">
// Two snapshot sources sit on the credential, populated by different paths:
// - `quotaSnapshot` is header-derived — the gateway parses every /v1/messages
//   response's `anthropic-ratelimit-unified-*` headers into a fixed schema.
// - `usageProbeSnapshot` is the verbatim body of an operator-driven probe
//   against Anthropic's `/api/oauth/usage` endpoint. Free-form JSON keyed by
//   `five_hour` / `seven_day` / `seven_day_sonnet`, each `{utilization,
//   resets_at}`. Field set evolves with the upstream CLI version.
//
// When both are present, the newer `fetchedAt` wins for the 5h/7d window
// chips: the probe is the official CC `/status` source and is fresher right
// after the operator hits Refresh; the header-derived snapshot is fresher
// after any real model call. We never merge fields from the two — they shape
// the same windows differently and a half-and-half view would mislead.

import { computed } from 'vue';

import type { ClaudeCodeAccountCredentialSummary, ClaudeCodeAccountIdentity, ClaudeCodeQuotaWindow, UpstreamRecord } from '../../api/types.ts';
import { formatClaudeCodeSubscriptionType } from '../../lib/claude-code-format.ts';
import { providerSwatchClass } from '../upstreams/provider-meta.ts';
import { Badge, Button, Spinner } from '@floway-dev/ui';

type ClaudeCodeUpstreamRecord = Extract<UpstreamRecord, { kind: 'claude-code' }>;

const props = defineProps<{
  record: ClaudeCodeUpstreamRecord;
  // True while the parent's probe-quota request is in flight; binds the
  // Refresh button's loading state. The card never gates Refresh on the
  // tokenKind axis — `/api/oauth/usage` answers under inference-only
  // scopes too, so setup-token credentials can probe.
  probing: boolean;
}>();

const emit = defineEmits<{
  'refresh-quota': [];
}>();

const HEAVY_USAGE_THRESHOLD_PCT = 80;

const account = computed<ClaudeCodeAccountIdentity>(() => props.record.config.accounts[0]);

type CredentialLookup =
  | { kind: 'present'; credential: ClaudeCodeAccountCredentialSummary }
  | { kind: 'missing-state' }
  | { kind: 'uuid-mismatch'; expectedAccountUuid: string };

const credentialLookup = computed<CredentialLookup>(() => {
  const raw = props.record.state;
  if (raw === null) return { kind: 'missing-state' };
  const configured = account.value;
  const match = raw.accounts.find(a => a.accountUuid === configured.accountUuid);
  if (match) return { kind: 'present', credential: match };
  return { kind: 'uuid-mismatch', expectedAccountUuid: configured.accountUuid };
});

const credential = computed<ClaudeCodeAccountCredentialSummary | null>(() => credentialLookup.value.kind === 'present' ? credentialLookup.value.credential : null);

const isSetupToken = computed<boolean>(() => credential.value?.tokenKind === 'setup-token');

const quota = computed(() => credential.value?.quotaSnapshot?.data ?? null);

// The probe body shape is owned by Anthropic and evolves with the CLI
// version. We do not assert the inner shape on the wire; the dashboard
// pulls the three known windows by name and ignores anything else (which
// the raw disclosure surfaces verbatim).
interface ProbeWindow { utilization: number | null; resetAt: string | null }
interface ProbeSnapshot {
  fetchedAt: number;
  fiveHour: ProbeWindow | null;
  sevenDay: ProbeWindow | null;
  sevenDaySonnet: ProbeWindow | null;
  // `Record<string, unknown>` is the upstream JSON minus the three known
  // windows. Surfaces under the raw disclosure so a new field
  // (`priorIsUsingOverage`, `hadPriorUtilizationData`, ...) is visible
  // without a dashboard change.
  extras: Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const parseProbeWindow = (raw: unknown): ProbeWindow | null => {
  if (!isRecord(raw)) return null;
  const utilization = typeof raw.utilization === 'number' ? raw.utilization : null;
  const resetAt = typeof raw.resets_at === 'string' ? raw.resets_at : null;
  return { utilization, resetAt };
};

const probe = computed<ProbeSnapshot | null>(() => {
  const snap = credential.value?.usageProbeSnapshot;
  if (!snap || !isRecord(snap.data)) return null;
  const { five_hour, seven_day, seven_day_sonnet, ...extras } = snap.data;
  return {
    fetchedAt: snap.fetchedAt,
    fiveHour: parseProbeWindow(five_hour),
    sevenDay: parseProbeWindow(seven_day),
    sevenDaySonnet: parseProbeWindow(seven_day_sonnet),
    extras,
  };
});

const formatTimestamp = (iso: string): string => new Date(iso).toLocaleString();

const clampPercent = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

const formatRelative = (epochMs: number): string => {
  const delta = epochMs - Date.now();
  const abs = Math.abs(delta);
  const minutes = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  let body: string;
  if (abs < 60_000) body = 'just now';
  else if (minutes < 60) body = `${minutes} min`;
  else if (hours < 48) body = `${hours} h`;
  else body = `${days} d`;
  return delta >= 0 ? `in ${body}` : `${body} ago`;
};

const badge = computed<{ tone: 'rose' | 'amber' | 'emerald'; label: string; detail?: string }>(() => {
  if (credentialLookup.value.kind === 'uuid-mismatch') {
    return { tone: 'rose', label: 'Configured account missing from state — re-import to recover' };
  }
  const c = credential.value;
  if (c?.state === 'session_terminated') {
    return { tone: 'rose', label: 'Session terminated — re-import to recover', detail: c.stateMessage };
  }
  if (c?.state === 'refresh_failed') {
    return { tone: 'rose', label: 'Refresh failed — re-import to recover', detail: c.stateMessage };
  }
  // Primary `status: rejected` means the plan window itself is exhausted —
  // the upstream will 429 the next request. `overage.status: rejected` is
  // NOT a limit signal; it's the steady state for any plan account that
  // hasn't bought extra credits (the chip below still surfaces it as info).
  if (quota.value?.status === 'rejected') {
    return { tone: 'rose', label: 'Plan window exhausted — wait for reset' };
  }
  const utilizations = windows.value.map(w => w.percent);
  const heaviest = utilizations.length ? Math.max(...utilizations) : null;
  if (heaviest !== null && heaviest >= HEAVY_USAGE_THRESHOLD_PCT) {
    return { tone: 'amber', label: `Heavy usage (${Math.round(heaviest)}%)` };
  }
  return { tone: 'emerald', label: 'Active' };
});

const accountIdShort = computed(() => {
  const id = account.value.accountUuid;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
});

const subscriptionLabel = computed(() => formatClaudeCodeSubscriptionType(account.value.subscriptionType, account.value.rateLimitTier));

// Email is null when the access token lacks `user:profile`. Substitute the
// short account-uuid badge as a stable identifier so the header still names
// the account.
const headerLabel = computed(() => account.value.email ?? accountIdShort.value);

// `seven_day_sonnet` rides only on the probe — it's surfaced only when probe
// data exists.
type WindowSource = 'header' | 'probe';
interface WindowRow {
  key: string;
  label: string;
  percent: number;
  resetAt: string | null;
  status: string | null;
  source: WindowSource;
  fetchedAt: number;
}

const headerFetchedAt = computed<number | null>(() => credential.value?.quotaSnapshot?.fetchedAt ?? null);
const probeFetchedAt = computed<number | null>(() => credential.value?.usageProbeSnapshot?.fetchedAt ?? null);

// `/v1/messages` response headers (`anthropic-ratelimit-unified-*`) report
// utilization on a 0..1 fraction; the active `/api/oauth/usage` probe reports
// the same metric pre-multiplied to 0..100. Both paths land in a single
// `percent: number` column (0..100) so downstream rendering can stay scale-
// agnostic.
const pickWindow = (label: string, key: string, headerWin: ClaudeCodeQuotaWindow | null | undefined, probeWin: ProbeWindow | null | undefined): WindowRow | null => {
  const headerUtil = headerWin?.utilization ?? null;
  const probeUtil = probeWin?.utilization ?? null;
  const headerTs = headerFetchedAt.value;
  const probeTs = probeFetchedAt.value;
  const preferProbe = probeUtil !== null && probeTs !== null && (headerUtil === null || headerTs === null || probeTs > headerTs);
  if (preferProbe && probeWin && probeUtil !== null && probeTs !== null) {
    return { key, label, percent: probeUtil, resetAt: probeWin.resetAt, status: null, source: 'probe', fetchedAt: probeTs };
  }
  if (headerUtil !== null && headerWin && headerTs !== null) {
    return { key, label, percent: headerUtil * 100, resetAt: headerWin.reset, status: headerWin.status, source: 'header', fetchedAt: headerTs };
  }
  return null;
};

const windows = computed<WindowRow[]>(() => {
  const rows: WindowRow[] = [];
  const fiveHour = pickWindow('5-hour window', 'five_hour', quota.value?.fiveHour, probe.value?.fiveHour);
  if (fiveHour) rows.push(fiveHour);
  const sevenDay = pickWindow('7-day window', 'seven_day', quota.value?.sevenDay, probe.value?.sevenDay);
  if (sevenDay) rows.push(sevenDay);
  const sonnet = probe.value?.sevenDaySonnet;
  const probeTs = probeFetchedAt.value;
  if (sonnet && typeof sonnet.utilization === 'number' && probeTs !== null) {
    rows.push({ key: 'seven_day_sonnet', label: '7-day Sonnet', percent: sonnet.utilization, resetAt: sonnet.resetAt, status: null, source: 'probe', fetchedAt: probeTs });
  }
  return rows;
});

const hasAnyWindow = computed<boolean>(() => windows.value.length > 0);

const accessTokenExpiry = computed(() => {
  const t = credential.value?.accessToken;
  if (!t) return null;
  return { expiresAt: t.expiresAt, relative: formatRelative(t.expiresAt) };
});

// Hide the `out_of_credits` reason because it's the steady state pair of
// `overage.status: rejected` — every plan account without purchased credits
// reports it. Any other value (a code we haven't seen, a future Anthropic
// signal) surfaces verbatim so operators see it.
const unexpectedDisabledReason = computed<string | null>(() => {
  const reason = quota.value?.overage?.disabledReason;
  if (!reason || reason === 'out_of_credits') return null;
  return reason;
});

const hasInfoChips = computed<boolean>(() => {
  const q = quota.value;
  if (!q) return false;
  return Boolean(q.representativeClaim) || q.overage?.status === 'allowed' || unexpectedDisabledReason.value !== null || q.fallbackAvailable === false;
});

const rawEntries = computed<Array<[string, string]>>(() => {
  const raw = quota.value?.raw;
  if (!raw) return [];
  return Object.entries(raw).sort(([a], [b]) => a.localeCompare(b));
});

// Anything Anthropic added to the probe body beyond the three known windows.
// JSON-stringify each value so a nested object is still readable in the
// disclosure (the field set evolves — `priorIsUsingOverage`,
// `hadPriorUtilizationData`, ... — and we render whatever's there).
const probeExtraEntries = computed<Array<[string, string]>>(() => {
  const extras = probe.value?.extras;
  if (!extras) return [];
  return Object.entries(extras)
    .map(([k, v]): [string, string] => [k, typeof v === 'string' ? v : JSON.stringify(v)])
    .sort(([a], [b]) => a.localeCompare(b));
});

const probeFetchedAtIso = computed<string | null>(() => {
  const ts = credential.value?.usageProbeSnapshot?.fetchedAt;
  return typeof ts === 'number' ? new Date(ts).toISOString() : null;
});
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-start gap-3">
      <div class="flex size-10 shrink-0 items-center justify-center rounded-full" :class="providerSwatchClass('claude-code')">
        <i class="i-simple-icons-claudecode size-5" />
      </div>
      <div class="min-w-0 flex-1 space-y-1">
        <p class="truncate text-sm font-medium text-white">{{ headerLabel }}</p>
        <div class="flex flex-wrap items-center gap-2 text-xs text-gray-400">
          <Badge v-if="isSetupToken" tone="violet" size="sm" class="!uppercase tracking-wide" title="Long-lived inference-only credential; cannot self-mint API keys and cannot be refreshed.">Setup Token</Badge>
          <Badge v-if="subscriptionLabel" tone="rose" size="sm" class="tracking-wide">{{ subscriptionLabel }}</Badge>
          <span class="font-mono text-[11px] text-gray-500" :title="account.accountUuid">{{ accountIdShort }}</span>
          <span v-if="account.email === null" class="text-[11px] text-gray-500" title="The OAuth token does not carry user:profile scope">no email scope</span>
        </div>
      </div>
      <Badge :tone="badge.tone" size="sm">{{ badge.label }}</Badge>
    </div>

    <p v-if="badge.detail" class="text-xs text-gray-500">{{ badge.detail }}</p>

    <p
      v-if="credentialLookup.kind === 'uuid-mismatch'"
      class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose"
    >
      Configured account
      <code class="font-mono">{{ credentialLookup.expectedAccountUuid }}</code>
      is not present in the gateway's stored state. Re-import the credential to re-link the account.
    </p>

    <div class="flex flex-wrap items-center justify-between gap-2">
      <p v-if="!hasAnyWindow" class="text-xs text-gray-500">No quota snapshot yet. Click Refresh to call <code class="font-mono text-[11px]">/api/oauth/usage</code> or wait for the next Claude Code call to populate headers.</p>
      <p v-else class="text-[11px] uppercase tracking-wide text-gray-500">Rate-limit windows</p>
      <Button size="sm" variant="secondary" :loading="probing" :disabled="probing" @click="emit('refresh-quota')">
        <Spinner v-if="probing" class="size-3.5" />
        <i v-else class="i-lucide-refresh-cw size-3.5" />
        Refresh quota
      </Button>
    </div>

    <template v-if="hasAnyWindow">
      <div class="space-y-3">
        <div v-for="w in windows" :key="w.key" class="space-y-1">
          <div class="flex items-baseline justify-between text-xs">
            <span class="text-gray-300">
              {{ w.label }}
              <span class="ml-1 text-[10px] uppercase tracking-wide text-gray-500" :title="`Fetched ${formatTimestamp(new Date(w.fetchedAt).toISOString())}`">{{ w.source === 'probe' ? 'probe' : 'headers' }}</span>
            </span>
            <span class="text-gray-500">{{ clampPercent(w.percent) }}%<template v-if="w.status"> · {{ w.status }}</template></span>
          </div>
          <div class="h-1.5 overflow-hidden rounded-full bg-surface-700">
            <div
              class="h-full bg-accent-rose transition-[width]"
              :style="{ width: `${clampPercent(w.percent)}%` }"
            />
          </div>
          <p v-if="w.resetAt" class="text-[11px] text-gray-500">Resets at {{ formatTimestamp(w.resetAt) }}</p>
        </div>
      </div>

      <!-- `overage.status: rejected` + `overage.disabledReason: out_of_credits`
           is the steady state for any plan-tier account that hasn't bought
           extra credits — rendering them on every account makes the dashboard
           look error-y for the normal case. Surface them only when the values
           signal something operator-actionable; the raw-headers details
           element below still exposes the underlying numbers for debugging. -->
      <div v-if="quota && hasInfoChips" class="flex flex-wrap items-center gap-2 text-[11px]">
        <Badge v-if="quota.representativeClaim" tone="zinc" size="sm">representative: {{ quota.representativeClaim }}</Badge>
        <Badge v-if="quota.overage?.status === 'allowed'" tone="emerald" size="sm">overage: allowed</Badge>
        <Badge v-if="unexpectedDisabledReason" tone="rose" size="sm">disabled: {{ unexpectedDisabledReason }}</Badge>
        <Badge v-if="quota.fallbackAvailable === false" tone="amber" size="sm">fallback unavailable</Badge>
      </div>

      <details v-if="rawEntries.length" class="text-[11px] text-gray-500">
        <summary class="cursor-pointer select-none text-gray-400 hover:text-gray-200">Raw quota headers ({{ rawEntries.length }})</summary>
        <dl class="mt-2 space-y-1 font-mono">
          <div v-for="[k, v] in rawEntries" :key="k" class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
            <dt class="truncate text-gray-500" :title="k">{{ k }}</dt>
            <dd class="truncate text-gray-300" :title="v">{{ v }}</dd>
          </div>
        </dl>
      </details>

      <details v-if="probeExtraEntries.length" class="text-[11px] text-gray-500">
        <summary class="cursor-pointer select-none text-gray-400 hover:text-gray-200">Raw probe extras ({{ probeExtraEntries.length }})</summary>
        <dl class="mt-2 space-y-1 font-mono">
          <div v-for="[k, v] in probeExtraEntries" :key="k" class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
            <dt class="truncate text-gray-500" :title="k">{{ k }}</dt>
            <dd class="truncate text-gray-300" :title="v">{{ v }}</dd>
          </div>
        </dl>
      </details>
    </template>

    <footer v-if="accessTokenExpiry || credential?.stateUpdatedAt || probeFetchedAtIso" class="flex flex-wrap items-center gap-3 border-t border-white/[0.06] pt-3 text-[11px] text-gray-500">
      <span v-if="credential?.stateUpdatedAt">state updated {{ formatTimestamp(credential.stateUpdatedAt) }}</span>
      <span v-if="accessTokenExpiry">access token expires {{ accessTokenExpiry.relative }}</span>
      <span v-if="probeFetchedAtIso">probe fetched {{ formatTimestamp(probeFetchedAtIso) }}</span>
    </footer>
  </div>
</template>
