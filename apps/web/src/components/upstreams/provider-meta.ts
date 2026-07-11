// Single source of truth for per-provider SPA rendering: label, dropdown subtitle, kind default tone, default name suggestion, and iconify class.
// Iconify classes resolve via UnoCSS preset-icons (see uno.config.ts); brand marks from simple-icons, generic `custom` from lucide.

import type { UpstreamColor, UpstreamColorPreset, UpstreamProviderKind } from '../../api/types.ts';

export interface ProviderMeta {
  kind: UpstreamProviderKind;
  label: string;
  subtitle: string;
  // Kind default tone. A row's own `color` field overrides this via
  // `resolveUpstreamColor`; the resolver falls back here when `color === null`.
  tone: UpstreamColorPreset;
  defaultName: string;
  // Iconify class — e.g. `i-simple-icons-openai` or `i-lucide-server`.
  // Consumers append their own `size-N` sibling class.
  icon: string;
}

export const PROVIDER_META: readonly ProviderMeta[] = [
  {
    kind: 'custom',
    label: 'Custom',
    subtitle: 'OpenAI- or Anthropic-compatible endpoint',
    tone: 'amber',
    defaultName: 'Custom upstream',
    icon: 'i-lucide-server',
  },
  {
    kind: 'azure',
    label: 'Azure',
    subtitle: 'Azure OpenAI / Foundry',
    tone: 'emerald',
    defaultName: 'Azure AI',
    icon: 'i-simple-icons-microsoftazure',
  },
  {
    kind: 'copilot',
    label: 'Copilot',
    subtitle: 'GitHub Copilot account',
    tone: 'cyan',
    defaultName: 'GitHub Copilot',
    icon: 'i-simple-icons-githubcopilot',
  },
  {
    kind: 'codex',
    label: 'Codex',
    subtitle: 'ChatGPT Plus / Pro / Team',
    tone: 'violet',
    defaultName: 'ChatGPT Codex',
    icon: 'i-simple-icons-openai',
  },
  {
    kind: 'claude-code',
    label: 'Claude Code',
    subtitle: 'Claude Pro / Max / Team subscription',
    // Anthropic's brand coral keeps the Claude Code chip distinct from
    // the rose-toned Ollama chip stacked next to it in the dropdown.
    tone: 'orange',
    defaultName: 'Claude Code',
    icon: 'i-simple-icons-claudecode',
  },
  {
    kind: 'ollama',
    label: 'Ollama',
    subtitle: 'ollama.com or self-hosted',
    tone: 'rose',
    defaultName: 'Ollama',
    icon: 'i-simple-icons-ollama',
  },
];

const PROVIDER_META_BY_KIND = new Map<UpstreamProviderKind, ProviderMeta>(
  PROVIDER_META.map(m => [m.kind, m]),
);

export const providerMeta = (kind: UpstreamProviderKind): ProviderMeta => {
  const m = PROVIDER_META_BY_KIND.get(kind);
  if (!m) throw new Error(`Unknown UpstreamProviderKind: ${String(kind)}`);
  return m;
};

// Class-string table for the preset branch. UnoCSS scans this source file so
// every entry stays statically visible and survives purge. A separate `text`
// variant covers name-only surfaces (e.g. RequestList) that need color
// without the badge frame.
export const TONE_CLASSES: Record<UpstreamColorPreset, { badge: string; swatch: string; text: string }> = {
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

export type UpstreamColorResolved =
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

// Resolve an upstream's badge color into either a class-string bundle (preset
// branch) or an inline-style bundle (raw HEX branch). `color === null` falls
// back to the kind default from `PROVIDER_META`.
export const resolveUpstreamColor = (input: {
  kind: UpstreamProviderKind;
  color: UpstreamColor | null;
}): UpstreamColorResolved => {
  const raw = input.color;
  if (raw !== null && raw.startsWith('#')) return styleFor(raw);
  const preset: UpstreamColorPreset = raw === null ? providerMeta(input.kind).tone : (raw as UpstreamColorPreset);
  const classes = TONE_CLASSES[preset];
  return {
    mode: 'class',
    badgeClass: classes.badge,
    swatchClass: classes.swatch,
    textClass: classes.text,
  };
};

// Kind-default class-string helpers preserved for the few call sites that
// render an upstream badge with no persisted record in hand (create-page
// blueprint before Save, iconography-only surfaces). Anything holding a real
// `UpstreamRecord` should go through `<UpstreamBadge>` instead.
export const providerBadgeClass = (kind: UpstreamProviderKind): string => {
  const resolved = resolveUpstreamColor({ kind, color: null });
  return resolved.mode === 'class' ? resolved.badgeClass : '';
};

export const providerSwatchClass = (kind: UpstreamProviderKind): string => {
  const resolved = resolveUpstreamColor({ kind, color: null });
  return resolved.mode === 'class' ? resolved.swatchClass : '';
};
