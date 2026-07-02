<script setup lang="ts">
import { computed } from 'vue';

import type { ControlPlaneModel } from '../../api/types.ts';
import { reachableTargets } from '../../utils/reachability.ts';
import { providerBadgeClass, providerMeta } from '../upstreams/provider-meta.ts';
import { type AliasRuleBadgeField, formatAliasRuleBadges } from '@floway-dev/protocols/common';

const props = defineProps<{
  model: ControlPlaneModel;
  // Full catalog the row came from; needed so alias rows can show how
  // many of their configured targets are actually reachable under the
  // caller's current cap. Optional because callers outside the
  // playground may not have a meaningful catalog (e.g. the Models
  // page's tile renders the row in isolation).
  catalog?: readonly ControlPlaneModel[];
  // Effective upstream cap of the playground's current api key choice;
  // `null` means unrestricted. Drives the alias-reachable-count badge.
  // Omitted by callers that have no cap to apply.
  cap?: readonly string[] | null;
}>();

defineEmits<{ clear: [] }>();

const formatTokenLimit = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return n.toString();
};

// Shape used by the alias-of badge AND the selection badge to read the
// caller-cap-aware reachable subset. `null` when the row is not an alias
// or no catalog was supplied — both badges then go dormant.
const aliasReach = computed<{ total: number; reachable: number; sole: ControlPlaneModel | null } | null>(() => {
  const a = props.model.aliasedFrom;
  if (!a) return null;
  if (props.catalog === undefined) {
    // No catalog → "everything configured is reachable" (the row was
    // rendered in isolation, no cap context to apply).
    return { total: a.targets.length, reachable: a.targets.length, sole: null };
  }
  const reachable = reachableTargets(props.model, props.catalog, props.cap ?? null);
  return {
    total: a.targets.length,
    reachable: reachable.length,
    sole: reachable.length === 1 ? reachable[0] : null,
  };
});

// `alias of: <id>` when only one reachable target is also a visible
// catalog row (admin or non-admin under a narrow cap viewing a single-
// target alias) — use the raw model id, not its display name, so the
// badge mirrors the value the operator typed into the alias target
// field and the value a client would put on the wire;
// `alias of: N models` when every configured target is reachable;
// `alias of: K / N models` when some are out of cap.
const aliasOfLabel = computed<string | null>(() => {
  const r = aliasReach.value;
  if (r === null) return null;
  if (r.sole !== null) return `alias of: ${r.sole.id}`;
  if (r.reachable === r.total) return `alias of: ${r.total} model${r.total === 1 ? '' : 's'}`;
  return `alias of: ${r.reachable} / ${r.total} models`;
});

// Single-target chip is enough — drop the parallel `selection: random`
// label, which only matters for multi-target aliases where the resolver
// genuinely picks between candidates.
const selectionLabel = computed<string | null>(() => {
  const a = props.model.aliasedFrom;
  if (!a) return null;
  if (aliasReach.value?.sole !== null) return null;
  return `selection: ${a.selection}`;
});

// Provider badges this row renders. Real models advertise their own
// `upstreams` bindings directly. Alias rows have an empty `upstreams`
// list on the wire (the server intentionally lifts upstream info to
// the targets) — compute the de-duped union of the caller-reachable
// targets' bindings here so the alias surfaces the same provider-badge
// shape every real-model row does. Each binding is further filtered
// against the cap: a target may sit on three upstreams of which only
// one is currently in cap; only the in-cap one is the provider the
// resolver would actually route to.
const effectiveUpstreams = computed<readonly { kind: ControlPlaneModel['upstreams'][number]['kind']; id: string; name: string }[]>(() => {
  if (props.model.aliasedFrom === undefined) return props.model.upstreams;
  if (props.catalog === undefined) return [];
  const cap = props.cap ?? null;
  const seen = new Set<string>();
  const out: ControlPlaneModel['upstreams'] = [];
  for (const target of reachableTargets(props.model, props.catalog, cap)) {
    for (const binding of target.upstreams) {
      if (cap !== null && !cap.includes(binding.id)) continue;
      if (seen.has(binding.id)) continue;
      seen.add(binding.id);
      out.push(binding);
    }
  }
  return out;
});

// Single-target aliases render one badge per rule; multi-target aliases
// collapse to "<field>: varies" for any field whose values disagree across
// targets. Each badge carries an explicit `field` key so the bucket walk
// groups by the rule slot directly rather than parsing the label string.
const ruleBadges = computed<{ label: string }[]>(() => {
  const a = props.model.aliasedFrom;
  if (!a) return [];
  if (a.targets.length === 1) return formatAliasRuleBadges(a.targets[0].rules);
  const byField = new Map<AliasRuleBadgeField, Set<string>>();
  for (const t of a.targets) {
    for (const badge of formatAliasRuleBadges(t.rules)) {
      const set = byField.get(badge.field) ?? new Set<string>();
      set.add(badge.label);
      byField.set(badge.field, set);
    }
  }
  return Array.from(byField.entries()).map(([field, set]) => ({
    label: set.size === 1 ? [...set][0] : `${field}: varies`,
  }));
});
</script>

<template>
  <div class="shrink-0 p-4 border-b border-white/[0.06]">
    <div class="flex items-center justify-between gap-4">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2">
          <h3 class="text-sm font-semibold text-white">{{ model.display_name ?? model.id }}</h3>
          <span
            v-if="(model.display_name ?? model.id) !== model.id"
            class="font-mono text-[11px] text-gray-500 break-all"
          >{{ model.id }}</span>
        </div>
        <div class="flex flex-wrap gap-1.5 mt-2">
          <span
            v-for="upstream in effectiveUpstreams"
            :key="upstream.id"
            class="text-[10px] font-semibold px-2 py-0.5 rounded-full border"
            :class="providerBadgeClass(upstream.kind)"
            :title="providerMeta(upstream.kind).label + ' · ' + upstream.name"
          >{{ upstream.name }}</span>
          <span v-if="model.limits?.max_context_window_tokens" class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-surface-600 text-gray-400">
            context: {{ formatTokenLimit(model.limits.max_context_window_tokens) }}
          </span>
          <span v-if="model.limits?.max_prompt_tokens" class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-surface-600 text-gray-400">
            prompt: {{ formatTokenLimit(model.limits.max_prompt_tokens) }}
          </span>
          <span v-if="model.limits?.max_output_tokens" class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-surface-600 text-gray-400">
            output: {{ formatTokenLimit(model.limits.max_output_tokens) }}
          </span>
          <span v-if="aliasOfLabel" class="text-[10px] font-mono px-2 py-0.5 rounded-full border border-white/15 text-gray-400">{{ aliasOfLabel }}</span>
          <span v-if="selectionLabel" class="text-[10px] font-mono px-2 py-0.5 rounded-full border border-white/15 text-gray-400">{{ selectionLabel }}</span>
          <span
            v-for="badge in ruleBadges"
            :key="badge.label"
            class="text-[10px] font-mono px-2 py-0.5 rounded-full border border-white/15 text-gray-400"
          >{{ badge.label }}</span>
        </div>
      </div>
      <button class="btn-ghost text-[11px] flex shrink-0 items-center gap-1" @click="$emit('clear')">
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
        </svg>
        Clear
      </button>
    </div>
  </div>
</template>
