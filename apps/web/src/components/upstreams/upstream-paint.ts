import type { UpstreamColorPreset, UpstreamProviderKind } from '../../api/types';

export const KIND_DEFAULT_TONES: Record<UpstreamProviderKind, UpstreamColorPreset> = {
  custom: 'amber',
  azure: 'emerald',
  copilot: 'cyan',
  codex: 'violet',
  'claude-code': 'orange',
  ollama: 'rose',
};
