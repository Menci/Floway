import type { ChatOperation, ChatRequestFacts, ChatResponseFacts } from '../../chat/pipeline/facts.ts';
import type { AttemptTarget } from '../../pipeline/facts.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { factSpace } from '@floway-dev/pipeline';

type CompactAttemptTarget = AttemptTarget<'openaiResponsesCompact'> & { readonly operation: ChatOperation };
type CompactRequestFacts = ChatRequestFacts & { compactTargets: readonly CompactAttemptTarget[] };

export const { defineStage, compose } = factSpace<CompactRequestFacts, ChatResponseFacts, GatewayServices>();
