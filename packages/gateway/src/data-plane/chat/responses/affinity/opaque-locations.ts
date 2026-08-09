import type {
  ResponsesEncryptedContent,
  ResponsesInputItem,
  ResponsesOutputItem,
  ResponsesToolOutputContent,
} from '@floway-dev/protocols/responses';

type ResponsesItem = ResponsesInputItem | ResponsesOutputItem;

export interface ResponsesOpaqueLocation {
  readonly key: string;
  readonly value: string;
  readonly domain: string;
  readonly required: boolean;
}

export interface ResponsesCarrierSlot {
  readonly key: string;
  readonly domain: string;
}

// A slot addresses either a property on the item or one `encrypted_content`
// element of a content array. An element path whose index equals the array
// length addresses the append position, which is how an item that carries no
// opaque value of its own grows one.
type SlotPath = readonly [property: string] | readonly [property: string, index: number];

interface CarrierSlot {
  readonly key: string;
  readonly domain: string;
  readonly required: boolean;
  readonly path: SlotPath;
  readonly value?: string;
}

const canonicalItemType = (itemType: string): string =>
  itemType === 'compaction_summary' ? 'compaction' : itemType;

export const responsesCarrierDomain = (itemType: string, slot: string): string =>
  `responses.${canonicalItemType(itemType)}.${slot}`;

// Item types whose affinity carrier is a top-level `encrypted_content`, listed
// so an item that arrives without one can still be grown into a carrier.
const ENCRYPTED_CONTENT_ITEM_TYPES = new Set(['reasoning', 'compaction', 'compaction_summary', 'context_compaction']);

const agentMessageContent = (item: ResponsesItem): readonly unknown[] | undefined =>
  item.type === 'agent_message' && Array.isArray(item.content) ? item.content : undefined;

const toolOutput = (item: ResponsesItem): readonly ResponsesToolOutputContent[] | undefined => {
  if (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') return undefined;
  return Array.isArray(item.output) ? item.output : undefined;
};

const encryptedContentElements = (item: ResponsesItem): { property: string; elements: readonly unknown[]; required: boolean } | undefined => {
  const content = agentMessageContent(item);
  if (content !== undefined) return { property: 'content', elements: content, required: false };
  const output = toolOutput(item);
  if (output !== undefined) return { property: 'output', elements: output, required: true };
  return undefined;
};

const encryptedContentValue = (element: unknown): string | undefined =>
  typeof element === 'object'
  && element !== null
  && (element as { type?: unknown }).type === 'encrypted_content'
  && typeof (element as { encrypted_content?: unknown }).encrypted_content === 'string'
    ? (element as ResponsesEncryptedContent).encrypted_content
    : undefined;

// The single enumeration of every place a Responses item can carry affinity.
// Reading, rewriting and growing a carrier all derive from this list, so a slot
// cannot be added or dropped on one side alone.
const carrierSlots = (item: ResponsesItem): CarrierSlot[] => {
  const slots: CarrierSlot[] = [];
  const slot = (key: string, path: SlotPath, value: string | undefined, required: boolean): void => {
    slots.push({ key, path, domain: responsesCarrierDomain(item.type, key), required, ...(value !== undefined ? { value } : {}) });
  };

  const encryptedContent = (item as unknown as Record<string, unknown>).encrypted_content;
  if (typeof encryptedContent === 'string') slot('encrypted_content', ['encrypted_content'], encryptedContent, false);
  else if (ENCRYPTED_CONTENT_ITEM_TYPES.has(item.type)) slot('encrypted_content', ['encrypted_content'], undefined, false);

  if (item.type === 'program') {
    slot('fingerprint', ['fingerprint'], typeof item.fingerprint === 'string' ? item.fingerprint : undefined, false);
  }

  const elements = encryptedContentElements(item);
  if (elements !== undefined) {
    const { property, required } = elements;
    elements.elements.forEach((element, index) => {
      const value = encryptedContentValue(element);
      if (value !== undefined) slot(`${property}.${index}.encrypted_content`, [property, index], value, required);
    });
    // A tool output is the upstream's own structured result, so we only ever
    // rewrite the encrypted parts it already has; an agent message may grow one.
    if (property === 'content') {
      slot(`${property}.${elements.elements.length}.encrypted_content`, [property, elements.elements.length], undefined, required);
    }
  }

  return slots;
};

export const responsesOpaqueLocations = (item: ResponsesItem): ResponsesOpaqueLocation[] =>
  carrierSlots(item).flatMap(slot =>
    slot.value === undefined ? [] : [{ key: slot.key, value: slot.value, domain: slot.domain, required: slot.required }]);

export const responsesSyntheticCarrierSlot = (item: ResponsesItem): ResponsesCarrierSlot | undefined => {
  const growable = carrierSlots(item).find(slot => slot.value === undefined);
  return growable === undefined ? undefined : { key: growable.key, domain: growable.domain };
};

export const replaceResponsesOpaqueLocations = <T extends ResponsesItem>(
  item: T,
  replacements: ReadonlyMap<string, string | undefined>,
): T => {
  const slots = carrierSlots(item).filter(slot => replacements.has(slot.key));
  if (slots.length === 0) return item;
  const result = { ...item } as Record<string, unknown>;

  for (const slot of slots) {
    if (slot.path.length !== 1) continue;
    const [property] = slot.path;
    const replacement = replacements.get(slot.key);
    if (replacement === undefined) delete result[property];
    else result[property] = replacement;
  }

  const elementSlots = slots.filter(slot => slot.path.length === 2);
  if (elementSlots.length > 0) {
    const [property] = elementSlots[0].path;
    const replacementByIndex = new Map(elementSlots.map(slot => [slot.path[1]!, replacements.get(slot.key)]));
    const elements = result[property] as readonly unknown[];
    const replaced = elements.flatMap((element, index) => {
      if (!replacementByIndex.has(index)) return [element];
      const replacement = replacementByIndex.get(index);
      return replacement === undefined ? [] : [{ ...element as object, encrypted_content: replacement }];
    });
    const appended = replacementByIndex.get(elements.length);
    if (appended !== undefined) replaced.push({ type: 'encrypted_content', encrypted_content: appended } satisfies ResponsesEncryptedContent);
    result[property] = replaced;
  }

  return result as unknown as T;
};
