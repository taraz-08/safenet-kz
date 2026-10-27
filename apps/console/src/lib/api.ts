import { z } from "zod";
export class ApiError extends Error {
  constructor(message: string, public status: number, public kind: "http" | "network" | "schema" = "http") { super(message); this.name = "ApiError"; }
}
export async function api<T>(path: string, schema: z.ZodType<T>, options: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const multipart = options.body instanceof FormData;
  const { timeoutMs = multipart ? 180000 : 20000, ...requestOptions } = options;
  const headers = new Headers(options.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (multipart) headers.delete("Content-Type"); // The browser supplies the multipart boundary.
  else if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, { ...requestOptions, signal, credentials: "same-origin", cache: "no-store", headers });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError(timeout.aborted ? "timeout" : "network", 0, "network");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (timeout.aborted) throw new ApiError("timeout", 0, "network");
    if (!(error instanceof SyntaxError)) throw new ApiError("network", 0, "network");
    body = null; // Non-JSON proxy errors still retain their HTTP status below.
  }
  if (!response.ok) {
    const detail = body && typeof body === "object" && "detail" in body ? body.detail : null;
    throw new ApiError(typeof detail === "string" ? detail : `HTTP ${response.status}`, response.status);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError("schema", response.status, "schema");
  return parsed.data;
}
export function json(method: "POST" | "PATCH" | "DELETE", body?: unknown): RequestInit {
  return { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}
