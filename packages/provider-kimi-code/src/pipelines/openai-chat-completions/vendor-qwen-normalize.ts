import { vendorStage } from './vendor-stage.ts';

// https://www.alibabacloud.com/help/en/model-studio/deep-thinking
export const normalizeQwen = vendorStage('vendor-qwen', payload => {
  if (payload.reasoning_effort !== 'none') return payload;
  const { reasoning_effort: _effort, ...rest } = payload;
  return { ...rest, enable_thinking: false };
});
