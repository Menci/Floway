const encoder = new TextEncoder();

// SQLite NOCASE folds ASCII only, stops comparison at NUL, then compares byte
// lengths. Keep import validation and the in-memory repository on that contract.
// https://sqlite.org/datatype3.html#collation
// https://github.com/sqlite/sqlite/blob/c3e073420ff9e35ea80c783e3664e32449b5b703/src/main.c#L1106-L1128
export const groupNameKey = (name: string): string => JSON.stringify([
  name.split('\0', 1)[0]!.replace(/[A-Z]/g, character => character.toLowerCase()),
  encoder.encode(name).length,
]);
