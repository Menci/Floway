import type { CopilotServices } from '../service.ts';
import { factSpace } from '@floway-dev/pipeline';
import type { UpstreamHttpResponseFacts, UpstreamRequestFacts, UpstreamResponseFacts } from '@floway-dev/upstream';

type CopilotRequestFacts = UpstreamRequestFacts & { 'copilot.modelId': string };
type CopilotResponseFacts = UpstreamResponseFacts & UpstreamHttpResponseFacts;

export const { defineStage: defineCopilotStage, compose: composeCopilot } = factSpace<CopilotRequestFacts, CopilotResponseFacts, CopilotServices>();
