import { redirect } from "react-router";

import type { Route } from "./+types/dashboard-providers-upstreams-edit";
import type { UpstreamRecord } from "../api/types";
import { authFetch, callApi } from "../api/auth";
import { getSessionToken } from "../auth/session";
import { UpstreamEditorPage } from "../components/upstream-editor/upstream-editor-page";
import { loadEditorAux, requireAdmin } from "../components/upstream-editor/editor-data";

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  if (!getSessionToken()) throw redirect("/");
  if (!(await requireAdmin())) throw redirect("/dashboard/services/api-keys");
  const [recordResult, aux] = await Promise.all([
    callApi<UpstreamRecord>(() => authFetch(`/api/upstreams/${encodeURIComponent(params.id)}`)),
    loadEditorAux(),
  ]);
  if (recordResult.error?.status === 404) {
    throw redirect("/dashboard/providers/upstreams?missing=1");
  }
  if (recordResult.error) throw new Error(recordResult.error.message);
  return {
    ...aux,
    mode: "edit" as const,
    record: recordResult.data,
    nextSortOrder: recordResult.data.sort_order,
  };
}

export function meta({}: Route.MetaArgs) {
  return [{ title: "Edit Upstream | Floway" }];
}

export default function DashboardProvidersUpstreamsEdit({ loaderData }: Route.ComponentProps) {
  return <UpstreamEditorPage data={loaderData} />;
}
