// Preserve malformed wrappers as freeform input so the client can decide how
// to handle the tool call without terminating the agent's generation stream.
export const unwrapCustomToolInput = (wrappedArguments: string): string => {
  if (wrappedArguments.length === 0) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(wrappedArguments);
  } catch {
    return wrappedArguments;
  }
  if (typeof parsed === 'object' && parsed !== null && 'input' in parsed && typeof parsed.input === 'string') {
    return parsed.input;
  }
  console.warn('Custom tool wrapper has no string input; returning the entire JSON value as freeform input.');
  return wrappedArguments;
};
