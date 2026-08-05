import type { ResponsesInputItem, ResponsesOutputItem, ResponsesToolOutputContent } from '@floway-dev/protocols/responses';

type ResponsesItem = ResponsesInputItem | ResponsesOutputItem;

export interface ResponsesOpaqueLocation {
  readonly key: string;
  readonly value: string;
  readonly domain: string;
  readonly required: boolean;
}

export const INTER_AGENT_MESSAGE_DOMAIN = 'responses.inter-agent-message.encrypted-content';
const MESSAGE_ACTIONS = new Set(['spawn_agent', 'send_message', 'followup_task']);

const canonicalItemType = (itemType: string): string =>
  itemType === 'compaction_summary' ? 'compaction' : itemType;

const carrierDomain = (itemType: string, slot: string): string =>
  `responses.${canonicalItemType(itemType)}.${slot}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parsedArguments = (item: ResponsesItem): Record<string, unknown> | undefined => {
  if (typeof (item as { arguments?: unknown }).arguments !== 'string') return undefined;
  try {
    const parsed = JSON.parse((item as { arguments: string }).arguments) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export const isEncryptedInterAgentCall = (item: ResponsesItem): boolean => {
  if (item.type === 'multi_agent_call') return MESSAGE_ACTIONS.has(item.action);
  if (item.type !== 'function_call' || item.namespace !== 'collaboration' || !MESSAGE_ACTIONS.has(item.name)) return false;
  const encrypted = item.encrypted_function_args;
  return !Array.isArray(encrypted) || encrypted.includes('message');
};

const interAgentMessage = (item: ResponsesItem): string | undefined => {
  if (!isEncryptedInterAgentCall(item)) return undefined;
  const message = parsedArguments(item)?.message;
  return typeof message === 'string' ? message : undefined;
};

const toolOutput = (item: ResponsesItem): ResponsesToolOutputContent[] | undefined => {
  if (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') return undefined;
  return Array.isArray(item.output) ? item.output : undefined;
};

// Codex moves one encrypted inter-agent value from a collaboration function's
// arguments into an agent_message in another thread. Both positions use one
// authenticated domain so affinity survives that move.
// https://github.com/openai/codex/blob/f2d825533c9423728f319a6dbcbb31c21768aa69/codex-rs/core/src/tools/handlers/multi_agents_v2.rs#L57-L84
// https://github.com/openai/codex/blob/f2d825533c9423728f319a6dbcbb31c21768aa69/codex-rs/protocol/src/protocol.rs#L817-L849
export const responsesOpaqueLocations = (item: ResponsesItem): ResponsesOpaqueLocation[] => {
  const locations: ResponsesOpaqueLocation[] = [];
  const message = interAgentMessage(item);
  if (message !== undefined) {
    locations.push({
      key: 'arguments.message',
      value: message,
      domain: INTER_AGENT_MESSAGE_DOMAIN,
      required: true,
    });
  }

  const record = item as unknown as Record<string, unknown>;
  if (typeof record.encrypted_content === 'string') {
    locations.push({
      key: 'encrypted_content',
      value: record.encrypted_content,
      domain: carrierDomain(item.type, 'encrypted_content'),
      required: false,
    });
  }
  if (item.type === 'program' && typeof item.fingerprint === 'string') {
    locations.push({
      key: 'fingerprint',
      value: item.fingerprint,
      domain: carrierDomain(item.type, 'fingerprint'),
      required: false,
    });
  }
  if (item.type === 'agent_message') {
    item.content.forEach((content, index) => {
      if (content.type === 'encrypted_content' && typeof content.encrypted_content === 'string') {
        locations.push({
          key: `content.${index}.encrypted_content`,
          value: content.encrypted_content,
          domain: INTER_AGENT_MESSAGE_DOMAIN,
          required: true,
        });
      }
    });
  }
  toolOutput(item)?.forEach((content, index) => {
    if (content.type === 'encrypted_content') {
      locations.push({
        key: `output.${index}.encrypted_content`,
        value: content.encrypted_content,
        domain: carrierDomain(item.type, `output.${index}.encrypted_content`),
        required: true,
      });
    }
  });
  return locations;
};

const replacementAt = (replacements: ReadonlyMap<string, string | undefined>, key: string, original: string): string | undefined =>
  replacements.has(key) ? replacements.get(key) : original;

export const replaceResponsesOpaqueLocations = <T extends ResponsesItem>(
  item: T,
  replacements: ReadonlyMap<string, string | undefined>,
): T => {
  let result = { ...item } as Record<string, unknown>;
  for (const key of ['encrypted_content', 'fingerprint'] as const) {
    if (!replacements.has(key)) continue;
    const replacement = replacements.get(key);
    if (replacement === undefined) delete result[key];
    else result[key] = replacement;
  }

  if (replacements.has('arguments.message')) {
    const replacement = replacements.get('arguments.message');
    if (replacement === undefined) throw new TypeError('Encrypted inter-agent arguments cannot be removed');
    const args = parsedArguments(item);
    if (args === undefined || typeof args.message !== 'string') throw new TypeError('Inter-agent message location no longer matches its item');
    result = { ...result, arguments: JSON.stringify({ ...args, message: replacement }) };
  }

  if (item.type === 'agent_message') {
    const content = item.content.flatMap((part, index) => {
      if (part.type !== 'encrypted_content' || typeof part.encrypted_content !== 'string') return [part];
      const replacement = replacementAt(replacements, `content.${index}.encrypted_content`, part.encrypted_content);
      return replacement === undefined ? [] : [{ ...part, encrypted_content: replacement }];
    });
    result = {
      ...result,
      content,
    };
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
    result = {
      ...result,
      output: replacedOutput,
    };
  }
  return result as unknown as T;
};
