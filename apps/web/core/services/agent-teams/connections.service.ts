/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * 外部系统连接服务（连接管理设计 §4）：工作区级凭据实体，
 * 掩码回显（凭据只写不读）、保存即测试由服务端完成。
 */
export type TConnectionType = "zentao" | "http_api";

export interface ExternalConnection {
  id: string;
  name: string;
  type: TConnectionType;
  config: Record<string, unknown>; // 掩码：地址明文，凭据 ••••
  status: "active" | "unreachable" | "untested";
  statusNote: string;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

const WS = (workspaceSlug: string) => `/api/workspaces/${workspaceSlug}`;

function csrfHeaders(): Record<string, string> {
  const match = typeof document !== "undefined" ? document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/) : null;
  return match ? { "X-CSRFToken": decodeURIComponent(match[1]) } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers, ...csrfHeaders() },
    credentials: "same-origin",
  });
  if (!response.ok) {
    let detail = response.statusText;
    let code = "";
    try {
      const body = await response.json();
      detail = body?.error ?? detail;
      code = body?.code ?? "";
    } catch { /* keep statusText */ }
    throw Object.assign(new Error(detail), { status: response.status, code });
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function listConnections(workspaceSlug: string, type?: string): Promise<ExternalConnection[]> {
  const query = type ? `?type=${encodeURIComponent(type)}` : "";
  return request(`${WS(workspaceSlug)}/connections/${query}`);
}

export async function createConnection(
  workspaceSlug: string,
  data: { name: string; type: TConnectionType; config: Record<string, unknown> },
): Promise<ExternalConnection> {
  return request(`${WS(workspaceSlug)}/connections/`, { method: "POST", body: JSON.stringify(data) });
}

export async function updateConnection(
  workspaceSlug: string,
  id: string,
  data: { name?: string; config?: Record<string, unknown> },
): Promise<ExternalConnection> {
  return request(`${WS(workspaceSlug)}/connections/${id}/`, { method: "PATCH", body: JSON.stringify(data) });
}

export async function deleteConnection(workspaceSlug: string, id: string): Promise<void> {
  await request(`${WS(workspaceSlug)}/connections/${id}/`, { method: "DELETE" });
}

export async function testConnection(
  workspaceSlug: string,
  id: string,
): Promise<{ status: ExternalConnection["status"]; statusNote: string }> {
  return request(`${WS(workspaceSlug)}/connections/${id}/test/`, { method: "POST" });
}

export const connectionsService = {
  listConnections,
  createConnection,
  updateConnection,
  deleteConnection,
  testConnection,
};
