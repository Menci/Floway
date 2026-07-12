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

// Class-string table for the preset branch. UnoCSS scans this source file so
// every entry stays statically visible and survives purge. A separate `text`
// variant covers name-only surfaces (e.g. RequestList) that need color
// without the badge frame. `chip` is a saturated fill for the picker's
// preset swatches — brighter than `swatch` (a subtle tinted background
// under icons) but shy of full-saturation `text`, so the disc reads as
// the tone itself rather than as "some element tinted by this tone".
const TONE_CLASSES: Record<UpstreamColorPreset, { badge: string; swatch: string; text: string; chip: string }> = {
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

type UpstreamColorResolved =
  | { mode: 'class'; badgeClass: string; swatchClass: string; textClass: string; chipClass: string }
  | {
    mode: 'style';
    badgeStyle: Record<string, string>;
    swatchStyle: Record<string, string>;
    textStyle: Record<string, string>;
    chipStyle: Record<string, string>;
  };

// Rebuild the translucent-bg + border + text look from a raw hex using
// `color-mix()`. Widely supported since 2023 (Chrome 111, Safari 16.2,
// Firefox 113). CSS custom property indirection keeps the templates DRY.
const styleFor = (hex: string): Extract<UpstreamColorResolved, { mode: 'style' }> => ({
  mode: 'style',
  badgeStyle: {
    '--u-color': hex,
    color: 'var(--u-color)',
    borderColor: 'color-mix(in srgb, var(--u-color) 30%, transparent)',
    backgroundColor: 'color-mix(in srgb, var(--u-color) 10%, transparent)',
  },
  swatchStyle: {
    '--u-color': hex,
    color: 'var(--u-color)',
    backgroundColor: 'color-mix(in srgb, var(--u-color) 15%, transparent)',
  },
  textStyle: {
    color: hex,
  },
  chipStyle: {
    '--u-color': hex,
    backgroundColor: 'color-mix(in srgb, var(--u-color) 60%, transparent)',
  },
});

export const resolveUpstreamColor = (input: {
  kind: UpstreamProviderKind;
  color: UpstreamColor | null;
}): UpstreamColorResolved => {
  const raw = input.color;
  if (raw?.startsWith('#')) return styleFor(raw);
  const preset: UpstreamColorPreset = raw === null ? KIND_DEFAULT_TONES[input.kind] : (raw as UpstreamColorPreset);
  const classes = TONE_CLASSES[preset];
  return {
    mode: 'class',
    badgeClass: classes.badge,
    swatchClass: classes.swatch,
    textClass: classes.text,
    chipClass: classes.chip,
  };
};
