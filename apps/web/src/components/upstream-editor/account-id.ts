const HEAD = 8;
const TAIL = 6;
// Below HEAD + TAIL the slices overlap and repeat characters; just above it the ellipsis costs what it saves.
const SHORTEST_WORTH_ELIDING = 18;

export const shortAccountId = (id: string): string =>
  id.length <= SHORTEST_WORTH_ELIDING ? id : `${id.slice(0, HEAD)}…${id.slice(-TAIL)}`;
