import type { ChatGPTUpstream } from '../config.ts';
import type { ChatGPTServices } from '../service.ts';
import type { ChatGPTResponsesIdentity } from './openai-responses/request.ts';
import { factSpace } from '@floway-dev/pipeline';
import type { GatewayFacts, HttpTerminalFacts, ProviderResponseFacts } from '@floway-dev/provider';

export type ChatGPTFacts = Omit<GatewayFacts, 'provider.upstream' | 'response.openaiResponses'> & ProviderResponseFacts<'openaiResponses'> & HttpTerminalFacts & {
  'provider.upstream': ChatGPTUpstream;
  'request.chatgptResponsesIdentity': ChatGPTResponsesIdentity;
};

export const chatgptFactSpace = factSpace<ChatGPTFacts, ChatGPTServices>();
