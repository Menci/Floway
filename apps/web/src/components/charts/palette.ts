const palette = [
  '#479ef5',
  '#54b054',
  '#e37d8f',
  '#ef8e5e',
  '#a98dd5',
  '#45aeb1',
  '#b58b70',
  '#62abf5',
  '#8eb456',
  '#b36abe',
];

export const colorForSlot = (slot: number): string => palette[slot % palette.length]!;
