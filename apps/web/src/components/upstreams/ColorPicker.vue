<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import UpstreamBadge from './UpstreamBadge.vue';
import { PROVIDER_META, providerMeta } from './provider-meta.ts';
import { Input } from '@floway-dev/ui';
import type { UpstreamColor, UpstreamColorPreset, UpstreamProviderKind } from '../../api/types.ts';

// Per-upstream color override editor. Renders the 6 preset tones plus a
// "no override" chip (dashed ring around the kind default) and a "custom"
// chip that reveals a HEX input. Emits `null` for reset, a preset key, or a
// validated `#RRGGBB` string.
//
// Preset keys are static so UnoCSS keeps their classes; the custom branch
// stores `#RRGGBB` and the shared `UpstreamBadge` renders it via inline
// `color-mix()` styles.
const model = defineModel<UpstreamColor | null>({ required: true });

const props = defineProps<{
  kind: UpstreamProviderKind;
}>();

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const isPreset = (v: UpstreamColor | null): v is UpstreamColorPreset =>
  v !== null && !v.startsWith('#');

const isHex = (v: UpstreamColor | null): v is `#${string}` =>
  v !== null && v.startsWith('#');

// The HEX input's local state — lets the user type/backspace freely without
// dropping the last valid model value on every keystroke. Sync back to the
// model only on a valid `#RRGGBB` string.
const hexDraft = ref<string>(isHex(model.value) ? model.value : '#00e5ff');
const hexInvalid = computed(() => hexDraft.value.length > 0 && !HEX_RE.test(hexDraft.value));

watch(model, next => {
  if (isHex(next)) hexDraft.value = next;
});

const customMode = ref(isHex(model.value));

const onHexInput = (raw: string): void => {
  hexDraft.value = raw;
  if (HEX_RE.test(raw)) model.value = raw as UpstreamColor;
};

const selectPreset = (preset: UpstreamColorPreset): void => {
  customMode.value = false;
  model.value = preset;
};

const clearOverride = (): void => {
  customMode.value = false;
  model.value = null;
};

const enterCustom = (): void => {
  customMode.value = true;
  if (HEX_RE.test(hexDraft.value)) model.value = hexDraft.value as UpstreamColor;
};

const presets = PROVIDER_META.map(m => m.tone);
const uniquePresets = computed(() => [...new Set(presets)] as UpstreamColorPreset[]);
const kindDefaultTone = computed(() => providerMeta(props.kind).tone);
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex flex-wrap items-center gap-2">
      <!-- No override: dashed ring wraps the kind default swatch -->
      <button
        type="button"
        class="relative size-7 rounded-full border-2 border-dashed border-white/40 flex items-center justify-center transition-colors hover:border-white/70"
        :class="model === null ? 'ring-2 ring-accent-cyan/70 ring-offset-2 ring-offset-surface-900' : ''"
        :title="`Kind default (${kindDefaultTone})`"
        @click="clearOverride"
      >
        <UpstreamBadge :kind="kind" :color="null" variant="swatch" class="!size-4 !p-0 !rounded-full" />
      </button>

      <!-- Preset swatches -->
      <button
        v-for="preset in uniquePresets"
        :key="preset"
        type="button"
        class="size-7 rounded-full transition-transform hover:scale-110"
        :class="!customMode && model === preset ? 'ring-2 ring-accent-cyan/70 ring-offset-2 ring-offset-surface-900' : ''"
        :title="preset"
        @click="selectPreset(preset)"
      >
        <UpstreamBadge :kind="kind" :color="preset" variant="swatch" class="!size-7 !rounded-full" />
      </button>

      <!-- Custom HEX chip -->
      <button
        type="button"
        class="relative size-7 rounded-full border border-white/20 overflow-hidden transition-colors hover:border-white/50 flex items-center justify-center"
        :class="customMode ? 'ring-2 ring-accent-cyan/70 ring-offset-2 ring-offset-surface-900' : ''"
        :style="{
          backgroundImage: 'linear-gradient(45deg, rgba(255,255,255,0.15) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.15) 75%), linear-gradient(45deg, rgba(255,255,255,0.15) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.15) 75%)',
          backgroundSize: '8px 8px',
          backgroundPosition: '0 0, 4px 4px',
        }"
        title="Custom hex"
        @click="enterCustom"
      >
        <span class="i-lucide-pipette size-3.5 text-white/90" />
      </button>
    </div>

    <div v-if="customMode" class="flex items-center gap-2">
      <Input
        :model-value="hexDraft"
        type="text"
        size="sm"
        placeholder="#00E5FF"
        :invalid="hexInvalid"
        class="!w-32 font-mono uppercase"
        @update:model-value="onHexInput"
      />
      <span class="text-xs text-gray-500">Preview:</span>
      <UpstreamBadge
        :kind="kind"
        :color="isHex(model) ? model : (HEX_RE.test(hexDraft) ? (hexDraft as UpstreamColor) : null)"
        variant="badge"
        size="sm"
        show-label
      />
    </div>
  </div>
</template>
