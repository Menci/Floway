const CLAUDE_VARIANT_SUFFIX = /-(?:high|xhigh|1m(?:-internal)?|fast)$/;
const CLAUDE_DATE_SUFFIX = /-\d{8}$/;

export const copilotRawModelId = (id: string): string => {
  if (!id.startsWith('claude-')) return id;
  return id.replace(/(?<=-)(\d+)-(\d+)(?=-|$)/g, '$1.$2');
};

export const copilotPublicModelId = (id: string): string => {
  if (!id.startsWith('claude-')) return id;
  return copilotRawModelId(id)
    .replace(CLAUDE_DATE_SUFFIX, '')
    .replace(CLAUDE_VARIANT_SUFFIX, '')
    .replace(/(\d)\.(\d)/g, '$1-$2');
};
