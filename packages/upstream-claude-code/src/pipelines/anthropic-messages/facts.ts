import type { ClaudeCodeServices } from '../../service.ts';
import { factSpace } from '@floway-dev/pipeline';
import type { UpstreamHttpResponseFacts, UpstreamRequest, UpstreamResponseFacts } from '@floway-dev/upstream';

type Request = UpstreamRequest<'anthropicMessages'> & { 'claudeCode.shaped': boolean };
type Response = Pick<UpstreamResponseFacts, 'anthropicMessages'> & UpstreamHttpResponseFacts;

export const { defineStage, compose } = factSpace<Request, Response, ClaudeCodeServices>();
