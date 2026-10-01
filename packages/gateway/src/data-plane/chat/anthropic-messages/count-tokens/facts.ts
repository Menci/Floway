import type { Failure } from '../../../pipeline/facts.ts';
import type { AnthropicMessagesFacts } from '../facts.ts';

/** What a measurement hands up. It rides at a protocol's own response key — which is what
 *  lets the request rules generation runs be the same stages here — and the arm is narrowed
 *  because nothing in a counting chain opens a stream. */
export type TokenCountAnswer = { readonly kind: 'value'; readonly body: unknown } | Failure;

export type Counted<K extends 'response.chat.anthropicMessages'> = { [P in K]: TokenCountAnswer };

export type Fields<K extends keyof AnthropicMessagesFacts> = { [P in K]: AnthropicMessagesFacts[P] };

export type AnthropicMessagesCountTokensEntry = Fields<
  'ingress.http.headers' | 'ingress.chat.sourceProtocol' | 'request.chat.anthropicMessages' | 'serve.model'
>;

export type AnthropicMessagesCountTokensExit = Fields<
  'response.chat.anthropicMessages.rendered' | 'response.http.status' | 'response.http.jsonBody' | 'response.http.headers'
>;
