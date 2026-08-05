export const singleNonEmptyMultipartTextField = (form: FormData, name: string): string | undefined => {
  const values = form.getAll(name);
  if (values.length !== 1) return undefined;
  const [value] = values;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};
