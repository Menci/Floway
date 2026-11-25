import type { OpenAIResponsesOperation } from './operations.ts';
import { mapChanged } from '../shared/map-changed.ts';
import { rewritePayload } from '../shared/rewrite-request.ts';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';

// Copilot filters public image generation out of Responses tool declarations
// and selectors. Other tool carriers and their relative order stay intact.
// https://github.com/caozhiyuan/copilot-api/blob/5d37d5b1ac6566c935a5c26d046396ee5fa423cc/src/routes/responses/handler.ts#L187-L204
const omitImageGeneration = (tools: OpenAIResponsesTool[]): OpenAIResponsesTool[] => {
  const remaining = tools.filter(tool => tool.type !== 'image_generation');
  return remaining.length === tools.length ? tools : remaining;
};

type ToolPayload = Pick<CanonicalOpenAIResponsesPayload, 'input' | 'tools' | 'tool_choice'>;

const hasTools = ({ tools, input }: ToolPayload): boolean =>
  (tools?.length ?? 0) > 0 || input.some(item =>
    (item.type === 'additional_tools' || item.type === 'tool_search_output') && item.tools.length > 0);

export const stripImageGenerationFromPayload = <Payload extends ToolPayload>(payload: Payload): Payload => {
  const { tools, input, ...rest } = payload;
  const remainingTools = Array.isArray(tools) ? omitImageGeneration(tools) : tools;
  const remainingInput = mapChanged(input, item => {
    if (item.type !== 'additional_tools' && item.type !== 'tool_search_output') return item;
    const remaining = omitImageGeneration(item.tools);
    return remaining === item.tools ? item : { ...item, tools: remaining };
  });

  const removeEmptyTools = Array.isArray(remainingTools) && remainingTools.length === 0;
  const updated = remainingTools === tools && remainingInput === input && !removeEmptyTools ? payload : {
    ...rest,
    input: remainingInput,
    ...(remainingTools === undefined || removeEmptyTools ? {} : { tools: remainingTools }),
  } as Payload;
  const { tool_choice: choice, ...withoutChoice } = updated;
  if (typeof choice === 'object' && choice !== null) {
    if (choice.type === 'image_generation') {
      return (hasTools(updated) ? { ...updated, tool_choice: 'none' } : withoutChoice) as Payload;
    }
    if (choice.type === 'allowed_tools') {
      const kept = choice.tools.filter(tool => tool.type !== 'image_generation');
      if (kept.length !== choice.tools.length) {
        return { ...updated, tool_choice: kept.length === 0 && choice.mode === 'auto' ? 'none' : { ...choice, tools: kept } } as Payload;
      }
    }
  }
  if (choice === 'required' && (remainingTools !== tools || remainingInput !== input) && !hasTools(updated)) {
    return withoutChoice as Payload;
  }
  return updated as Payload;
};

export const stripImageGeneration = (operation: OpenAIResponsesOperation) => rewritePayload[operation]('stripImageGeneration', stripImageGenerationFromPayload);
