const HEAD = 8;
const TAIL = 6;
// The cards pair this with a tooltip carrying the full id; this is what they
// show.
// Guarding on length is the point of the helper: below the combined width of
// the two slices they overlap and the id prints some of its own characters
// twice, and just above that the ellipsis costs about what it saves.
const SHORTEST_WORTH_ELIDING = 18;

export const shortAccountId = (id: string): string =>
  id.length <= SHORTEST_WORTH_ELIDING ? id : `${id.slice(0, HEAD)}…${id.slice(-TAIL)}`;
