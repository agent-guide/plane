/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository for details.
 *
 * Shared auth for the v1/experts backend, backed by the §12.6.7 BFF: the
 * Plane session is exchanged server-side (fork apps/api runtime-token
 * endpoint) for a short-lived Runtime user token. The token lives only in
 * module memory — no env tokens, no localStorage, no service credential in
 * the browser. 401 triggers one silent re-exchange + retry.
 */

import axios, { create as axiosCreate } from "axios";

const BASE_URL = (import.meta.env.VITE_EXPERTS_API_BASE_URL as string | undefined) ?? "";

/** Current workspace slug — the BFF exchange is workspace-scoped (identity
 * mappings key on connection + scope). Set by the agent-teams panels on
 * mount; calling before set throws a clear error. */
let workspaceSlug = "";

export function setExpertsWorkspaceSlug(slug: string) {
  workspaceSlug = slug;
}

type AuthState = { accessToken: string; tenantId: string; expiresAt: number };

let auth: AuthState | null = null;
let inflight: Promise<AuthState> | null = null;

async function exchange(): Promise<AuthState> {
  if (!workspaceSlug) {
    throw new Error("runtime auth requires the workspace slug (setExpertsWorkspaceSlug)");
  }
  // fork app API（会话鉴权）：绝对地址 + withCredentials，与 Plane 其余服务同形态。
  const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";
  const response = await axios.post(
    `${apiBase}/api/workspaces/${encodeURIComponent(workspaceSlug)}/agent-teams/runtime-token/`,
    {},
    { withCredentials: true }
  );
  const data = response.data?.data ?? response.data;
  if (!data?.accessToken || !data?.tenantId) {
    throw Object.assign(new Error("runtime token exchange failed"), {
      status: response.status,
    });
  }
  // Refresh 30s before expiry so a request never races the clock.
  const expiresIn = typeof data.expiresIn === "number" ? data.expiresIn : 900;
  auth = {
    accessToken: data.accessToken as string,
    tenantId: data.tenantId as string,
    expiresAt: Date.now() + Math.max(30, expiresIn - 30) * 1000,
  };
  return auth;
}

function ensureAuth(): Promise<AuthState> {
  if (auth && Date.now() < auth.expiresAt) return Promise.resolve(auth);
  inflight ??= exchange().finally(() => {
    inflight = null;
  });
  return inflight;
}

export function expertsBaseUrl() {
  return BASE_URL;
}

export async function expertsAuthHeaders(): Promise<Record<string, string>> {
  const current = await ensureAuth();
  return {
    "X-Tenant-ID": current.tenantId,
    Authorization: `Bearer ${current.accessToken}`,
  };
}

/** Drop the cached token — next request re-exchanges (used after a 401). */
export function invalidateExpertsAuth() {
  auth = null;
}

/** Authed axios instance WITHOUT the Plane 401-redirect interceptor. */
export const expertsHttp = axiosCreate({ baseURL: BASE_URL });

/** Request with one silent re-exchange + retry on 401. */
export async function expertsRequest<T>(fn: (headers: Record<string, string>) => Promise<T>): Promise<T> {
  try {
    return await fn(await expertsAuthHeaders());
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 401) {
      invalidateExpertsAuth();
      return await fn(await expertsAuthHeaders());
    }
    throw error;
  }
}
