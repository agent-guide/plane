/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt in the repository root for details.
 *
 * Agent Teams extension — Runtime API client (design §12.6.6 thin-extension
 * component; §12.6.7 auth boundary). Talks ONLY to the stable Runtime HTTP
 * contract (implementation plan §9, frozen 42d4b3c) and never imports Runtime
 * source code.
 *
 * Auth (§12.6.7): every call runs through the BFF-exchanged short-lived
 * Runtime user token (see ./experts-auth); VITE_EXPERTS_API_BASE_URL points
 * at the Runtime deployment.
 */
import { expertsBaseUrl, expertsHttp, expertsRequest } from "./experts-auth";

// ---------------------------------------------------------------------------
// Contract types (implementation plan §5.8–5.10, camelCase schemas)
// ---------------------------------------------------------------------------

export type HumanInboxScope = "workflow" | "agent";

/**
 * Context values on human requests. The frozen backend contract types them
 * as JSON `Any`, but every observed producer writes scalar values — string
 * values may carry full markdown documents (e.g. the "text" checklist key),
 * which render through MarkdownPreview. Declared here so consumers can
 * branch on `typeof value === "string"` without casting.
 */
export type HumanInboxContextValue = string | number | boolean | null;

export type HumanInboxItem = {
  scope: HumanInboxScope;
  // workflow scope → workflow_run_nodes.id; agent scope → agent_human_requests.id.
  requestId: string;
  tenantId: string;
  taskBindingId: string;
  // Card-summary enrichment (§12.6.4) — task name plus the Provider (Plane)
  // ids for project naming / deep links; absent for locally-originated tasks.
  taskId?: string | null;
  taskTitle?: string | null;
  // Team enrichment — the approval detail names the responsible team and
  // deep-links to its page.
  teamId?: string | null;
  teamName?: string | null;
  externalScopeId?: string | null;
  externalProjectId?: string | null;
  externalItemId?: string | null;
  // Project scope for context-filtered views (Q9: NOT in the frozen §5.10
  // projection — needs a contract addition or a server-side query param).
  projectId?: string | null;
  assignedIdentityId?: string | null;
  title?: string | null;
  status: string;
  // Agent scope only.
  deliveryStatus?: "not_started" | "pending" | "delivered" | "failed" | "unknown" | null;
  createdAt?: string;
};

export type HumanInboxDetail = {
  scope: HumanInboxScope;
  requestId: string;
  taskBindingId: string;
  workflowRunId?: string | null;
  nodeKey?: string | null;
  agentRunId?: string | null;
  assignedIdentityId?: string | null;
  kind: "choice" | "text" | "form" | null;
  title?: string | null;
  question?: string | null;
  options?: Array<{ value: string; label: string }> | null;
  context?: Record<string, HumanInboxContextValue> | null;
  status: string;
  // Agent scope only.
  deliveryStatus?: HumanInboxItem["deliveryStatus"];
  createdAt?: string;
};

// ---------------------------------------------------------------------------
// Team queries (implementation plan §9; read-only in Plane per design §12.6.1
// — member/policy management lives in the admin console).
// ---------------------------------------------------------------------------

export type AgentTeam = {
  id: string;
  name: string;
  objective?: string | null;
  status: "draft" | "active" | "archived";
  // Derived counts for list cards / overview.
  memberCount?: number;
  activeTaskCount?: number;
  runningRunCount?: number;
  artifactCount?: number;
};

/** Runtime identity directory entry (§5.1) — display fields for members. */
export type RuntimeIdentity = {
  id: string;
  kind: "human" | "agent";
  displayName?: string;
  userId?: string | null;
  expertId?: string | null;
};

