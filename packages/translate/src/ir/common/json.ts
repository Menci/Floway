// The JSON value shape, shared by complete JSON and output values that admit IRAbsent.
export type JSONValueOf<Extra> = Extra | null | boolean | number | string | readonly JSONValueOf<Extra>[] | { readonly [key: string]: JSONValueOf<Extra> };

export type IRJSONValue = JSONValueOf<never>;

export type IRJSONObject = { readonly [key: string]: IRJSONValue };
