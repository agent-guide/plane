/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — team workflow library (设计修订 2026-10-08 阶段 3):
 * 工作流归属团队，编排/发布/元数据编辑在 Plane 团队详情完成。数据权威仍在
 * Agent Team Runtime（§17 红线：Plane 仅界面），全部经 runtime-token 通道调用。
 */
import { expertsHttp, expertsRequest } from "./experts-auth";

// ---- 画布文档（与 runtime workflows 契约一致的本地类型） ----
export type WorkflowGraphNodeData = {
  name: string;
  prompt?: string;
  tool_name?: string;
  connection?: string;
  params?: Record<string, unknown>;
  message?: string;
  [key: string]: unknown;
};
export type WorkflowGraphNode = {
  id: string;
  type: "agent" | "tool" | "human_confirm" | "condition";
  position?: { x: number; y: number };
  data: WorkflowGraphNodeData;
};
export type WorkflowGraph = {
  version: number;
  nodes: WorkflowGraphNode[];
  edges: Array<{ id?: string; source: string; target: string; label?: string }>;
};

export type TeamWorkflow = {
  id: string;
  teamId: string;
  name: string;
  description?: string | null;
  status: string;
  ownerExpertId?: string | null;
  engineConnectionId?: string | null;
  currentVersionId?: string | null;
  currentVersion?: number | null;
  graph?: WorkflowGraph | null;
  createdAt?: string;
  updatedAt?: string;
};

export type TeamWorkflowVersion = {
  id: string;
  workflowId: string;
  version: number;
  status: string;
  publishError?: string | null;
  definitionHash?: string;
  createdBy?: string | null;
  createdByName?: string | null;
  createdAt?: string;
  publishedAt?: string | null;
};

export type PublishedExpert = { id: string; name: string };
export type EngineConnectionOption = { id: string; name: string; engineType: string; status: string };
export type WorkflowToolCatalogEntry = {
  name: string;
  description?: string;
  connectionType?: string;
  params?: Array<{ name: string; required?: boolean; description?: string }>;
};

class AgentTeamWorkflowService {
  private base(teamId: string) {
    return `/api/v1/agent-teams/${teamId}/workflows`;
  }

  async listTeamWorkflows(teamId: string): Promise<TeamWorkflow[]> {
    const payload = await expertsRequest((headers) =>
      expertsHttp.get(`${this.base(teamId)}`, { headers }).then((r) => r.data)
    );
    return (payload as { items?: TeamWorkflow[] })?.items ?? [];
  }

  async getTeamWorkflow(teamId: string, workflowId: string): Promise<TeamWorkflow> {
    return expertsRequest((headers) =>
      expertsHttp.get(`${this.base(teamId)}/${workflowId}`, { headers }).then((r) => r.data)
    );
  }

  async createTeamWorkflow(
    teamId: string,
    data: {
      name: string;
      ownerExpertId: string;
      description?: string;
      engineConnectionId?: string | null;
      graph: WorkflowGraph;
    }
  ): Promise<TeamWorkflow> {
    return expertsRequest((headers) => expertsHttp.post(this.base(teamId), data, { headers }).then((r) => r.data));
  }

  async updateTeamWorkflow(
    teamId: string,
    workflowId: string,
    patch: {
      name?: string;
      description?: string;
      ownerExpertId?: string;
      engineConnectionId?: string | null;
      graph?: WorkflowGraph;
    }
  ): Promise<TeamWorkflow> {
    return expertsRequest((headers) =>
      expertsHttp.patch(`${this.base(teamId)}/${workflowId}`, patch, { headers }).then((r) => r.data)
    );
  }

  async deleteTeamWorkflow(teamId: string, workflowId: string): Promise<void> {
    await expertsRequest((headers) => expertsHttp.delete(`${this.base(teamId)}/${workflowId}`, { headers }));
  }

  /** 202 + publishing 版本；轮询 getVersion 到终态（复用管理端验证过的交互）。 */
  async publishTeamWorkflow(teamId: string, workflowId: string): Promise<TeamWorkflowVersion> {
    return expertsRequest((headers) =>
      expertsHttp.post(`${this.base(teamId)}/${workflowId}/publish`, {}, { headers }).then((r) => r.data)
    );
  }

