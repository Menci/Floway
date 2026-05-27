<script setup lang="ts">
import { cn, OverlayScrollbars } from '@floway-dev/ui';
import type { HTMLAttributes } from 'vue';

import type { FlagDef, UpstreamProviderKind } from '../../api/types.ts';

const overrides = defineModel<Record<string, boolean>>({ required: true });

const props = withDefaults(defineProps<{
  flags: FlagDef[];
  providerKind: UpstreamProviderKind;
  inheritedOverrides?: Record<string, boolean>;
  namePrefix?: string;
  class?: HTMLAttributes['class'];
}>(), {
  inheritedOverrides: () => ({}),
  namePrefix: 'flag',
});

type TriState = 'inherit' | 'on' | 'off';

const stateFor = (flagId: string): TriState => {
  if (flagId in overrides.value) return overrides.value[flagId] ? 'on' : 'off';
  return 'inherit';
};

const setState = (flagId: string, next: TriState) => {
  const copy = { ...overrides.value };
  if (next === 'inherit') delete copy[flagId];
  else copy[flagId] = next === 'on';
  overrides.value = copy;
};

const inheritedLabel = (flag: FlagDef, kind: UpstreamProviderKind) => {
  const inherited = props.inheritedOverrides[flag.id];
  if (typeof inherited === 'boolean') return inherited ? 'on' : 'off';
  return flag.defaultFor.includes(kind) ? 'on' : 'off';
};

const stateLabel = (state: TriState, flag: FlagDef, kind: 'custom' | 'azure' | 'copilot') => {
  if (state === 'inherit') return `Inherit: ${inheritedLabel(flag, kind)}`;
  return state === 'on' ? 'On' : 'Off';
};

const pillClass = (state: TriState, selected: boolean, inheritedTo: 'on' | 'off') => {
  if (!selected) return 'border-white/10 text-gray-500 hover:bg-white/5';
  if (state === 'on') return 'border-accent-emerald/40 bg-accent-emerald/15 text-accent-emerald';
  if (state === 'off') return 'border-accent-rose/40 bg-accent-rose/15 text-accent-rose';
  return inheritedTo === 'on'
    ? 'border-accent-cyan/40 bg-accent-cyan/20 text-accent-cyan'
    : 'border-white/20 bg-white/10 text-gray-200';
};
</script>

<template>
  <OverlayScrollbars :class="cn('max-h-72', props.class)" no-tabindex :v-scrollbar-offset="{ x: 2 }">
    <p v-if="flags.length === 0" class="text-[11px] text-gray-600">No flags are registered.</p>
    <template v-else>
      <div v-for="flag in flags" :key="flag.id" class="flex items-start justify-between gap-3 border-t border-white/[0.06] py-2.5">
        <div class="min-w-0">
          <span class="block break-words text-xs text-white">{{ flag.label || flag.id }}</span>
          <span v-if="flag.description" class="mt-0.5 block text-[11px] text-gray-500">{{ flag.description }}</span>
        </div>
        <fieldset class="flex shrink-0 items-center gap-1 text-[11px]">
          <label
            v-for="state in (['inherit', 'on', 'off'] as TriState[])"
            :key="state"
            class="flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 transition-colors"
            :class="pillClass(state, stateFor(flag.id) === state, inheritedLabel(flag, providerKind))"
          >
            <input
              type="radio"
              :name="`${namePrefix}-${flag.id}`"
              :checked="stateFor(flag.id) === state"
              class="sr-only"
              @change="setState(flag.id, state)"
            >
            <span>{{ stateLabel(state, flag, providerKind) }}</span>
          </label>
        </fieldset>
      </div>
    </template>
  </OverlayScrollbars>
</template>
