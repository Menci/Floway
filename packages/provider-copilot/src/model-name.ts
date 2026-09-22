// Claude id spelling. Copilot's raw catalog writes Claude versions with a dot
// (`claude-opus-4.7`) while the public surface uses a dash so the id stays a
// single token in client configuration, and Copilot additionally aliases each
// family by release date. These two functions convert spelling only — which
// raw ids collapse into one public model is decided by `model-variants.ts`.
const CLAUDE_DATE_SUFFIX = /-\d{8}$/;

export const stripClaudeDateSuffix = (id: string): string =>
  id.startsWith('claude-') ? id.replace(CLAUDE_DATE_SUFFIX, '') : id;

export const copilotRawModelId = (id: string): string => {
  if (!id.startsWith('claude-')) return id;
  return id.replace(/(?<=-)(\d+)-(\d+)(?=-|$)/g, '$1.$2');
};

export const copilotPublicModelId = (id: string): string => {
  if (!id.startsWith('claude-')) return id;
  return copilotRawModelId(id)
    .replace(CLAUDE_DATE_SUFFIX, '')
    .replace(/(\d)\.(\d)/g, '$1-$2');
};
