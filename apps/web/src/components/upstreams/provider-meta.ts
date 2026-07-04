// Single source of truth for per-provider SPA rendering: label, dropdown subtitle, accent tone, default name suggestion, and iconify class.
// Iconify classes resolve via UnoCSS preset-icons (see uno.config.ts); brand marks from simple-icons, generic `custom` from lucide.

import type { UpstreamProviderKind } from '../../api/types.ts';

export type ProviderTone = 'amber' | 'emerald' | 'cyan' | 'violet' | 'rose' | 'orange';

export interface ProviderMeta {
  kind: UpstreamProviderKind;
  label: string;
  subtitle: string;
  tone: ProviderTone;
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
    kind: 'cursor',
    label: 'Cursor',
    subtitle: 'Cursor Pro / Business subscription',
    tone: 'violet',
    defaultName: 'Cursor',
    icon: 'i-simple-icons-cursor',
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

const TONE_CLASSES: Record<ProviderTone, { badge: string; swatch: string }> = {
  amber: {
    badge: 'border-accent-amber/30 bg-accent-amber/10 text-accent-amber',
    swatch: 'bg-accent-amber/15 text-accent-amber',
  },
  emerald: {
    badge: 'border-accent-emerald/30 bg-accent-emerald/10 text-accent-emerald',
    swatch: 'bg-accent-emerald/15 text-accent-emerald',
  },
  cyan: {
    badge: 'border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan',
    swatch: 'bg-accent-cyan/15 text-accent-cyan',
  },
  violet: {
    badge: 'border-accent-violet/30 bg-accent-violet/10 text-accent-violet',
    swatch: 'bg-accent-violet/15 text-accent-violet',
  },
  rose: {
    badge: 'border-accent-rose/30 bg-accent-rose/10 text-accent-rose',
    swatch: 'bg-accent-rose/15 text-accent-rose',
  },
  orange: {
    badge: 'border-accent-orange/30 bg-accent-orange/10 text-accent-orange',
    swatch: 'bg-accent-orange/15 text-accent-orange',
  },
};

export const providerBadgeClass = (kind: UpstreamProviderKind): string =>
  TONE_CLASSES[providerMeta(kind).tone].badge;

export const providerSwatchClass = (kind: UpstreamProviderKind): string =>
  TONE_CLASSES[providerMeta(kind).tone].swatch;
