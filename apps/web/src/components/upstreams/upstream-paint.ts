import type { UpstreamColor, UpstreamColorPreset, UpstreamProviderKind } from '../../api/types.ts';

// Kind default tone — the fallback the resolver picks when a row has no
// `color` override. Kept here (paint layer) rather than on the identity
// `ProviderMeta` struct so `provider-meta.ts` stays UI-technique
// agnostic. Anthropic's brand coral for claude-code keeps its chip
// distinct from the rose-toned Ollama chip stacked next to it.
export const KIND_DEFAULT_TONES: Record<UpstreamProviderKind, UpstreamColorPreset> = {
  custom: 'amber',
  azure: 'emerald',
  copilot: 'cyan',
  codex: 'violet',
  'claude-code': 'orange',
  ollama: 'rose',
};

type Slot = 'badge' | 'swatch' | 'text' | 'chip';

// Opacity percentages twinned with the `/NN` suffixes in TONE_CLASSES.
// UnoCSS purge requires the class strings to be literal, so a change to
// any constant here must be paired with a matching `/NN` edit in every
// TONE_CLASSES entry below.
const BADGE_BORDER_PCT = 30;
const BADGE_BG_PCT = 10;
const SWATCH_BG_PCT = 15;
const CHIP_BG_PCT = 60;

// Class-string table for the preset branch. UnoCSS scans this source file so
// every entry stays statically visible and survives purge. A separate `text`
// variant covers name-only surfaces (e.g. RequestList) that need color
// without the badge frame. `chip` is a saturated fill for the picker's
// preset swatches — brighter than `swatch` (a subtle tinted background
// under icons) but shy of full-saturation `text`, so the disc reads as
// the tone itself rather than as "some element tinted by this tone".
const TONE_CLASSES: Record<UpstreamColorPreset, Record<Slot, string>> = {
  amber: {
    badge: 'border-accent-amber/30 bg-accent-amber/10 text-accent-amber',
    swatch: 'bg-accent-amber/15 text-accent-amber',
    text: 'text-accent-amber',
    chip: 'bg-accent-amber/60',
  },
  emerald: {
    badge: 'border-accent-emerald/30 bg-accent-emerald/10 text-accent-emerald',
    swatch: 'bg-accent-emerald/15 text-accent-emerald',
    text: 'text-accent-emerald',
    chip: 'bg-accent-emerald/60',
  },
  cyan: {
    badge: 'border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan',
    swatch: 'bg-accent-cyan/15 text-accent-cyan',
    text: 'text-accent-cyan',
    chip: 'bg-accent-cyan/60',
  },
  violet: {
    badge: 'border-accent-violet/30 bg-accent-violet/10 text-accent-violet',
    swatch: 'bg-accent-violet/15 text-accent-violet',
    text: 'text-accent-violet',
    chip: 'bg-accent-violet/60',
  },
  rose: {
    badge: 'border-accent-rose/30 bg-accent-rose/10 text-accent-rose',
    swatch: 'bg-accent-rose/15 text-accent-rose',
    text: 'text-accent-rose',
    chip: 'bg-accent-rose/60',
  },
  orange: {
    badge: 'border-accent-orange/30 bg-accent-orange/10 text-accent-orange',
    swatch: 'bg-accent-orange/15 text-accent-orange',
    text: 'text-accent-orange',
    chip: 'bg-accent-orange/60',
  },
};

export type UpstreamColorResolved =
  | { mode: 'class'; classes: Record<Slot, string> }
  | { mode: 'style'; styles: Record<Slot, Record<string, string>> };

// Rebuild the translucent-bg + border + text look from a raw hex using
// `color-mix()`. Widely supported since 2023 (Chrome 111, Safari 16.2,
// Firefox 113). CSS custom property indirection keeps the templates DRY.
const mix = (pct: number): string =>
  `color-mix(in srgb, var(--u-color) ${pct}%, transparent)`;

const styleFor = (hex: string): Extract<UpstreamColorResolved, { mode: 'style' }> => ({
  mode: 'style',
  styles: {
    badge: {
      '--u-color': hex,
      color: 'var(--u-color)',
      borderColor: mix(BADGE_BORDER_PCT),
      backgroundColor: mix(BADGE_BG_PCT),
    },
    swatch: {
      '--u-color': hex,
      color: 'var(--u-color)',
      backgroundColor: mix(SWATCH_BG_PCT),
    },
    text: {
      color: hex,
    },
    chip: {
      '--u-color': hex,
      backgroundColor: mix(CHIP_BG_PCT),
    },
  },
});

export const resolveUpstreamColor = (input: {
  kind: UpstreamProviderKind;
  color: UpstreamColor | null;
}): UpstreamColorResolved => {
  const raw = input.color;
  if (raw?.startsWith('#')) return styleFor(raw);
  const preset: UpstreamColorPreset = raw === null ? KIND_DEFAULT_TONES[input.kind] : (raw as UpstreamColorPreset);
  return { mode: 'class', classes: TONE_CLASSES[preset] };
};
