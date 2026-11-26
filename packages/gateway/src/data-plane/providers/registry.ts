import type { FlagDefaults, Provider, ProviderModule, UpstreamProviderKind, UpstreamRecord } from '@floway-dev/provider';
import { azureProviderModule } from '@floway-dev/provider-azure';
import { chatgptProviderModule } from '@floway-dev/provider-chatgpt';
import { claudeCodeProviderModule } from '@floway-dev/provider-claude-code';
import { copilotProviderModule } from '@floway-dev/provider-copilot';
import { customProviderModule } from '@floway-dev/provider-custom';
import { kimiCodeProviderModule } from '@floway-dev/provider-kimi-code';
import { ollamaProviderModule } from '@floway-dev/provider-ollama';

const providersByKind: Record<UpstreamProviderKind, ProviderModule> = {
  copilot: copilotProviderModule,
  custom: customProviderModule,
  azure: azureProviderModule,
  chatgpt: chatgptProviderModule,
  'claude-code': claudeCodeProviderModule,
  'kimi-code': kimiCodeProviderModule,
  ollama: ollamaProviderModule,
};

export const createProvider = (record: UpstreamRecord): Provider =>
  providersByKind[record.kind].create(record);

export const flagDefaultsForKind = (kind: UpstreamProviderKind): FlagDefaults =>
  providersByKind[kind].defaultFlags;
