// Form-input parser shared by the chat-metadata and model editors. Both
// editors feed nonnegative integer counts (token caps, budget bounds,
// pricing factors); the backend validators reject negatives, so the form
// boundary drops them before staging data the next PUT would 400 on.
// Blank input, null, and undefined all collapse to `undefined` — the
// "leave blank to inherit" semantic the editors render for optional
// fields.
export const parseOptionalNumber = (raw: string | number | null | undefined): number | undefined => {
  if (raw === '' || raw === null || raw === undefined) return undefined;
  const num = Number(raw);
  return Number.isFinite(num) && num >= 0 ? num : undefined;
};
