export const visibleGroupCount = (available: number, widths: readonly number[], overflowWidth: number, gap: number): number => {
  const prefix = [0];
  for (const width of widths) prefix.push(prefix.at(-1)! + width);
  if (prefix.at(-1)! + gap * Math.max(0, widths.length - 1) <= available) return widths.length;
  for (let visible = widths.length - 1; visible > 0; visible--) {
    if (prefix[visible]! + gap * visible + overflowWidth <= available) return visible;
  }
  return 0;
};
