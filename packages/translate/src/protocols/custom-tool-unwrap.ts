// A target that wraps a freeform tool as a single-`input` function reads the
// model's answer back out of that wrapper here. It needs no IR type: the value
// is the string the upstream streamed.
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
  if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { input?: unknown }).input === 'string') return (parsed as { input: string }).input;
  console.warn('Custom tool wrapper has no string input; returning the entire JSON value as freeform input.');
  return wrappedArguments;
};
