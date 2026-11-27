import { stripAnthropicMessagesBilling } from './billing-attribution.ts';
import { normalizeAnthropicMessagesToolChoice } from './empty-tools-tool-choice.ts';
import { disableAnthropicMessagesForcedToolReasoning } from './reasoning-tool-choice.ts';

export const anthropicMessagesBodyStages = [
  stripAnthropicMessagesBilling,
  disableAnthropicMessagesForcedToolReasoning,
  normalizeAnthropicMessagesToolChoice,
] as const;
