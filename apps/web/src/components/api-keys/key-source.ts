export type KeySource = "generate" | "custom";

export type KeyWriteBody =
  | { key_source: "generate" }
  | { key_source: "custom"; custom_key: string };

export const keyWriteBody = (source: KeySource, customKey: string): KeyWriteBody =>
  source === "custom"
    ? { key_source: "custom", custom_key: customKey.trim() }
    : { key_source: "generate" };
