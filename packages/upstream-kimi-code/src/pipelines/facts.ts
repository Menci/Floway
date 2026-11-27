import type { KimiCodeService } from '../probe.ts';
import { factSpace } from '@floway-dev/pipeline';
import type { UpstreamHttpResponseFacts, UpstreamHttpServices, UpstreamRequestFacts, UpstreamResponseFacts } from '@floway-dev/upstream';

export interface KimiCodePipelineServices extends UpstreamHttpServices {
  readonly kimiCode: KimiCodeService;
}

export const { defineStage, compose } = factSpace<UpstreamRequestFacts, UpstreamResponseFacts & UpstreamHttpResponseFacts, KimiCodePipelineServices>();
