import type { CopilotUpstream } from '../config.ts';
import type { CopilotServices } from '../service.ts';
import { factSpace } from '@floway-dev/pipeline';
import type { GatewayFacts, HttpTerminalFacts, ProviderOperation, ProviderOperationFacts } from '@floway-dev/provider';

export const { defineStage: defineCopilotStage } = factSpace<GatewayFacts & HttpTerminalFacts & { 'provider.upstream': CopilotUpstream }, CopilotServices>();

export const copilotOperation = <Op extends ProviderOperation>() =>
  factSpace<ProviderOperationFacts<Op, CopilotUpstream>, CopilotServices>();
