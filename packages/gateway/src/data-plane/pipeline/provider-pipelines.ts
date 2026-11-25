import type { GatewayServices } from './services.ts';
import { ALL_PROVIDER_KINDS, type ProviderOperation, type ProviderPipelines, type UpstreamProviderKind } from '@floway-dev/provider';
import { azurePipelines } from '@floway-dev/provider-azure';
import { chatgptPipelines } from '@floway-dev/provider-chatgpt';
import { claudeCodePipelines } from '@floway-dev/provider-claude-code';
import { copilotPipelines } from '@floway-dev/provider-copilot';
import { customPipelines } from '@floway-dev/provider-custom';
import { kimiCodePipelines } from '@floway-dev/provider-kimi-code';
import { ollamaPipelines } from '@floway-dev/provider-ollama';

const pipelinesByKind = {
  azure: azurePipelines,
  chatgpt: chatgptPipelines,
  'claude-code': claudeCodePipelines,
  copilot: copilotPipelines,
  custom: customPipelines,
  'kimi-code': kimiCodePipelines,
  ollama: ollamaPipelines,
} as const satisfies Record<UpstreamProviderKind, ProviderPipelines<GatewayServices, never>>;

export const providerSupportsOperation = (kind: UpstreamProviderKind, operation: ProviderOperation): boolean =>
  Object.hasOwn(pipelinesByKind[kind], operation);

export type ProviderKindsFor<Op extends ProviderOperation> = {
  [Kind in UpstreamProviderKind]: Op extends keyof typeof pipelinesByKind[Kind] ? Kind : never;
}[UpstreamProviderKind];

type Target<Op extends ProviderOperation> = NonNullable<ProviderPipelines<GatewayServices, never>[Op]>;

export const providerTargets = <Op extends ProviderOperation>(operation: Op): Record<ProviderKindsFor<Op>, Target<Op>> => {
  const registry: Record<UpstreamProviderKind, ProviderPipelines<GatewayServices, never>> = pipelinesByKind;
  return Object.fromEntries(ALL_PROVIDER_KINDS.flatMap(kind => {
    const handle = registry[kind][operation];
    return handle === undefined ? [] : [[kind, handle] as const];
  })) as Record<ProviderKindsFor<Op>, Target<Op>>;
};
