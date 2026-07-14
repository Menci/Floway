import type { ResponsesBoundaryCtx } from './types.ts';
import type { CanonicalResponsesPayload, ResponsesTool, ResponsesToolChoice } from '@floway-dev/protocols/responses';

/**
 * Copilot's `/responses` endpoint rejects image-generation tool entries, so
 * strip them once the planner has committed to a native Responses target on a
 * Copilot upstream. Image generation reaches the wire in two shapes and both
 * must go:
 *
 * - the public hosted tool `{ type: "image_generation" }`, and
 * - Codex's deferred-tool namespace `{ type: "namespace", name: "image_gen",
 *   tools: [...] }`, which packages the same capability for client-side
 *   execution.
 *
 * The gateway image shim normally consumes both shapes before this provider
 * boundary. This strip is the disabled-shim fallback and remains Copilot-only;
 * other providers own their behavior at their own boundaries. Every other
 * hosted/deferred tool — `web_search`, `tool_search`, and any namespace whose
 * name is not `image_gen` — is left in place: Codex relies on `tool_search` and
 * its namespaces for client-executed deferred tool discovery, and Copilot
 * accepts `web_search`. We match the namespace by its exact upstream name so
 * unrelated namespaces survive.
 *
 * Copilot rejects both shapes before inference with an HTTP 400: the hosted
 * tool yields `The requested tool image_generation is not supported.`, and the
 * `image_gen` namespace (emitted by recent Codex clients as
 * `{ type: "namespace", name: "image_gen", tools: [{ type: "function", name:
 * "imagegen" }] }`) yields `Invalid Value: 'tools.namespace'. User-defined
 * namespace 'image_gen' collides with an existing tool namespace.`
 *
 * References:
 * - https://platform.openai.com/docs/guides/tools-image-generation
 * - https://github.com/openai/codex/blob/9f42c89c0112771dc29100a6f3fc904049b2655f/codex-rs/tools/src/tool_spec.rs#L17-L27
 * - https://github.com/caozhiyuan/copilot-api/issues/206 (hosted image_generation rejection)
 * - https://github.com/caozhiyuan/copilot-api/issues/312 (image_gen namespace collision + wire shape)
 * - https://github.com/caozhiyuan/copilot-api/commit/e260303a1ccc48390b0b710fa40631562f1a37fb (upstream fix filtering both)
 */
const IMAGE_GENERATION_NAMESPACE_NAME = 'image_gen';

const isImageGenerationTool = (tool: ResponsesTool): boolean =>
  tool.type === 'image_generation' ||
  (tool.type === 'namespace' && tool.name === IMAGE_GENERATION_NAMESPACE_NAME);

// A tool_choice that named one of the just-removed tools would tell Copilot to
// invoke a tool that no longer exists. A bare `{ type: "namespace" }` without a
// name, or one naming a surviving namespace, is untouched.
const isImageGenerationToolChoice = (choice: ResponsesToolChoice | null | undefined): boolean =>
  typeof choice === 'object'
  && choice !== null
  && (choice.type === 'image_generation'
    || (choice.type === 'namespace' && choice.name === IMAGE_GENERATION_NAMESPACE_NAME));

export const stripImageGenerationFromPayload = (payload: CanonicalResponsesPayload): void => {
  let removedTool = false;

  if (Array.isArray(payload.tools)) {
    const tools = payload.tools.filter(tool => {
      const drop = isImageGenerationTool(tool);
      removedTool ||= drop;
      return !drop;
    });

    if (tools.length === 0) {
      delete payload.tools;
    } else {
      payload.tools = tools;
    }
  }

  if (isImageGenerationToolChoice(payload.tool_choice)) {
    delete payload.tool_choice;
    return;
  }

  // A forced `required` choice with no surviving tools would tell Copilot to
  // invoke a tool that no longer exists; drop the choice along with the tools.
  if (removedTool && payload.tool_choice === 'required' && (!Array.isArray(payload.tools) || payload.tools.length === 0)) {
    delete payload.tool_choice;
  }
};

export const withImageGenerationStripped = async <TResult>(
  ctx: ResponsesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  stripImageGenerationFromPayload(ctx.payload);
  return await run();
};
