export type ChatDelivery =
  | {
    readonly kind: 'openaiChatCompletions';
    readonly stream: boolean;
    readonly includeUsageChunk: boolean;
    readonly expectedChoices: number;
  }
  | {
    readonly kind: 'openaiResponses';
    readonly stream: boolean;
    readonly createdAt: number;
  }
  | { readonly kind: 'anthropicMessages'; readonly stream: boolean }
  | { readonly kind: 'geminiGenerateContent'; readonly stream: boolean };
