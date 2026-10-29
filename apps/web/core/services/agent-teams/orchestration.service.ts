/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Orchestration service（阶段 2′ 前端数据源切换）：调 Plane 自身编排域 API
 * （/api/workspaces/<slug>/orchestration/**），会话认证同源——不再走
 * runtime-token 换票（experts-auth）。方法签名对齐 runtime.service 的
 * 消费面，页面按域逐步切换 import。
 */

const WS = (workspaceSlug: string) => `/api/workspaces/${workspaceSlug}`;
const PJ = (workspaceSlug: string, projectId: string) => `${WS(workspaceSlug)}/projects/${projectId}`;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
    credentials: "same-origin",
  });
  if (!response.ok) {
    let detail: string = response.statusText;
    try {
      const body = await response.json();
      detail = body?.error ?? body?.detail ?? detail;
      if (body?.code) detail = `${detail} [${body.code}]`;
    } catch {
      /* keep statusText */
    }
    throw Object.assign(new Error(detail), { status: response.status });
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function csrfHeaders(): Record<string, string> {
  // Django CSRF：cookie/header 同名对（写请求需要）
  const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  return match ? { "X-CSRFToken": decodeURIComponent(match[1]) } : {};
}

// ---------------------------------------------------------------- 团队域

export interface OrchestrationTeam {
  id: string;
  name: string;
  objective: string;
  status: "draft" | "active" | "archived";
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
  // 列表端点 annotate 的信号行计数（详情响应不含）
  memberCount?: number;
  activeTaskCount?: number;
  runningRunCount?: number;
  // 管理动作可见性（详情/列表端点按请求者填充；前端只做展示）
  viewerCanManage?: boolean;
  viewerIsAdmin?: boolean;
  members?: OrchestrationTeamMember[];
}

/** 团队详情页「关联项目」（绑定全量返回，测试环境量级个位数）。 */
export interface OrchestrationTeamProject {
  projectId: string;
  externalProjectId: string;
  projectName: string;
  workflowName: string | null;
  workflowVersion: number | null;
  status: string;
}

/** 团队详情页「进行中工作项」——字段对齐旧 AgentTeamActiveTask 消费面。 */
export interface OrchestrationActiveTask {
  taskBindingId: string;
  issueId: string;
  externalProjectId: string;
  externalItemId: string;
  taskName: string;
  controlStatus: string;
  projectName: string;
  activeMemberName: string | null;
  updatedAt: string;
}

export interface OrchestrationTeamMember {
  id: string;
  kind: "human" | "agent";
  userId: string | null;
  agentDefinitionId: string;
  // 显示名：人类=Plane 显示名；数字员工=agwmngr 目录读时聚合（不可达为 null）
  displayName: string | null;
  role: string;
  capabilities: string[];
  sequence: number;
  enabled: boolean;
  updatedAt: string;
}

/** 加成员候选：租户 agent 目录（draft.name，缺名回退 slug）。 */
export interface OrchestrationAgentCatalogEntry {
  id: string;
  name: string;
  description: string;
}

export async function listAgentCatalog(workspace: string): Promise<OrchestrationAgentCatalogEntry[]> {
  return request(`${WS(workspace)}/agent-teams/agent-catalog/`);
}

export async function listTeams(workspace: string): Promise<OrchestrationTeam[]> {
  return request(`${WS(workspace)}/agent-teams/`);
}

export async function getTeam(workspace: string, teamId: string): Promise<OrchestrationTeam> {
  return request(`${WS(workspace)}/agent-teams/${teamId}/`);
}

export async function createTeam(
  workspace: string,
  data: { name: string; objective?: string }
): Promise<OrchestrationTeam> {
  return request(`${WS(workspace)}/agent-teams/`, {
    method: "POST",
    body: JSON.stringify(data),
    headers: csrfHeaders(),
  });
}

export async function updateTeam(
  workspace: string,
  teamId: string,
  data: { name?: string; objective?: string }
): Promise<OrchestrationTeam> {
  return request(`${WS(workspace)}/agent-teams/${teamId}/`, {
    method: "PATCH",
    body: JSON.stringify(data),
    headers: csrfHeaders(),
  });
}

export async function activateTeam(workspace: string, teamId: string): Promise<OrchestrationTeam> {
  return request(`${WS(workspace)}/agent-teams/${teamId}/activate/`, { method: "POST", headers: csrfHeaders() });
}

export async function archiveTeam(workspace: string, teamId: string): Promise<OrchestrationTeam> {
  return request(`${WS(workspace)}/agent-teams/${teamId}/archive/`, { method: "POST", headers: csrfHeaders() });
}

export interface OrchestrationTeamQuota {
  applies: boolean;
  quota: number;
  owned: number;
  remaining: number | null;
}

/** 配额提示（新建弹层预取，设计 §1.2 钩子②）：管理员 bypass，返回 applies=false。 */
export async function getTeamQuota(workspace: string): Promise<OrchestrationTeamQuota> {
  return request(`${WS(workspace)}/agent-teams/quota/`);
}

export async function listTeamProjects(workspace: string, teamId: string): Promise<OrchestrationTeamProject[]> {
  return request(`${WS(workspace)}/agent-teams/${teamId}/projects/`);
}

export async function listTeamActiveTasks(workspace: string, teamId: string): Promise<OrchestrationActiveTask[]> {
  return request(`${WS(workspace)}/agent-teams/${teamId}/active-tasks/`);
}

// ---------------------------------------------------------------- 成员域

export async function listMembers(workspace: string, teamId: string): Promise<OrchestrationTeamMember[]> {
  return request(`${WS(workspace)}/agent-teams/${teamId}/members/`);
}

export async function addMember(
  workspace: string,
  teamId: string,
  data: {
    kind: "human" | "agent";
    userId?: string;
    agentDefinitionId?: string;
    role: string;
    capabilities?: string[];
    sequence?: number;
  }
): Promise<OrchestrationTeamMember> {
  return request(`${WS(workspace)}/agent-teams/${teamId}/members/`, {
    method: "POST",
    body: JSON.stringify(data),
    headers: csrfHeaders(),
  });
}

export async function updateMember(
  workspace: string,
  teamId: string,
  memberId: string,
  data: { role?: string; capabilities?: string[]; sequence?: number; enabled?: boolean }
): Promise<OrchestrationTeamMember> {
  return request(`${WS(workspace)}/agent-teams/${teamId}/members/${memberId}/`, {
    method: "PATCH",
    body: JSON.stringify(data),
    headers: csrfHeaders(),
  });
}

export async function removeMember(workspace: string, teamId: string, memberId: string): Promise<void> {
  await request(`${WS(workspace)}/agent-teams/${teamId}/members/${memberId}/`, {
    method: "DELETE",
    headers: csrfHeaders(),
  });
}

// ---------------------------------------------------------------- 流程域

export interface OrchestrationWorkflow {
  id: string;
  name: string;
  description: string;
  engineKind: string;
  draft: Record<string, unknown>;
  // 列表端点摘要（with_summary）
  status?: string;
  currentVersion?: number | null;
  versions?: OrchestrationWorkflowVersion[];
  createdAt: string;
  updatedAt: string;
}

export interface OrchestrationWorkflowVersion {
  id: string;
  version: number;
  status: "draft" | "publishing" | "published" | "failed";
  contentHash: string;
  publishedAt: string | null;
}

export async function listWorkflows(workspace: string, projectId: string): Promise<OrchestrationWorkflow[]> {
  return request(`${PJ(workspace, projectId)}/workflows/`);
}

export async function getWorkflow(
  workspace: string,
  projectId: string,
  workflowId: string
): Promise<OrchestrationWorkflow> {
  return request(`${PJ(workspace, projectId)}/workflows/${workflowId}/`);
}

export async function createWorkflow(
  workspace: string,
  projectId: string,
  data: { name: string; description?: string }
): Promise<OrchestrationWorkflow> {
  return request(`${PJ(workspace, projectId)}/workflows/`, {
    method: "POST",
    body: JSON.stringify(data),
    headers: csrfHeaders(),
  });
}

export async function saveDraft(
  workspace: string,
  projectId: string,
  workflowId: string,
  draft: Record<string, unknown>
): Promise<OrchestrationWorkflow> {
  return request(`${PJ(workspace, projectId)}/workflows/${workflowId}/`, {
    method: "PATCH",
    body: JSON.stringify({ draft }),
    headers: csrfHeaders(),
  });
}

/** 元数据编辑（名称/描述）。 */
export async function updateWorkflowInfo(
  workspace: string,
  projectId: string,
  workflowId: string,
  data: { name?: string; description?: string }
): Promise<OrchestrationWorkflow> {
  return request(`${PJ(workspace, projectId)}/workflows/${workflowId}/`, {
    method: "PATCH",
    body: JSON.stringify(data),
    headers: csrfHeaders(),
  });
}

/** 删除流程（仍有活跃绑定引用时后端 409 WORKFLOW_IN_USE）。 */
export async function deleteWorkflow(workspace: string, projectId: string, workflowId: string): Promise<void> {
  await request(`${PJ(workspace, projectId)}/workflows/${workflowId}/`, {
    method: "DELETE",
    headers: csrfHeaders(),
  });
}

export async function saveDraftVersion(
  workspace: string,
  projectId: string,
  workflowId: string
): Promise<OrchestrationWorkflowVersion> {
  return request(`${PJ(workspace, projectId)}/workflows/${workflowId}/versions/`, {
    method: "POST",
    headers: csrfHeaders(),
  });
}

export async function publishVersion(
  workspace: string,
  projectId: string,
  workflowId: string,
  versionId: string
): Promise<OrchestrationWorkflowVersion> {
  return request(`${PJ(workspace, projectId)}/workflows/${workflowId}/versions/${versionId}/publish/`, {
    method: "POST",
    headers: csrfHeaders(),
  });
}

// ---------------------------------------------------------------- 绑定域

export interface OrchestrationBinding {
  id: string;
  projectId: string;
  teamId: string;
  workflowVersionId: string;
  status: "active" | "retired";
  updatedAt: string;
}

export async function listBindings(workspace: string, projectId: string): Promise<OrchestrationBinding[]> {
  return request(`${PJ(workspace, projectId)}/team-bindings/`);
}

export async function bindProject(
  workspace: string,
  projectId: string,
  data: { teamId: string; workflowVersionId: string }
): Promise<OrchestrationBinding> {
  return request(`${PJ(workspace, projectId)}/team-bindings/`, {
    method: "POST",
    body: JSON.stringify(data),
    headers: csrfHeaders(),
  });
}

export async function upgradeBinding(
  workspace: string,
  projectId: string,
  workflowVersionId: string
): Promise<OrchestrationBinding> {
  return request(`${PJ(workspace, projectId)}/team-bindings/`, {
    method: "PATCH",
    body: JSON.stringify({ workflowVersionId }),
    headers: csrfHeaders(),
  });
}

// ---------------------------------------------------------------- 执行与审批

/** 项目卡团队徽章（§12.2）：未绑定为 null。 */
export interface OrchestrationTeamPanel {
  projectId: string;
  teamId: string;
  teamName: string;
  activeAgentCount: number;
  waitingDecisionCount: number;
}

export async function getProjectTeamPanel(
  workspace: string,
  projectId: string
): Promise<OrchestrationTeamPanel | null> {
  // 未绑定为 204 空体 → null
  return (await request<OrchestrationTeamPanel | undefined>(`${PJ(workspace, projectId)}/team-panel/`)) ?? null;
}

export interface OrchestrationExecution {
  id: string;
  issueId: string;
  bindingId: string;
  businessStatus: string;
  currentMemberId: string | null;
  engineRunRef: string;
  version: number;
  completedAt: string | null;
  updatedAt: string;
}

export async function listExecutions(workspace: string, projectId: string): Promise<OrchestrationExecution[]> {
  return request(`${PJ(workspace, projectId)}/executions/`);
}

// ------------------------------------------------- 工作项运行时面板（§12.3）

/** 项目概览运行时区块：绑定 + 计数 + 最近运行动态。 */
export interface OrchestrationRuntimeBinding {
  id: string;
  teamId: string;
  teamName: string;
  workflowName: string | null;
  workflowVersion: number | null;
  workflowVersionId: string | null;
  updatedAt: string;
}

export interface OrchestrationRecentRun {
  runId: string;
  taskId: string;
  taskTitle: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface OrchestrationProjectRuntimeOverview {
  binding: OrchestrationRuntimeBinding | null;
  counts: { activeTasks: number; waitingHuman: number; runningAgents: number };
  /** 最近工作项的运行时标记（进行中执行）。 */
  tasks: Array<{ issueId: string; externalItemId: string; controlStatus: string }>;
  recentRuns: OrchestrationRecentRun[];
}

export async function getProjectRuntimeOverview(
  workspace: string,
  projectId: string
): Promise<OrchestrationProjectRuntimeOverview> {
  return request(`${PJ(workspace, projectId)}/runtime-overview/`);
}

export interface OrchestrationRuntimeArtifact {
  id: string;
  name: string;
  version: number;
  sizeBytes: number | null;
  contentUrl: string;
}

/** 结构化时间线事件——文案归前端 i18n（修复旧链服务端中文硬编码）。 */
export interface OrchestrationTimelineEvent {
  id: string;
  kind: "execution" | "node" | "approval";
  status: string;
  nodeKey: string | null;
  memberName: string | null;
  createdAt: string;
}

export interface OrchestrationWorkItemRuntime {
  executionId: string;
  businessStatus: string;
  teamId: string;
  teamName: string;
  currentMemberName: string | null;
  workflowStep: string | null;
  durationSeconds: number | null;
  engineRunRef: string;
  retryable: boolean;
  artifacts: OrchestrationRuntimeArtifact[];
  pendingApproval: OrchestrationApproval | null;
  timeline: OrchestrationTimelineEvent[];
}

/** 工作项运行时面板数据；未绑定（无执行记录）返回 null。 */
export async function getWorkItemRuntime(
  workspace: string,
  projectId: string,
  issueId: string
): Promise<OrchestrationWorkItemRuntime | null> {
  return (
    (await request<OrchestrationWorkItemRuntime | undefined>(
      `${PJ(workspace, projectId)}/work-items/${issueId}/runtime/`
    )) ?? null
  );
}

/** 取消当前执行（非终态；终态 409）。 */
export async function cancelWorkItemExecution(workspace: string, projectId: string, issueId: string): Promise<void> {
  await request(`${PJ(workspace, projectId)}/work-items/${issueId}/runtime/`, {
    method: "POST",
    headers: csrfHeaders(),
  });
}

export async function startExecution(
  workspace: string,
  projectId: string,
  issueId: string
): Promise<OrchestrationExecution> {
  return request(`${PJ(workspace, projectId)}/executions/start/`, {
    method: "POST",
    body: JSON.stringify({ issueId }),
    headers: csrfHeaders(),
  });
}

/** 审批选项（definition 快照）：label 展示 / value 机器值 / terminal 终止分支。 */
export interface OrchestrationApprovalOption {
  label: string;
  value: string;
  terminal?: boolean;
}

export interface OrchestrationApproval {
  id: string;
  executionId: string;
  nodeRef: string;
  question: string;
  options: OrchestrationApprovalOption[];
  freeText: boolean;
  result: "pending" | "approved" | "rejected";
  reason: string;
  answeredAt: string | null;
  createdAt: string;
  // 消费面上下文（卡片列表/详情头）
  teamId: string;
  teamName: string;
  projectId: string;
  issueId: string;
  taskTitle: string;
}

export async function listMyApprovals(workspace: string): Promise<OrchestrationApproval[]> {
  return request(`${WS(workspace)}/agent-teams/approvals/`);
}

export async function answerApproval(
  workspace: string,
  approvalId: string,
  decision: "approved" | "rejected",
  reason?: string
): Promise<{ id: string; result: string }> {
  return request(`${WS(workspace)}/agent-teams/approvals/${approvalId}/`, {
    method: "POST",
    body: JSON.stringify({ decision, reason }),
    headers: csrfHeaders(),
  });
}

/** 单例便捷封装（workspaceSlug 由调用方从路由 params 传入）。 */
export const orchestrationService = {
  listTeams,
  getTeam,
  createTeam,
  updateTeam,
  activateTeam,
  archiveTeam,
  getTeamQuota,
  listTeamProjects,
  listTeamActiveTasks,
  listMembers,
  listAgentCatalog,
  addMember,
  updateMember,
  removeMember,
  listWorkflows,
  getWorkflow,
  createWorkflow,
  saveDraft,
  updateWorkflowInfo,
  deleteWorkflow,
  saveDraftVersion,
  publishVersion,
  listBindings,
  bindProject,
  upgradeBinding,
  listExecutions,
  startExecution,
  getProjectTeamPanel,
  getProjectRuntimeOverview,
  getWorkItemRuntime,
  cancelWorkItemExecution,
  listMyApprovals,
  answerApproval,
};
