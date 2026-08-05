export const authoritativeStreamSuffix = (streamed: string, complete: string, subject: string): string => {
  if (complete.length === 0 || complete === streamed) return '';
  if (!complete.startsWith(streamed)) {
    throw new Error(`Upstream ${subject} done value does not extend its streamed deltas.`);
  }
  return complete.slice(streamed.length);
};