export type AgentTeamMember = {
  id: string;
  identityId: string;
  kind: "human" | "agent";
  displayName: string;
  role: string;
  capabilities?: string[];
  enabled: boolean;
  // Plane user id — enables the member task-mode deep link (profile's
  // assigned view). Applies to humans AND agents (design §5.2: agents are
  // Bot users that carry assignments).
  planeUserId?: string | null;
  // Agent members: the expert this member runs as — chat sessions bind by
  // expertId, so the member chat entry must deep link with it.
  expertId?: string | null;
};

export type AgentTeamProject = {
  projectId: string;
  projectName: string;
  workflowName?: string | null;
  workflowVersion?: number | null;
};

export type AgentTeamActiveTask = {
  // The list endpoint returns full rows; the read-only surface reads this
  // subset (binding `id` doubles as taskBindingId).
  taskBindingId: string;
  id?: string;
  taskName: string;
  projectName?: string | null;
  controlStatus: "queued" | "running" | "waiting_human" | "blocked" | "failed" | "completed" | "cancelled";
  // 状态视图（后端按项目打标状态解析）：显示跟着数据走，优先于翻译词表。
  stateName?: string | null;
  stateColor?: string | null;
  activeMemberName?: string | null;
  externalItemId?: string | null;
  externalProjectId?: string | null;
  updatedAt?: string | null;
};

export type ProjectRuntimeBinding = {
  id: string;
  teamId: string;
  teamName: string;
  workflowName?: string | null;
  workflowVersion?: number | null;
  engineName?: string | null;
  updatedAt: string;
};

export type ProjectRuntimeTask = {
  taskId: string;
  title: string;
  externalItemId?: string | null;
  controlStatus: "queued" | "running" | "waiting_human" | "blocked" | "failed" | "completed" | "cancelled";
  // 状态视图（后端按项目打标状态解析）：显示跟着数据走，优先于翻译词表。
  stateName?: string | null;
  stateColor?: string | null;
  currentMemberName?: string | null;
  updatedAt: string;
};

export type ProjectRuntimeRun = {
  runId: string;
  taskId: string;
  taskTitle: string;
  status: string;
  startedAt: string;
  finishedAt: string;
};

export type ProjectRuntimeOverview = {
  projectId: string;
  binding: ProjectRuntimeBinding | null;
  counts: { activeTasks: number; waitingHuman: number; runningAgents: number };
  tasks: ProjectRuntimeTask[];
  recentRuns: ProjectRuntimeRun[];
};

export type WorkItemRuntimeSummary = {
  issueId: string;
  taskBindingId: string;
  // Internal task id — retry target for the §8 controlled-start command.
  taskId: string;
  taskName: string;
  teamId: string;
  teamName: string;
  currentMemberName?: string | null;
  workflowStep?: string | null;
  controlStatus: "queued" | "running" | "waiting_human" | "blocked" | "failed" | "completed" | "cancelled";
  // 状态视图（后端按项目打标状态解析）：显示跟着数据走，优先于翻译词表。
  stateName?: string | null;
  stateColor?: string | null;
  // Active workflow run — cancel target and View-full-run deep link.
  workflowRunId?: string | null;
  // Accumulated execution metrics (design §12.3).
  durationSeconds?: number | null;
  costUsd?: number | null;
  artifacts?: RuntimeArtifact[];
  // Inline approval entry (design §12.6.4): the waiting human decision for
  // this work item, if any. Null when nothing awaits.
  pendingApproval?: HumanInboxItem | null;
};

/** One deliverable of a work item's run (summary + preview + download flows). */
export type RuntimeArtifact = {
  id: string;
  name: string;
  version: number;
  mimeType?: string | null;
  sizeBytes?: number | null;
};

export type ProjectTeamPanel = {
  projectId: string;
  projectName: string;
  teamId: string;
  teamName: string;
  workflowName?: string | null;
  workflowVersion?: number | null;
  activeAgentCount?: number;
  waitingDecisionCount?: number;
};

