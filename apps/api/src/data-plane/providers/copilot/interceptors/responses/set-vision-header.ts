import type { ResponsesInterceptor } from '../../../../llm/interceptors.ts';

/**
 * Copilot's Responses endpoint requires the private
 * `copilot-vision-request: true` header to accept image inputs. Images can
 * appear as `input_image` blocks (current Responses) or legacy `image` blocks,
 * and not only inside top-level `message.content`: hosted-tool output items,
 * custom tool outputs, and other future input shapes may also carry image
 * content nested at arbitrary depth. The detector recursively scans every
 * input item's `content` and array branches so a deeply embedded image still
 * flips the header.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/main/src/routes/responses/utils.ts#L185-L210
 */
const containsVisionContent = (value: unknown): boolean => {
  if (!value) return false;
  if (Array.isArray(value)) return value.some(entry => containsVisionContent(entry));
  if (typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type.toLowerCase() : undefined;
  // Legacy `image` is retained alongside `input_image` for older Responses
  // payloads that predate `input_image`. Matching both costs nothing and
  // avoids dropping the header on aged samples we may still see in replay.
  if (type === 'input_image' || type === 'image') return true;
  if (Array.isArray(record.content)) return record.content.some(entry => containsVisionContent(entry));
  return false;
};

export const withVisionHeaderSet: ResponsesInterceptor = async (ctx, _request, run) => {
  const input = ctx.payload.input;
  if (!Array.isArray(input)) return await run();

  if (containsVisionContent(input)) ctx.headers['copilot-vision-request'] = 'true';

  return await run();
};
