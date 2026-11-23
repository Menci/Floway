export const removeFact = <Rest extends object, Key extends string>(facts: Rest & Record<Key, unknown>, key: Key): Rest => {
  const { [key]: _removed, ...rest } = facts;
  return rest as Rest;
};
