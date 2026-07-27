import { TranslatorInputError } from '../../translator-input-error.ts';
import type { ResponsesInputAgentMessageItem, ResponsesInputContent, ResponsesInputMultiAgentCallOutputItem } from '@floway-dev/protocols/responses';

const readableText = (part: Record<string, unknown> & { type: string }, field: 'text' | 'refusal'): string => {
  const value = part[field];
  if (typeof value !== 'string') {
    throw new TranslatorInputError(`Invalid '${part.type}' agent_message content: '${field}' must be a string.`);
  }
  return value;
};

// Codex's native multi-agent input carries author/recipient outside the content
// array. Recreate the same visible routing envelope for protocols that only
// have ordinary user messages.
// https://github.com/openai/codex/blob/95637f7056835fea66bdd0044414af480fc0fd74/codex-rs/protocol/src/protocol.rs#L808-L840
const attributionEnvelope = (item: ResponsesInputAgentMessageItem): string =>
  `Message Type: MESSAGE\nTask name: ${item.recipient}\nSender: ${item.author}\nPayload:\n`;

export const multiAgentMessageContent = (
  item: ResponsesInputAgentMessageItem,
  target: 'Messages' | 'Chat Completions',
): ResponsesInputContent[] => {
  const content: ResponsesInputContent[] = [{ type: 'input_text', text: attributionEnvelope(item) }];

  for (const part of item.content) {
    switch (part.type) {
    case 'input_text':
    case 'output_text':
      content.push(part);
      break;
    case 'text':
    case 'summary_text':
    case 'reasoning_text':
      content.push({ type: 'input_text', text: readableText(part, 'text') });
      break;
    case 'refusal':
      content.push({ type: 'input_text', text: readableText(part, 'refusal') });
      break;
    case 'input_image':
    case 'input_file':
      content.push(part);
      break;
    case 'computer_screenshot':
      content.push({
        type: 'input_image',
        image_url: part.image_url,
        file_id: part.file_id,
        detail: part.detail,
      });
      break;
    case 'encrypted_content':
      // This blob is decrypted inside trusted Responses model execution. It is
      // neither readable text nor a provider-neutral reasoning signature.
      // https://github.com/openai/openai-node/blob/228c224393ef4bf3bda2a9d7eb40f387499299b5/src/resources/beta/responses/responses.ts#L6680-L6694
      throw new TranslatorInputError(`Cannot translate encrypted agent_message content to ${target}: encrypted agent_message content requires native Responses model execution.`);
    default:
      throw new TranslatorInputError(`Cannot translate agent_message content type '${part.type}' to ${target}.`);
    }
  }

  return content;
};

export const multiAgentCallOutputText = (item: ResponsesInputMultiAgentCallOutputItem): string =>
  item.output.map(part => part.text).join('');
