// Rendering technique (Uno class tables, hex `color-mix()`, kind→tone
// fallback) lives in `upstream-paint.ts` — this module is UI-technique
// agnostic so a rewrite of the theming layer does not touch brand
// metadata.
//
// Iconify classes resolve via UnoCSS preset-icons (see uno.config.ts);
// brand marks from simple-icons, generic `custom` from lucide.

import type { UpstreamProviderKind } from '../../api/types.ts';

export interface ProviderMeta {
  kind: UpstreamProviderKind;
  label: string;
  subtitle: string;
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
    defaultName: 'Custom upstream',
    icon: 'i-lucide-server',
  },
  {
    kind: 'azure',
    label: 'Azure',
    subtitle: 'Azure OpenAI / Foundry',
    defaultName: 'Azure AI',
    icon: 'i-simple-icons-microsoftazure',
  },
  {
    kind: 'copilot',
    label: 'Copilot',
    subtitle: 'GitHub Copilot account',
    defaultName: 'GitHub Copilot',
    icon: 'i-simple-icons-githubcopilot',
  },
  {
    kind: 'codex',
    label: 'Codex',
    subtitle: 'ChatGPT Plus / Pro / Team',
    defaultName: 'ChatGPT Codex',
    icon: 'i-simple-icons-openai',
  },
  {
    kind: 'claude-code',
    label: 'Claude Code',
    subtitle: 'Claude Pro / Max / Team subscription',
    defaultName: 'Claude Code',
    icon: 'i-simple-icons-claudecode',
  },
  {
    kind: 'ollama',
    label: 'Ollama',
    subtitle: 'ollama.com or self-hosted',
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
