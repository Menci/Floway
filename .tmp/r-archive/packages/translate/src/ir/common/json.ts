// The JSON value shape, declared once. Output values add `IRAbsent` wherever a
// leaf may hold it; input values never do, because a request arrives complete.
type JSONValueOf<Extra> = Extra | null | boolean | number | string | readonly JSONValueOf<Extra>[] | { readonly [key: string]: JSONValueOf<Extra> };

export type IRJSONValue = JSONValueOf<never>;

export type IRJSONObject = { readonly [key: string]: IRJSONValue };
