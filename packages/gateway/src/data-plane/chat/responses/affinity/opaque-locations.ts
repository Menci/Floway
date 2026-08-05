import type { ResponsesInputItem, ResponsesOutputItem, ResponsesToolOutputContent } from '@floway-dev/protocols/responses';

type ResponsesItem = ResponsesInputItem | ResponsesOutputItem;

export interface ResponsesOpaqueLocation {
  readonly key: string;
  readonly value: string;
  readonly domain: string;
  readonly required: boolean;
}

const canonicalItemType = (itemType: string): string =>
  itemType === 'compaction_summary' ? 'compaction' : itemType;

export const responsesCarrierDomain = (itemType: string, slot: string): string =>
  `responses.${canonicalItemType(itemType)}.${slot}`;

const toolOutput = (item: ResponsesItem): ResponsesToolOutputContent[] | undefined => {
  if (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') return undefined;
  return Array.isArray(item.output) ? item.output : undefined;
};

export const responsesOpaqueLocations = (item: ResponsesItem): ResponsesOpaqueLocation[] => {
  const locations: ResponsesOpaqueLocation[] = [];
  const record = item as unknown as Record<string, unknown>;
  if (typeof record.encrypted_content === 'string') {
    locations.push({
      key: 'encrypted_content',
      value: record.encrypted_content,
      domain: responsesCarrierDomain(item.type, 'encrypted_content'),
      required: false,
    });
  }
  if (item.type === 'program' && typeof item.fingerprint === 'string') {
    locations.push({
      key: 'fingerprint',
      value: item.fingerprint,
      domain: responsesCarrierDomain(item.type, 'fingerprint'),
      required: false,
    });
  }
  toolOutput(item)?.forEach((content, index) => {
    if (content.type !== 'encrypted_content') return;
    locations.push({
      key: `output.${index}.encrypted_content`,
      value: content.encrypted_content,
      domain: responsesCarrierDomain(item.type, `output.${index}.encrypted_content`),
      required: true,
    });
  });
  return locations;
};

const replacementAt = (replacements: ReadonlyMap<string, string | undefined>, key: string, original: string): string | undefined =>
  replacements.has(key) ? replacements.get(key) : original;

export const replaceResponsesOpaqueLocations = <T extends ResponsesItem>(
  item: T,
  replacements: ReadonlyMap<string, string | undefined>,
): T => {
  const result = { ...item } as Record<string, unknown>;
  for (const key of ['encrypted_content', 'fingerprint'] as const) {
    if (!replacements.has(key)) continue;
    const replacement = replacements.get(key);
    if (replacement === undefined) delete result[key];
    else result[key] = replacement;
  }

  const output = toolOutput(item);
  if (output !== undefined) {
    const replacedOutput: ResponsesToolOutputContent[] = [];
    output.forEach((content, index) => {
      if (content.type !== 'encrypted_content') {
        replacedOutput.push(content);
        return;
      }
      const replacement = replacementAt(replacements, `output.${index}.encrypted_content`, content.encrypted_content);
      if (replacement !== undefined) replacedOutput.push({ ...content, encrypted_content: replacement });
    });
    result.output = replacedOutput;
  }
  return result as unknown as T;
};