export type WorkItemTimelineEntry = {
  id: string;
  kind: string; // e.g. task.bound | handoff | agent_run | human_task
  summary: string;
  createdAt?: string;
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class AgentTeamRuntimeService {
  // Deliberately NOT extending APIService: its 401 interceptor redirects to
  // the Plane login (redirect loop against the v1 backend). All calls go
  // through the shared expertsHttp (silent refresh) instead.

  /** GET /api/v1/runtime/human-inbox — read-only projection of both scopes. */
  async listHumanInbox(): Promise<HumanInboxItem[]> {
    const payload = await expertsRequest((headers) =>
      expertsHttp.get("/api/v1/runtime/human-inbox", { headers }).then((r) => r.data)
    );
    // v1 wraps lists ({items}) — normalize to a bare array.
    return (payload as { items?: HumanInboxItem[] })?.items ?? (Array.isArray(payload) ? payload : []);
  }

  /** Detail for one inbox item, resolving scope to the right shape. */
  async getHumanInboxDetail(item: HumanInboxItem): Promise<HumanInboxDetail> {
    const url =
      item.scope === "workflow"
        ? `/api/v1/runtime/workflow-human-nodes/${item.requestId}`
        : `/api/v1/runtime/agent-human-requests/${item.requestId}`;
    const data = await expertsRequest((headers) => expertsHttp.get(url, { headers }).then((r) => r.data));
    // Both detail endpoints key the row as "id" — map to the inbox item's
    // requestId so the page can route the answer without re-deriving it.
    return { scope: item.scope, requestId: (data as { id?: string })?.id ?? item.requestId, ...data };
  }

  /**
   * POST /api/v1/runtime/workflow-human-nodes/{id}/answer or
   * POST /api/v1/runtime/agent-human-requests/{id}/answer — scope-routed
   * command with its own authorization and idempotency key (§2.6: the inbox
   * itself never exposes a shared answer state machine).
   */
  async answerHumanInboxItem(item: HumanInboxItem, answer: Record<string, unknown>): Promise<void> {
    const url =
      item.scope === "workflow"
        ? `/api/v1/runtime/workflow-human-nodes/${item.requestId}/answer`
        : `/api/v1/runtime/agent-human-requests/${item.requestId}/answer`;
    // idempotencyKey is REQUIRED by both answer endpoints (§2.6: the two
    // scopes never share an idempotency space). Key = scope + requestId + a
    // content digest, so retapping the same option replays safely while a
    // different answer to the same item gets a distinct key.
    const idempotencyKey = `${item.scope}:${item.requestId}:${JSON.stringify(answer)}`;
    await expertsRequest((headers) => expertsHttp.post(url, { answer, idempotencyKey }, { headers }));
  }

  /** GET /api/v1/agent-teams */
  async listTeams(): Promise<AgentTeam[]> {
    const payload = await expertsRequest((headers) =>
      expertsHttp.get("/api/v1/agent-teams", { headers }).then((r) => r.data)
    );
    return (payload as { items?: AgentTeam[] })?.items ?? (Array.isArray(payload) ? payload : []);
  }

  /** GET /api/v1/agent-teams/{team_id} */
  async getTeam(teamId: string): Promise<AgentTeam> {
    return expertsRequest((headers) =>
      expertsHttp.get(`/api/v1/agent-teams/${teamId}`, { headers }).then((r) => r.data)
    );
  }

  /** GET /api/v1/runtime/identities — id/kind/displayName/userId/expertId. */
  async listIdentities(): Promise<RuntimeIdentity[]> {
    const payload = await expertsRequest((headers) =>
      expertsHttp.get("/api/v1/runtime/identities", { headers }).then((r) => r.data)
    );
    return (payload as { items?: RuntimeIdentity[] })?.items ?? (Array.isArray(payload) ? payload : []);
  }

  /** GET /api/v1/agent-teams/{team_id}/members — read-only in Plane (§12.6.1). */
  async listTeamMembers(teamId: string): Promise<AgentTeamMember[]> {
    const [payload, identities] = await Promise.all([
      expertsRequest((headers) =>
        expertsHttp.get(`/api/v1/agent-teams/${teamId}/members`, { headers }).then((r) => r.data)
      ),
      // The members contract carries identityId only; enrich display fields
      // from the runtime identity directory (displayName/kind live there).
      this.listIdentities().catch(() => []),
    ]);
    const byIdentity = new Map(identities.map((identity) => [identity.id, identity]));
    const members = (payload as { items?: AgentTeamMember[] })?.items ?? (Array.isArray(payload) ? payload : []);
    return members.map((member) => {
      const identity = byIdentity.get(member.identityId);
      return Object.assign({}, member, {
        displayName: member.displayName ?? identity?.displayName ?? member.role,
        kind: member.kind ?? identity?.kind,
        planeUserId: member.planeUserId ?? identity?.userId ?? undefined,
        expertId: member.expertId ?? identity?.expertId ?? undefined,
      });
    });
  }

  /** GET /api/v1/agent-teams/{team_id}/projects */
  async listTeamProjects(
    teamId: string,
    page = 1,
    pageSize = 10
  ): Promise<{ items: AgentTeamProject[]; total: number }> {
    // Paged {items, total} — the team detail page renders pages incrementally
    // (Plane-native load-more), appending until total is reached.
    const payload = await expertsRequest((headers) =>
      expertsHttp
        .get(`/api/v1/agent-teams/${teamId}/projects`, { params: { page, page_size: pageSize }, headers })
        .then((r) => r.data)
    );
    if (Array.isArray(payload)) return { items: payload, total: payload.length };
    const paged = payload as { items?: AgentTeamProject[]; total?: number };
    return { items: paged?.items ?? [], total: paged?.total ?? paged?.items?.length ?? 0 };
  }

  // Team-dimension list endpoints (Q9): active-tasks is unpaged and returns
  // in-flight work items only — the team detail page's active work-items
  // section. Runs/artifacts lists are admin-console surfaces; per-item
  // progress and deliverables live on the work-item panel.

  async listTeamActiveTasks(teamId: string): Promise<AgentTeamActiveTask[]> {
    try {
      const payload = await expertsRequest((headers) =>
        expertsHttp.get(`/api/v1/agent-teams/${teamId}/active-tasks`, { headers }).then((r) => r.data)
      );
      const items = (Array.isArray(payload)
        ? payload
        : (payload as { items?: Array<AgentTeamActiveTask & { taskId?: string }> })?.items ?? []) as Array<
        AgentTeamActiveTask & { taskId?: string }
      >;
      // Normalize: the user-facing row keys on `id` (task binding id).
      return items.map((item) => ({ ...item, taskBindingId: item.taskBindingId ?? item.id ?? "" }));
    } catch {
      return [];
    }
  }

  /**
   * Project → responsible team panel (design §12.2)。已联调：
   * GET /api/v1/projects/{externalId}/agent-team-panel（backend overview 聚合）。
   * 契约：未绑定是正常态（200 + panel:null），404 只代表接口不存在——
   * 业务空态不得占用错误码；此处 404 不再吞，作为真故障浮出。
   */
  async getProjectTeamPanel(projectId: string): Promise<ProjectTeamPanel | null> {
    return expertsRequest((headers) =>
      expertsHttp
        .get(`/api/v1/projects/${projectId}/agent-team-panel`, { headers })
        .then((r) => (r.data as { panel: ProjectTeamPanel | null }).panel)
    );
  }

  /**
   * Runtime summary for one Plane work item (design §12.3 Task Runtime
   * panel). Assumed endpoint — §9 freezes task-dimension reads only; the
   * issueId → taskBinding resolution lives in the Runtime projection and
   * needs a query contract before 联调. Unbound/not-governed → null (the
   * panel renders its quiet unbound state).
   */
  async getWorkItemRuntimeSummary(issueId: string): Promise<WorkItemRuntimeSummary | null> {
    try {
      return await expertsRequest((headers) =>
        expertsHttp.get(`/api/v1/runtime/work-items/${issueId}/summary`, { headers }).then((r) => r.data)
      );
    } catch {
      return null;
    }
  }

  /** Presigned download URL for a runtime artifact (opens the deliverable).
   * The backend returns a path-absolute URL; resolving it against the fork
   * origin 404s — anchor it to the Runtime API base instead. */
  async getArtifactDownloadUrl(artifactId: string): Promise<string> {
    const payload = await expertsRequest((headers) =>
      expertsHttp
        .get<{ downloadUrl: string }>(`/api/v1/runtime/artifacts/${artifactId}/download-url`, { headers })
        .then((r) => r.data)
    );
    const url = payload.downloadUrl;
    return url.startsWith("/") ? `${expertsBaseUrl()}${url}` : url;
  }

  /** Execution timeline for the work item panel (design §12.3). */
  async getWorkItemTimeline(issueId: string): Promise<WorkItemTimelineEntry[]> {
    try {
      return await expertsRequest((headers) =>
        expertsHttp.get(`/api/v1/runtime/work-items/${issueId}/timeline`, { headers }).then((r) => r.data)
      );
    } catch {
      return [];
    }
  }

  /**
   * Cancel the active workflow run of a runtime-managed work item
   * (design §12.6.4 command; implementation §9: reuses the existing
   * POST /api/v1/workflow-runs/{run_id}/cancel, requires runtime:control).
   * Pause has no contract — deliberately not offered.
   */
  async cancelWorkItemRun(workflowRunId: string): Promise<void> {
    await expertsRequest((headers) =>
      expertsHttp.post(`/api/v1/workflow-runs/${workflowRunId}/cancel`, {}, { headers })
    );
  }

  /**
   * Retry a terminal (failed/cancelled) run of a runtime-managed work item
   * (design §12.6.4 command; implementation plan §8 retry contract): a fresh
   * controlled start on the same task — new run + new binding linked to the
   * terminal one via retryOfBindingId; the terminal binding is never revived.
   */
  async retryWorkItemTask(taskId: string, retryOfBindingId: string): Promise<void> {
    await expertsRequest((headers) =>
      expertsHttp.post(
        `/api/v1/runtime/tasks/${taskId}/start`,
        {
          idempotencyKey: `plane-retry:${retryOfBindingId}:${Date.now()}`,
          origin: "auto",
          retryOfBindingId,
        },
        { headers, timeout: 180_000 }
      )
    );
  }

  /** GET /api/v1/runtime/projects/{project_id}/overview — project-dimension
   * aggregate (design §12.2 backing query). The fork only holds the Plane
   * project UUID; the backend resolves it through the Work Management project
   * mapping (Q9-⑥ addressing). */
  async getProjectRuntimeOverview(projectId: string): Promise<ProjectRuntimeOverview> {
    return expertsRequest((headers) =>
      expertsHttp
        .get(`/api/v1/runtime/projects/${projectId}/overview`, {
          headers,
          params: { idKind: "external" },
        })
        .then((r) => r.data)
    );
  }

  /**
   * The current user's Runtime identity id (§12.6.7): /auth/me carries the
   * user id, the identity directory maps userId → identity. Empty string
   * when no identity maps to this user (no team membership) — "assigned to
   * me" filters then simply match nothing.
   */
  async getCurrentRuntimeIdentityId(): Promise<string> {
    try {
      const [me, identities] = await Promise.all([
        expertsRequest((headers) =>
          expertsHttp.get<{ id?: string }>("/api/v1/auth/me", { headers }).then((r) => r.data)
        ),
        this.listIdentities(),
      ]);
      return identities.find((identity) => identity.userId && identity.userId === me.id)?.id ?? "";
    } catch {
      return "";
    }
  }
}

const runtimeService = new AgentTeamRuntimeService();

export default runtimeService;
