export const mapChanged = <T>(items: T[], map: (item: T, index: number) => T): T[] => {
  let changed = false;
  const output = items.map((item, index) => {
    const next = map(item, index);
    changed ||= next !== item;
    return next;
  });
  return changed ? output : items;
};
