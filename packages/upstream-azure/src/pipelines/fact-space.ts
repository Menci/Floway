import { factSpace } from '@floway-dev/pipeline';
import type { UpstreamHttpResponseFacts, UpstreamHttpServices, UpstreamRequestFacts, UpstreamResponseFacts } from '@floway-dev/upstream';

export const { compose, defineStage } = factSpace<UpstreamRequestFacts, UpstreamResponseFacts & UpstreamHttpResponseFacts, UpstreamHttpServices>();
