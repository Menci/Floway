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
// without the badge frame.
const TONE_CLASSES: Record<UpstreamColorPreset, { badge: string; swatch: string; text: string }> = {
  amber: {
    badge: 'border-accent-amber/30 bg-accent-amber/10 text-accent-amber',
    swatch: 'bg-accent-amber/15 text-accent-amber',
    text: 'text-accent-amber',
  },
  emerald: {
    badge: 'border-accent-emerald/30 bg-accent-emerald/10 text-accent-emerald',
    swatch: 'bg-accent-emerald/15 text-accent-emerald',
    text: 'text-accent-emerald',
  },
  cyan: {
    badge: 'border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan',
    swatch: 'bg-accent-cyan/15 text-accent-cyan',
    text: 'text-accent-cyan',
  },
  violet: {
    badge: 'border-accent-violet/30 bg-accent-violet/10 text-accent-violet',
    swatch: 'bg-accent-violet/15 text-accent-violet',
    text: 'text-accent-violet',
  },
  rose: {
    badge: 'border-accent-rose/30 bg-accent-rose/10 text-accent-rose',
    swatch: 'bg-accent-rose/15 text-accent-rose',
    text: 'text-accent-rose',
  },
  orange: {
    badge: 'border-accent-orange/30 bg-accent-orange/10 text-accent-orange',
    swatch: 'bg-accent-orange/15 text-accent-orange',
    text: 'text-accent-orange',
  },
};

type UpstreamColorResolved =
  | { mode: 'class'; badgeClass: string; swatchClass: string; textClass: string }
  | { mode: 'style'; badgeStyle: Record<string, string>; swatchStyle: Record<string, string>; textStyle: Record<string, string> };

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
  };
};
