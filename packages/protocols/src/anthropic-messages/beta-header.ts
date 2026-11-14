export const parseAnthropicBetaHeader = (raw: string | null | undefined): readonly string[] =>
  raw ? raw.split(',').map(part => part.trim()).filter(part => part.length > 0) : [];
