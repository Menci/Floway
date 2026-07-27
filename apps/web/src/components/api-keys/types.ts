import type { ApiKey, ControlPlaneModel, UpstreamOption } from "../../api/types";

export type { UpstreamOption } from "../../api/types";

export interface ApiKeysPageData {
  keys: ApiKey[];
  upstreams: UpstreamOption[];
  models: ControlPlaneModel[];
  error: string | null;
}

export type ApiKeyMutation = "create" | "edit" | "rotate" | "delete";
export interface MutationToastController {
  start: (kind: ApiKeyMutation, name: string) => string;
  succeed: (toastId: string, kind: ApiKeyMutation, name: string) => void;
  fail: (toastId: string, kind: ApiKeyMutation, name: string, message: string) => void;
}
