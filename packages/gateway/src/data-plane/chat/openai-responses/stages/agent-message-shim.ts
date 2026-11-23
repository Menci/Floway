import { responsesInputShim } from './input-shim.ts';
import { agentMessageContent } from '../items/agent-message-content.ts';

// A user-role carrier preserves the distinction between an agent and the user.
// https://github.com/openai/codex/blob/0a2eb4696c26ac33204bcd255721ab30220a4774/codex-rs/protocol/src/models.rs#L1036-L1046
export const agentMessageShim = responsesInputShim('agentMessageShim', 'openai-responses-agent-message-shim', item =>
  item.type === 'agent_message' ? { type: 'message', role: 'user', content: agentMessageContent(item) } : item);
