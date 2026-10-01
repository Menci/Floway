import type { TokenCountAnswer } from '../../anthropic-messages/count-tokens/facts.ts';
import type { GeminiGenerateContentFacts } from '../facts.ts';

export type Counted<K extends 'response.chat.geminiGenerateContent' | 'response.chat.anthropicMessages'> = { [P in K]: TokenCountAnswer };

export type Fields<K extends keyof GeminiGenerateContentFacts> = { [P in K]: GeminiGenerateContentFacts[P] };

export type GeminiGenerateContentCountTokensEntry = Fields<
  'ingress.http.headers' | 'ingress.chat.sourceProtocol' | 'request.chat.geminiGenerateContent' | 'serve.model'
>;

export type GeminiGenerateContentCountTokensExit = Fields<
  'response.chat.geminiGenerateContent.rendered' | 'response.http.status' | 'response.http.jsonBody' | 'response.http.headers'
>;
