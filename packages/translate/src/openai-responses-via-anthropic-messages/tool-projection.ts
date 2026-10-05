import type { NamespaceToolNames } from '../shared/openai-responses-via/namespace-tools.ts';

export type AnthropicMessagesCallableProjection =
  | { kind: 'custom-tool' }
  | { kind: 'root-schema-envelope' };

export interface AnthropicMessagesToolProjection {
  // Source identities drive replay conversion; target names drive response
  // conversion after allowed_tools has selected one wire-visible callable.
  sourceCallables: Map<`function:${string}`, Extract<AnthropicMessagesCallableProjection, { kind: 'root-schema-envelope' }>>;
  targetCallables: Map<string, AnthropicMessagesCallableProjection>;
  namespaces: NamespaceToolNames;
}

export const sourceFunctionKey = (name: string): `function:${string}` => `function:${name}`;

const emptyNamespaceToolNames = (): NamespaceToolNames => ({
  sourceToTarget: new Map(),
  targetToSource: new Map(),
  sourceTools: undefined,
  sourceToolChoice: undefined,
  toolsChanged: false,
  toolChoiceChanged: false,
});

export const createAnthropicMessagesToolProjection = (
  namespaces: NamespaceToolNames = emptyNamespaceToolNames(),
): AnthropicMessagesToolProjection => ({ sourceCallables: new Map(), targetCallables: new Map(), namespaces });
