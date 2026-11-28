import type { DocumentType } from "@repo/types/reviewer";

export const typeLabels: Record<DocumentType, string> = {
  invoice: "Invoice",
  lease: "Lease",
  market_report: "Market report",
};
export const fieldLabel = (name: string) =>
  name.replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase());
export const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The request failed. Please try again.";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly needsType: string[] = [],
  ) {
    super(message);
  }
}

export async function apiText(
  path: string,
  options: RequestInit = {},
): Promise<string> {
  const origin = process.env.NEXT_PUBLIC_API_ORIGIN || "http://localhost:4000";
  const response = await fetch(`${origin}${path}`, {
    cache: "no-store",
    ...options,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const retry = response.headers.get("Retry-After");
    const message =
      response.status === 429 && retry
        ? `Too many requests. Try again in ${retry} seconds.`
        : data.message || `Request failed (${response.status}).`;
    throw new ApiError(
      message,
      Array.isArray(data.needsType) ? data.needsType : [],
    );
  }
  return response.text();
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const body = await apiText(path, options);
  return body ? JSON.parse(body) : (undefined as T);
}

export function post<T>(path: string, data?: unknown): Promise<T> {
  return api<T>(path, {
    method: "POST",
    ...(data === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }),
  });
}
