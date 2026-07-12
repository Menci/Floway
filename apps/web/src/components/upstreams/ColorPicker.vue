<script setup lang="ts">
// Per-upstream color override editor. Three tiers, top-to-bottom:
//   - 6 preset tone swatches + a "no override" chip (dashed ring around the
//     kind default) + a "custom hex" chip that expands the picker below.
//   - HSV colour wheel (saturation/value pad + hue strip) that drives the
//     hex draft and, transitively, the model.
//   - free-form HEX input with live preview badge.
//
// Emits `null` for reset, a preset key, or a validated `#RRGGBB` string.
// Preset keys are static so UnoCSS keeps their classes; the custom branch
// stores `#RRGGBB` and the shared `UpstreamBadge` renders it via inline
// `color-mix()` styles.

import { computed, ref, useTemplateRef, watch } from 'vue';

import { providerMeta } from './provider-meta.ts';
import { KIND_DEFAULT_TONES } from './upstream-paint.ts';
import UpstreamBadge from './UpstreamBadge.vue';
import type { UpstreamColor, UpstreamColorPreset, UpstreamProviderKind } from '../../api/types.ts';
import { clamp01, HEX_RE, hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from '../../utils/color.ts';
import { UPSTREAM_COLOR_PRESETS } from '@floway-dev/provider/model';
import { Input } from '@floway-dev/ui';

const model = defineModel<UpstreamColor | null>({ required: true });

const props = defineProps<{
  kind: UpstreamProviderKind;
}>();

const emit = defineEmits<{ 'update:invalid': [invalid: boolean] }>();

const isHex = (v: UpstreamColor | null): v is `#${string}` =>
  v?.startsWith('#') ?? false;

// Picker state. When `model` is a hex, seed HSV from it; otherwise start on
// a pleasant cyan default so the first custom-mode open shows a live colour
// rather than a black square.
const initialHex = isHex(model.value) ? model.value : '#00E5FF';
const initialRgb = hexToRgb(initialHex) ?? [0, 229, 255];
const initialHsv = rgbToHsv(initialRgb[0], initialRgb[1], initialRgb[2]);

const hue = ref<number>(initialHsv[0]);         // 0..360
const saturation = ref<number>(initialHsv[1]);  // 0..1
const brightness = ref<number>(initialHsv[2]);  // 0..1 (HSV "value")

const hexDraft = ref<string>(initialHex);
const hexInvalid = computed(() => hexDraft.value.length > 0 && !HEX_RE.test(hexDraft.value));

const customMode = ref(isHex(model.value));

// A single reentrancy guard for the SV/H → hex → HSV → SV/H loop. Any state
// change that would trigger the reverse edge sets this flag first; the
// receiving watchers no-op while it is set.
let syncing = false;

const commitFromHsv = (): void => {
  const [r, g, b] = hsvToRgb(hue.value, saturation.value, brightness.value);
  const hex = rgbToHex(r, g, b);
  syncing = true;
  hexDraft.value = hex;
  model.value = hex as UpstreamColor;
  syncing = false;
};

// Apply a valid hex string to the HSV state. Preserves the current hue
// slider position for near-greyscale inputs (where the derived hue is
// undefined and would jump to 0 on every keystroke). Callers must have
// already validated `raw` against HEX_RE.
const applyHsvFromHex = (raw: string): void => {
  const [r, g, b] = hexToRgb(raw)!;
  const [h, s, v] = rgbToHsv(r, g, b);
  if (s > 0.01) hue.value = h;
  saturation.value = s;
  brightness.value = v;
};

const commitFromHex = (raw: string): void => {
  hexDraft.value = raw;
  if (!HEX_RE.test(raw)) return;
  const canonical = raw.toUpperCase();
  syncing = true;
  applyHsvFromHex(raw);
  hexDraft.value = canonical;
  model.value = canonical as UpstreamColor;
  syncing = false;
};

// When the model changes from outside (preset click, reset), pull the hex
// draft and HSV coordinates back in sync so re-entering custom mode starts
// from the last hex value the user had. `flush: 'sync'` keeps the `syncing`
// reentrancy guard effective — it is set synchronously around the model
// write in commitFromHsv/commitFromHex, so the handler must also run
// synchronously to observe it.
watch(model, next => {
  if (syncing) return;
  if (isHex(next)) {
    hexDraft.value = next;
    applyHsvFromHex(next);
  }
}, { flush: 'sync' });

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
  if (HEX_RE.test(hexDraft.value)) model.value = hexDraft.value.toUpperCase() as UpstreamColor;
};

// SV pad drag: pointer coordinates → saturation (x) + value (1 - y).
// Uses setPointerCapture so a drag that leaves the pad still updates.
const svPad = useTemplateRef<HTMLDivElement>('svPad');

const svUpdateFromEvent = (e: PointerEvent): void => {
  const el = svPad.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  saturation.value = clamp01((e.clientX - rect.left) / rect.width);
  brightness.value = clamp01(1 - (e.clientY - rect.top) / rect.height);
  commitFromHsv();
};

