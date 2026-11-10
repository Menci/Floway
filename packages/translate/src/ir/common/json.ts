// The JSON value shape, declared once. Output values instantiate `Extra` with
// `IRAbsent` wherever a leaf may be determined-never-to-arrive; input values do
// not, because a request arrives complete.
export type JSONValueOf<Extra> = Extra | null | boolean | number | string | readonly JSONValueOf<Extra>[] | { readonly [key: string]: JSONValueOf<Extra> };

export type IRJSONValue = JSONValueOf<never>;

export type IRJSONObject = { readonly [key: string]: IRJSONValue };
