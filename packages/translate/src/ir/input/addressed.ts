import type {
  IRInputAssistantItem,
  IRInputCustomToolCallItem,
  IRInputFunctionCallItem,
  IRInputPromptItem,
  IRInputToolResultItem,
  IRInputUserMessageItem,
} from './types.ts';

// A conversation whose calls and results all name the call they answer.
//
// The input model leaves `call_id` optional because a source may not state one,
// but a target's wire correlates every result by id. A target fills the missing
// ones before writing, and this is the shape it holds afterwards — so a writer
// reads the id without re-checking what the filling already established.
//
// A call the wire states without an id of its own is the exception: Chat
// Completions' legacy `function_call` carries a name and nothing else, and no
// step since then could have invented one the client would ever echo back. Its
// answer therefore names no id either and carries the call's name, which is the
// only thing that pairs the two on that wire.
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
// The id is absent only when the call it answers has none either; `name` then
// states the pairing instead.
export type IRInputAddressedToolResultItem = Omit<IRInputToolResultItem, 'call_id'> & (
  | { readonly call_id: string }
  | { readonly call_id?: undefined; readonly name: string }
);
export type IRInputAddressedAssistantItem =
  | Exclude<IRInputAssistantItem, IRInputFunctionCallItem | IRInputCustomToolCallItem>
  | (IRInputFunctionCallItem & { readonly call_id: string })
  | (IRInputCustomToolCallItem & { readonly call_id: string });
