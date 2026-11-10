import type {
  IRInputAssistantItem,
  IRInputCustomToolCallItem,
  IRInputFunctionCallItem,
  IRInputPromptItem,
  IRInputToolResultItem,
  IRInputUserMessageItem,
} from './types.ts';

// A conversation whose calls and results all state their ids.
//
// The input model leaves `call_id` optional because a source may not state one,
// but a target's wire correlates every result by id. A target fills the missing
// ones before writing, and this is the shape it holds afterwards — so a writer
// reads the id without re-checking what the filling already established.
export type IRInputAddressedTurn = IRInputAddressedClientTurn | IRInputAddressedAssistantTurn;
export interface IRInputAddressedClientTurn {
  readonly kind: 'client';
  readonly items: readonly IRInputAddressedClientItem[];
}
export interface IRInputAddressedAssistantTurn {
  readonly kind: 'assistant';
  readonly items: readonly IRInputAddressedAssistantItem[];
}
export type IRInputAddressedClientItem = IRInputPromptItem | IRInputUserMessageItem | IRInputAddressedToolResultItem;
export type IRInputAddressedToolResultItem = IRInputToolResultItem & { readonly call_id: string };
export type IRInputAddressedAssistantItem =
  | Exclude<IRInputAssistantItem, IRInputFunctionCallItem | IRInputCustomToolCallItem>
  | (IRInputFunctionCallItem & { readonly call_id: string })
  | (IRInputCustomToolCallItem & { readonly call_id: string });
