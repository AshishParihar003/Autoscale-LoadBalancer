
/**
 * Same-origin API client.
 *
 * Production: Express serves the built frontend and API from one port.
 * Development: Vite proxies /api to the backend server.
 *
 * Never put ADMIN_TOKEN, SSH private keys, or other server secrets here.
 */

export const API_BASE_URL = "";

export async function apiRequest<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  const headers = new Headers(init?.headers);

  // Set a default only when the caller has not already provided a content type.
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;

  try {
    response = await fetch(`${API_BASE_URL}${normalizedPath}`, {
      ...init,
      headers
    });
  } catch {
    console.error("[API] Network request failed:", normalizedPath);

    throw new Error(
      "Cannot reach the backend API. Start the server or check the Vite development proxy."
    );
  }

  const contentType = response.headers.get("content-type") || "";
  let payload: any;

  if (contentType.includes("application/json")) {
    payload = await response.json().catch(() => ({}));
  } else {
    payload = {
      message: await response.text().catch(() => "")
    };
  }

  if (!response.ok) {
    const message =
      typeof payload?.message === "string"
        ? payload.message
        : typeof payload?.error === "string"
          ? payload.error
          : `Request failed (${response.status}) at ${normalizedPath}`;

    console.error("[API] Request failed:", {
      path: normalizedPath,
      status: response.status,
      message
    });

    throw new Error(message);
  }

  return payload as T;
}
