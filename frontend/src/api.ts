export const API_BASE = import.meta.env.DEV ? "http://127.0.0.1:8000" : "";

export const SEARCH_TYPE_SONG = "搜索歌曲";

type RequestJsonOptions = RequestInit & {
  timeoutMs?: number;
};

export type JsonResponse<T = unknown> = {
  ok: boolean;
  status: number;
  data: T;
};

export class ApiRequestError extends Error {
  status: number;
  data: unknown;

  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.data = data;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function errorMessage(error: unknown, fallback = "请求失败"): string {
  if (isAbortError(error)) return fallback;
  if (error instanceof ApiRequestError || error instanceof Error) return error.message || fallback;
  return fallback;
}

export async function requestJson<T = unknown>(
  path: string,
  { timeoutMs = 15_000, signal, ...init }: RequestJsonOptions = {},
): Promise<JsonResponse<T>> {
  const controller = new AbortController();
  const timeout = timeoutMs > 0 ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
  const abortFromParent = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromParent, { once: true });
  }

  try {
    const res = await fetch(`${API_BASE}${path}`, { ...init, signal: controller.signal });
    const data = (await res.json().catch(() => ({}))) as T;
    if (!res.ok) {
      const detail = data && typeof data === "object" && "detail" in data ? String((data as { detail?: unknown }).detail ?? "") : "";
      throw new ApiRequestError(detail || fallbackMessage(res.status), res.status, data);
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    if (timeout !== null) window.clearTimeout(timeout);
    if (signal) signal.removeEventListener("abort", abortFromParent);
  }
}

function fallbackMessage(status: number): string {
  return status > 0 ? `请求失败 (${status})` : "请求失败";
}