const onSvPointerDown = (e: PointerEvent): void => {
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  svUpdateFromEvent(e);
};

const onSvPointerMove = (e: PointerEvent): void => {
  if ((e.buttons & 1) !== 1) return;
  svUpdateFromEvent(e);
};

const hueStrip = useTemplateRef<HTMLDivElement>('hueStrip');

const hueUpdateFromEvent = (e: PointerEvent): void => {
  const el = hueStrip.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  hue.value = clamp01((e.clientX - rect.left) / rect.width) * 360;
  commitFromHsv();
};

const onHuePointerDown = (e: PointerEvent): void => {
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  hueUpdateFromEvent(e);
};

const onHuePointerMove = (e: PointerEvent): void => {
  if ((e.buttons & 1) !== 1) return;
  hueUpdateFromEvent(e);
};

// Derived visuals. The SV pad's backdrop is the current hue as a fully
// saturated solid; the two crossed gradients then wash white into it
// (saturation axis) and black over it (value axis).
const svBackground = computed(() => ({
  backgroundColor: `hsl(${hue.value}, 100%, 50%)`,
  backgroundImage: 'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)',
}));

const svThumbStyle = computed(() => ({
  left: `${saturation.value * 100}%`,
  top: `${(1 - brightness.value) * 100}%`,
}));

const hueThumbStyle = computed(() => ({
  left: `${(hue.value / 360) * 100}%`,
}));

const presets: readonly UpstreamColorPreset[] = UPSTREAM_COLOR_PRESETS;
const kindDefaultTone = computed(() => KIND_DEFAULT_TONES[props.kind]);

// Preview always reflects what will be saved: the model when it is a hex
// (custom mode's canonical value), the draft when the input is a valid
// #RRGGBB in flight, otherwise the model verbatim (which may be a preset
// key or null). The preview never disagrees with the current model — a
// stale invalid hex in the input does not mask the saved value.
const previewColor = computed<UpstreamColor | null>(() => {
  if (isHex(model.value)) return model.value;
  if (HEX_RE.test(hexDraft.value)) return hexDraft.value as UpstreamColor;
  return model.value;
});

// Signal invalid only while the user is actively editing hex; a stale
// invalid draft left over from a prior custom-mode session must not block
// Save in preset mode where the hex input is hidden.
const invalid = computed(() => customMode.value && hexInvalid.value);
watch(invalid, v => emit('update:invalid', v), { immediate: true });
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center gap-2">
      <button
        type="button"
        class="relative size-7 rounded-full border-2 border-dashed border-white/40 flex items-center justify-center transition-colors hover:border-white/70"
        :class="model === null ? 'ring-2 ring-accent-cyan/70 ring-offset-2 ring-offset-surface-900' : ''"
        :title="`Kind default (${kindDefaultTone})`"
        @click="clearOverride"
      >
        <UpstreamBadge :kind="kind" :color="null" variant="swatch" class="size-4 rounded-full" />
      </button>

      <button
        v-for="preset in presets"
        :key="preset"
        type="button"
        class="size-7 rounded-full transition-transform hover:scale-110"
        :class="!customMode && model === preset ? 'ring-2 ring-accent-cyan/70 ring-offset-2 ring-offset-surface-900' : ''"
        :title="preset"
        @click="selectPreset(preset)"
      >
        <UpstreamBadge :kind="kind" :color="preset" variant="chip" class="size-7 rounded-full" />
      </button>

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

    <div v-if="customMode" class="flex flex-col gap-2">
      <div
        ref="svPad"
        class="relative h-32 w-52 cursor-crosshair overflow-hidden rounded-md border border-white/[0.1]"
        :style="svBackground"
        @pointerdown="onSvPointerDown"
        @pointermove="onSvPointerMove"
      >
        <div
          class="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
          :style="svThumbStyle"
        />
      </div>

      <div
        ref="hueStrip"
        class="relative h-3 w-52 cursor-ew-resize overflow-hidden rounded-full border border-white/[0.1]"
        :style="{ backgroundImage: 'linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)' }"
        @pointerdown="onHuePointerDown"
        @pointermove="onHuePointerMove"
      >
        <div
          class="pointer-events-none absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-black/50 bg-white shadow"
          :style="hueThumbStyle"
        />
      </div>

      <div class="flex items-center gap-2">
        <Input
          :model-value="hexDraft"
          type="text"
          size="sm"
          placeholder="#00E5FF"
          :invalid="hexInvalid"
          class="!w-32 font-mono uppercase"
          @update:model-value="commitFromHex"
        />
        <span class="text-xs text-gray-500">Preview:</span>
        <UpstreamBadge
          :kind="kind"
          :color="previewColor"
          variant="badge"
          size="sm"
        >{{ providerMeta(kind).label }}</UpstreamBadge>
      </div>
    </div>
  </div>
</template>
