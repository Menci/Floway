<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from 'vue';

import UpstreamBadge from './UpstreamBadge.vue';
import { PROVIDER_META, providerMeta } from './provider-meta.ts';
import { Input } from '@floway-dev/ui';
import type { UpstreamColor, UpstreamColorPreset, UpstreamProviderKind } from '../../api/types.ts';

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
const model = defineModel<UpstreamColor | null>({ required: true });

const props = defineProps<{
  kind: UpstreamProviderKind;
}>();

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const isHex = (v: UpstreamColor | null): v is `#${string}` =>
  v !== null && v.startsWith('#');

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

// HSV ↔ RGB ↔ HEX. HSV is the picker's native coordinate system; hex is the
// wire form; RGB is the intermediate. Zero external deps — the formulas are
// short and standard.
const hsvToRgb = (h: number, s: number, v: number): [number, number, number] => {
  const c = v * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
};

const rgbToHex = (r: number, g: number, b: number): string =>
  '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase();

const hexToRgb = (hex: string): [number, number, number] | null => {
  if (!HEX_RE.test(hex)) return null;
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
};

const rgbToHsv = (r: number, g: number, b: number): [number, number, number] => {
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
  const d = max - min;
  const v = max;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    if (max === rf) h = ((gf - bf) / d + (gf < bf ? 6 : 0)) * 60;
    else if (max === gf) h = ((bf - rf) / d + 2) * 60;
    else h = ((rf - gf) / d + 4) * 60;
  }
  return [h, s, v];
};

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

const commitFromHex = (raw: string): void => {
  hexDraft.value = raw;
  if (!HEX_RE.test(raw)) return;
  syncing = true;
  const [r, g, b] = hexToRgb(raw)!;
  const [h, s, v] = rgbToHsv(r, g, b);
  // Preserve the current hue slider position for near-greyscale inputs
  // (where the derived hue is undefined and would jump to 0 on every
  // keystroke).
  if (s > 0.01) hue.value = h;
  saturation.value = s;
  brightness.value = v;
  model.value = raw.toUpperCase() as UpstreamColor;
  syncing = false;
};

// When the model changes from outside (preset click, reset), pull the hex
// draft and HSV coordinates back in sync so re-entering custom mode starts
// from the last hex value the user had.
watch(model, next => {
  if (syncing) return;
  if (isHex(next)) {
    hexDraft.value = next;
    const rgb = hexToRgb(next);
    if (rgb) {
      const [h, s, v] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
      if (s > 0.01) hue.value = h;
      saturation.value = s;
      brightness.value = v;
    }
  }
});

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

// Hue strip drag: horizontal position → hue (0..360). Same pointer-capture
// pattern as the SV pad.
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

// Derived visuals. `hueColor` is the pure fully-saturated colour that
// backs the SV pad; the two crossed gradients then wash white into it
// (saturation axis) and black over it (value axis).
const hueColor = computed(() => `hsl(${hue.value}, 100%, 50%)`);
const svBackground = computed(() => ({
  backgroundColor: hueColor.value,
  backgroundImage: 'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)',
}));

const svThumbStyle = computed(() => ({
  left: `${saturation.value * 100}%`,
  top: `${(1 - brightness.value) * 100}%`,
}));

const hueThumbStyle = computed(() => ({
  left: `${(hue.value / 360) * 100}%`,
}));

const presets = PROVIDER_META.map(m => m.tone);
const uniquePresets = computed(() => [...new Set(presets)] as UpstreamColorPreset[]);
const kindDefaultTone = computed(() => providerMeta(props.kind).tone);
</script>

<template>
  <div class="flex flex-col gap-3">
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

    <div v-if="customMode" class="flex flex-col gap-2">
      <!-- Saturation / value pad. Backed by the current hue as a solid
           colour; a white-to-transparent horizontal wash pulls the
           saturation axis in, a black-to-transparent vertical wash lays
           the value axis on top. -->
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

      <!-- Hue strip. Rainbow gradient sits under a thin marker that
           tracks the current hue's horizontal position. -->
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
          :color="isHex(model) ? model : (HEX_RE.test(hexDraft) ? (hexDraft as UpstreamColor) : null)"
          variant="badge"
          size="sm"
          show-label
        />
      </div>
    </div>
  </div>
</template>
