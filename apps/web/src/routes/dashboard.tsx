import {
  Outlet,
  redirect,
  useLocation,
  useNavigate,
  useOutletContext,
} from "react-router";
import { useTranslation } from "react-i18next";
import { useEffect } from "react";

import type { Route } from "./+types/dashboard";
import type { AuthUser } from "../api/auth";
import { getSessionToken } from "../auth/session";
import { PageShell } from "../components/ui/page-shell";
import { Sidebar } from "../components/sidebar";
import { fluentComponents } from "../fluent";
import { useAuthStore } from "../stores/auth-store";

const { Spinner } = fluentComponents;

export type DashboardOutletContext = {
  user: AuthUser;
};

export async function clientLoader() {
  if (!getSessionToken()) throw redirect("/");
  return null;
}

export function meta({}: Route.MetaArgs) {
  return [{ title: "Dashboard | Floway" }];
}

export default function Dashboard({}: Route.ComponentProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const initialize = useAuthStore((state) => state.initialize);
  const status = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);
  const error = useAuthStore((state) => state.error);
  const { pathname } = useLocation();
  const upstreamEditor = /^\/dashboard\/providers\/upstreams\/(?:new\/[^/]+|[^/]+)$/.test(pathname);
  const requestsInspector = pathname === "/dashboard/monitor/requests";
  const playground = pathname === "/dashboard/playground";

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    if (status === "unauthenticated") navigate("/", { replace: true });
  }, [navigate, status]);

  if (status === "error") {
    return (
      <PageShell>
        <p className="text-fui-fg2">{error}</p>
      </PageShell>
    );
  }

  if (!user) {
    return (
      <PageShell>
        <Spinner label={t("common.loading")} />
      </PageShell>
    );
  }

  return (
    <div className="grid grid-cols-[290px_minmax(0,1fr)] h-screen min-h-0">
      <Sidebar user={user} />
      <main className={upstreamEditor || requestsInspector || playground
        ? "min-h-0 overflow-hidden p-[22px_28px_28px]"
        : "min-h-0 overflow-y-auto p-[22px_28px_28px] [scrollbar-gutter:stable]"}>
        <Outlet context={{ user } satisfies DashboardOutletContext} />
      </main>
    </div>
  );
}

export function useDashboardOutletContext() {
  return useOutletContext<DashboardOutletContext>();
}
