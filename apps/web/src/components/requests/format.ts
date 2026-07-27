import type { DumpErrorMeta, DumpMetadata } from "@floway-dev/gateway/dump-types";

export type RequestSeverity = "success" | "warning" | "error";

export function requestSeverity(status: number | null, error: DumpErrorMeta | null): RequestSeverity {
  if (status === null || error !== null || status >= 500) return "error";
  if (status >= 400) return "warning";
  return "success";
}

export function errorLabel(error: DumpErrorMeta | null, status: number | null): string | null {
  if (!error) return null;
  if (error.kind === "failed") return error.reason;
  return `${error.kind} error ${status || "???"}`;
}

export function totalTokens(meta: DumpMetadata): number | null {
  if (meta.inputTokens === null && meta.outputTokens === null) return null;
  return (meta.inputTokens ?? 0) + (meta.outputTokens ?? 0);
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(value < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDuration(value: number): string {
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value / 1000)}s`;
}

export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)} K`;
  if (value < 1_000_000) return `${Math.round(value / 1000)} K`;
  return `${(value / 1_000_000).toFixed(1)} M`;
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatFullTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(timestamp);
}
