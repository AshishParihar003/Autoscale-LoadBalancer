export const API_BASE_URL = 4000;

export type ApiStatus = "connected" | "not-configured";

export function getApiStatus(): ApiStatus {
  return API_BASE_URL ? "connected" : "not-configured";
}

/**
 * Small typed API helper. The UI deliberately does not pretend that cloud
 * provisioning has happened when no backend is configured.
 */
export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_BASE_URL) {
    throw new Error("Backend API is not configured. Set VITE_API_BASE_URL in your environment.");
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    throw new Error(`API request failed (${response.status})`);
  }

  return response.json() as Promise<T>;
}
