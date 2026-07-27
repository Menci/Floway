export const truncatePreservingCodePoints = (s: string, max: number): string => {
  if (s.length <= max) return s;
  let end = max;
  const lastCode = s.charCodeAt(end - 1);
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) end -= 1;
  return s.slice(0, end);
};
