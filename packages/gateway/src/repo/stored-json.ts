export const parseStoredJson = <T>(raw: string, message: string): T => {
  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    throw new Error(message, { cause });
  }
};
