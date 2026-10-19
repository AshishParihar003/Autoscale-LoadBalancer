/**
 * Same-origin API client. Production Express serves both Vite's built frontend
 * and the API from one port. Vite proxies /api to localhost:4000 in dev.
 */
export const API_BASE_URL = "";

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${normalizedPath}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {})
      }
    });
  } catch {
    throw new Error("Cannot reach the backend API. Start the server or check the Vite development proxy.");
  }

  const contentType = response.headers.get("content-type") || "";
  const payload: any = contentType.includes("application/json")
    ? await response.json().catch(() => ({}))
    : { message: await response.text().catch(() => "") };

  if (!response.ok) {
    const message = typeof payload?.message === "string" ? payload.message
      : typeof payload?.error === "string" ? payload.error
      : `Request failed (${response.status}) at ${normalizedPath}`;
    throw new Error(message);
  }
  return payload as T;
}
