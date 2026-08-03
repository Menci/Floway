export interface ModelOption { value: string; label: string }

// An option matches on the id it pins as well as the label it shows: the two
// differ wherever a picker labels an option with the public model id while the
// value carries an override.
const matchesQuery = (option: ModelOption | string, needle: string) =>
  typeof option === 'string'
    ? option.toLocaleLowerCase().includes(needle)
    : option.label.toLocaleLowerCase().includes(needle) || option.value.toLocaleLowerCase().includes(needle);

/**
 * The one matching rule behind every model combobox, over either a list of
 * model ids or a list of labelled options. Trimmed, so the space that ends a
 * pasted id does not empty the list, and folded in the operator's locale.
 */
export const filterModelOptions = <T extends ModelOption | string>(options: readonly T[], query: string): readonly T[] => {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return options;
  return options.filter(option => matchesQuery(option, needle));
};
