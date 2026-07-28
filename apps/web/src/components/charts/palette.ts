// Fluent's categorical sequence, walked by slot so a series keeps its colour
// as long as its position in the ranking holds.
const palette = [
  '#0f6cbd',
  '#13a10e',
  '#c50f1f',
  '#ca5010',
  '#8764b8',
  '#038387',
  '#8e562e',
  '#0078d4',
  '#498205',
  '#881798',
];

export const colorForSlot = (slot: number): string => palette[slot % palette.length]!;