  async getTeamWorkflowVersion(teamId: string, workflowId: string, versionId: string): Promise<TeamWorkflowVersion> {
    return expertsRequest((headers) =>
      expertsHttp.get(`${this.base(teamId)}/${workflowId}/versions/${versionId}`, { headers }).then((r) => r.data)
    );
  }

  async listTeamWorkflowVersions(teamId: string, workflowId: string): Promise<TeamWorkflowVersion[]> {
    const payload = await expertsRequest((headers) =>
      expertsHttp.get(`${this.base(teamId)}/${workflowId}/versions`, { headers }).then((r) => r.data)
    );
    return (payload as { items?: TeamWorkflowVersion[] })?.items ?? [];
  }

  // ---- 建项目即绑定（阶段 4）----
  /** 按团队列「可绑定」流程：已发布版本折叠为最新一条（表单联动下拉用）。 */
  async listBindableWorkflows(teamId: string): Promise<TeamWorkflow[]> {
    const all = await this.listTeamWorkflows(teamId);
    return all.filter((w) => w.status === "published" && w.currentVersionId);
  }

  /** 建项目即绑定：projectId 传 Plane 项目 UUID（idKind=external 服务端解析）。 */
  async createBindingForExternalProject(
    externalProjectId: string,
    input: { teamId: string; defaultWorkflowVersionId: string }
  ): Promise<{ id: string }> {
    return expertsRequest((headers) =>
      expertsHttp
        .post(`/api/v1/projects/${externalProjectId}/agent-team-binding?idKind=external`, input, { headers })
        .then((r) => r.data)
    );
  }

  /** 项目内切换流程：PATCH 绑定（idKind=external，改钉住的版本）。 */
  async updateBindingForExternalProject(
    externalProjectId: string,
    patch: { defaultWorkflowVersionId: string }
  ): Promise<unknown> {
    return expertsRequest((headers) =>
      expertsHttp
        .patch(`/api/v1/projects/${externalProjectId}/agent-team-binding?idKind=external`, patch, { headers })
        .then((r) => r.data)
    );
  }

  // ---- 画布目录（成员角色即可读：expert:read / task:manage） ----
  async listPublishedExperts(): Promise<PublishedExpert[]> {
    const payload = await expertsRequest((headers) =>
      expertsHttp.get("/api/v1/experts", { headers, params: { status: "published" } }).then((r) => r.data)
    );
    const items = (payload as { items?: Array<{ id: string; name: string; status?: string }> })?.items ?? [];
    return items.filter((e) => !e.status || e.status === "published").map((e) => ({ id: e.id, name: e.name }));
  }

  async listEngineConnections(): Promise<EngineConnectionOption[]> {
    const payload = await expertsRequest((headers) =>
      expertsHttp.get("/api/v1/workflow-engine-connections", { headers }).then((r) => r.data)
    );
    const items = Array.isArray(payload) ? payload : [];
    return (items as Array<{ id: string; name: string; engineKey: string; status: string }>).map((c) => ({
      id: c.id,
      name: c.name,
      engineType: c.engineKey,
      status: c.status,
    }));
  }

  async listWorkflowTools(): Promise<{ items: WorkflowToolCatalogEntry[]; connectionTypes: string[] }> {
    return expertsRequest((headers) => expertsHttp.get("/api/v1/workflow-tools", { headers }).then((r) => r.data));
  }

  /** 审批人候选：租户成员（与画布 human_confirm 的 approverUserId 契约一致）。 */
  async listTenantMembers(tenantId: string): Promise<Array<{ userId: string; name?: string; email?: string }>> {
    const payload = await expertsRequest((headers) =>
      expertsHttp.get(`/api/v1/tenants/${tenantId}/members`, { headers }).then((r) => r.data)
    );
    const items = (payload as { items?: Array<Record<string, unknown>> })?.items ?? [];
    return items.map((m) => ({
      userId: String(m.userId ?? m.user_id ?? m.id ?? ""),
      name: (m.name ?? m.displayName ?? undefined) as string | undefined,
      email: (m.email ?? undefined) as string | undefined,
    }));
  }
}

const agentTeamWorkflowService = new AgentTeamWorkflowService();
export default agentTeamWorkflowService;
