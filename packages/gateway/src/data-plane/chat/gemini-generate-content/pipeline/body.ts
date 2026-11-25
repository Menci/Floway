import { geminiGenerateContentEgress } from './egress.ts';
import { geminiGenerateContentInputError } from './parse-request.ts';
import { stripSafetySettings } from './strip-safety-settings.ts';
import { stripUnsupportedPartFields } from './strip-unsupported-part-fields.ts';
import { stripUnsupportedTools } from './strip-unsupported-tools.ts';
import { suppressThoughtParts } from './suppress-thought-parts.ts';
import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { anthropicMessagesBody } from '../../anthropic-messages/pipeline/body.ts';
import { openAIChatCompletionsBody } from '../../openai-chat-completions/pipeline/body.ts';
import { openAIResponsesBody } from '../../openai-responses/pipeline/body.ts';
import { chatBodyEntry, chatBodyExit, chatBodyTargets } from '../../pipeline/topology.ts';
import { translateChat } from '../../pipeline/translate.ts';
import { routeGeminiGenerateContentViaAnthropicMessages, routeGeminiGenerateContentViaOpenAIChatCompletions, routeGeminiGenerateContentViaOpenAIResponses } from '@floway-dev/translate';

const protocol = 'geminiGenerateContent';
const { compose } = gatewayFactSpace<GatewayServices>();

const bodyTargets = chatBodyTargets(protocol, geminiGenerateContentEgress, [
  ['openaiChatCompletions', () => translateChat(protocol, 'openaiChatCompletions', routeGeminiGenerateContentViaOpenAIChatCompletions, () => openAIChatCompletionsBody, geminiGenerateContentInputError)],
  ['anthropicMessages', () => translateChat(protocol, 'anthropicMessages', routeGeminiGenerateContentViaAnthropicMessages, () => anthropicMessagesBody, geminiGenerateContentInputError)],
  ['openaiResponses', () => translateChat(protocol, 'openaiResponses', routeGeminiGenerateContentViaOpenAIResponses, () => openAIResponsesBody, geminiGenerateContentInputError)],
]);

export const servesGeminiGenerateContent = bodyTargets.serves;

export const geminiGenerateContentBody = compose('geminiGenerateContent.body', {
  entry: chatBodyEntry(protocol),
  exit: chatBodyExit(protocol),
  stages: [stripUnsupportedPartFields, stripUnsupportedTools, stripSafetySettings, suppressThoughtParts],
  ending: bodyTargets.ending,
  targets: bodyTargets.targets,
});
