import type {
  IRInputAssistantItem,
  IRInputCustomToolCallItem,
  IRInputFunctionCallItem,
  IRInputPromptItem,
  IRInputToolResultItem,
  IRInputUserMessageItem,
} from './types.ts';

// A conversation whose calls and results all state the call they answer.
//
// The input model leaves `call_id` optional because a source may not state one,
// but a target's wire correlates every result by id. A target fills the missing
// ones before writing, and this is the shape it holds afterwards — so a writer
// reads the id without re-checking what the filling already established.
export type IRInputTurnWithCallIds = IRInputClientTurnWithCallIds | IRInputAssistantTurnWithCallIds;
export interface IRInputClientTurnWithCallIds {
  readonly kind: 'client';
  readonly items: readonly IRInputClientItemWithCallIds[];
}
export interface IRInputAssistantTurnWithCallIds {
  readonly kind: 'assistant';
  readonly items: readonly IRInputAssistantItemWithCallIds[];
}
export type IRInputClientItemWithCallIds = IRInputPromptItem | IRInputUserMessageItem | IRInputToolResultItemWithCallId;
export type IRInputToolResultItemWithCallId = IRInputToolResultItem & { readonly call_id: string };
export type IRInputAssistantItemWithCallIds =
  | Exclude<IRInputAssistantItem, IRInputFunctionCallItem | IRInputCustomToolCallItem>
  | (IRInputFunctionCallItem & { readonly call_id: string })
  | (IRInputCustomToolCallItem & { readonly call_id: string });
