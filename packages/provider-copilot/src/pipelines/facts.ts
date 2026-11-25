import type { CopilotServices } from '../service.ts';
import { factSpace } from '@floway-dev/pipeline';
import type { GatewayFacts, ProviderOperation, ProviderOperationFacts, ProviderTransportFacts } from '@floway-dev/provider';

export type CopilotFacts = GatewayFacts & ProviderTransportFacts & {
  readonly 'copilot.modelId': string;
};

export const { defineStage: defineCopilotStage } = factSpace<CopilotFacts, CopilotServices>();

export const copilotOperation = <Operation extends ProviderOperation>() =>
  factSpace<CopilotFacts & ProviderOperationFacts<Operation>, CopilotServices>();
