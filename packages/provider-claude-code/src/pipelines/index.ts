import type { ClaudeCodeServices } from '../service.ts';
import { anthropicMessages } from './anthropic-messages/index.ts';
import type { ProviderPipelines } from '@floway-dev/provider';

export const claudeCodePipelines = { anthropicMessages } satisfies ProviderPipelines<ClaudeCodeServices>;
