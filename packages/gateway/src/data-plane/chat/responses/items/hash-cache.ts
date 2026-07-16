import { hashResponsesItemContent, hashResponsesItemEncryptedContent } from './format.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';

export interface ResponsesItemHashFunctions {
  readonly content: (item: ResponsesInputItem) => Promise<string>;
  readonly encryptedContent: (encryptedContent: string) => Promise<string>;
}

const defaultHashFunctions: ResponsesItemHashFunctions = {
  content: hashResponsesItemContent,
  encryptedContent: hashResponsesItemEncryptedContent,
};

export class ResponsesItemHashCache {
  // Serve prep hashes and stages the same source-item objects before attempts
  // can clone or mutate them. Keep identity caching on that turn-local store
  // boundary; values created inside an attempt intentionally miss this cache.
  private contentByItem = new WeakMap<ResponsesInputItem, Promise<string>>();
  private readonly encryptedByValue = new Map<string, Promise<string>>();

  constructor(private readonly functions: ResponsesItemHashFunctions = defaultHashFunctions) {}

  content(item: ResponsesInputItem): Promise<string> {
    const cached = this.contentByItem.get(item);
    if (cached !== undefined) return cached;
    const hash = this.functions.content(item);
    this.contentByItem.set(item, hash);
    return hash;
  }

  encryptedContent(value: string): Promise<string> {
    const cached = this.encryptedByValue.get(value);
    if (cached !== undefined) return cached;
    const hash = this.functions.encryptedContent(value);
    this.encryptedByValue.set(value, hash);
    return hash;
  }

  clear(): void {
    this.contentByItem = new WeakMap();
    this.encryptedByValue.clear();
  }
}
