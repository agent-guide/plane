/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Shared auth for the v1/experts backend (extracted from chat.service so
 * runtime.service reuses the same lifecycle): env-bootstrapped tokens with
 * localStorage caching and a silent 401 → refresh → retry. The P4 BFF
 * replaces this whole module later.
 */
import axios, { create as axiosCreate } from "axios";

const BASE_URL = (import.meta.env.VITE_EXPERTS_API_BASE_URL as string | undefined) ?? "";
const TENANT_ID = (import.meta.env.VITE_EXPERTS_TENANT_ID as string | undefined) ?? "";

// Versioned: bump when the backend is reset (new DB/tenant) so stale cached
// tokens self-invalidate instead of 401-ing forever.
const STORAGE_KEY = "agent-teams-auth-v2";

type AuthState = { accessToken: string; refreshToken: string };

function loadAuth(): AuthState | null {
  if (typeof window !== "undefined") {
    try {
      const cached = window.localStorage.getItem(STORAGE_KEY);
      if (cached) return JSON.parse(cached) as AuthState;
    } catch {
      // fall through to env
    }
  }
  const accessToken = (import.meta.env.VITE_EXPERTS_API_TOKEN as string | undefined) ?? "";
  const refreshToken = (import.meta.env.VITE_EXPERTS_REFRESH_TOKEN as string | undefined) ?? "";
  return accessToken ? { accessToken, refreshToken } : null;
}

let auth: AuthState | null = loadAuth();

function saveAuth(next: AuthState | null) {
  auth = next;
  if (typeof window !== "undefined") {
    if (next) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else window.localStorage.removeItem(STORAGE_KEY);
  }
}

export function expertsBaseUrl() {
  return BASE_URL;
}

export function expertsAuthHeaders(): Record<string, string> {
  return {
    "X-Tenant-ID": TENANT_ID,
    ...(auth?.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {}),
  };
}

/** Dev fallback: static env tokens expire in 15 minutes; log in with the
 * dev account instead of hand-rotating env values (removed with the BFF). */
export async function devLogin(): Promise<void> {
  const email = (import.meta.env.VITE_EXPERTS_DEV_EMAIL as string | undefined) ?? "";
  const password = (import.meta.env.VITE_EXPERTS_DEV_PASSWORD as string | undefined) ?? "";
  if (!email || !password) throw new Error("experts auth expired without dev credentials");
  const response = await axios.post(
    `${BASE_URL}/api/v1/auth/login`,
    { email, password },
    { headers: { "X-Tenant-ID": TENANT_ID } }
  );
  const data = response.data?.data ?? response.data;
  if (!data?.accessToken) throw new Error("experts dev login failed");
  saveAuth({ accessToken: data.accessToken, refreshToken: data.refreshToken ?? "" });
}

export async function refreshExpertsAuth(): Promise<void> {
  if (!auth?.refreshToken) return devLogin();
  const response = await axios
    .post(
      `${BASE_URL}/api/v1/auth/refresh`,
      { refreshToken: auth.refreshToken },
      { headers: { "X-Tenant-ID": TENANT_ID } }
    )
    .catch(() => null);
  const data = response?.data?.data ?? response?.data;
  if (!data?.accessToken) return devLogin();
  saveAuth({ accessToken: data.accessToken, refreshToken: data.refreshToken ?? auth.refreshToken });
}

/** Authed axios instance WITHOUT the Plane 401-redirect interceptor. */
export const expertsHttp = axiosCreate({ baseURL: BASE_URL });

/** Request with one silent token refresh + retry on 401. */
export async function expertsRequest<T>(fn: (headers: Record<string, string>) => Promise<T>): Promise<T> {
  try {
    return await fn(expertsAuthHeaders());
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 401) {
      await refreshExpertsAuth();
      return await fn(expertsAuthHeaders());
    }
    throw error;
  }
}
