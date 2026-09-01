/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — Runtime API client (design §12.6.6 thin-extension
 * component; §12.6.7 auth boundary). Talks ONLY to the stable Runtime HTTP
 * contract (implementation plan §9, frozen 42d4b3c) and never imports Runtime
 * source code.
 *
 * Auth note (§12.6.7): in production this must run behind the plane-api BFF
 * exchanging the Plane session for a short-lived Runtime user token. Until
 * that lands (P4), the client is mock-by-default: set
 * VITE_RUNTIME_API_MOCK=0 and VITE_RUNTIME_API_BASE_URL to point at a real
 * Runtime deployment for联调.
 */
import { APIService } from "../api.service";

// ---------------------------------------------------------------------------
// Contract types (implementation plan §5.8–5.10, camelCase schemas)
// ---------------------------------------------------------------------------

export type HumanInboxScope = "workflow" | "agent";

export type HumanInboxItem = {
  scope: HumanInboxScope;
  // workflow scope → workflow_run_nodes.id; agent scope → agent_human_requests.id.
  requestId: string;
  tenantId: string;
  taskBindingId: string;
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
  context?: Record<string, unknown> | null;
  status: string;
  // Agent scope only.
  deliveryStatus?: HumanInboxItem["deliveryStatus"];
  createdAt?: string;
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const MOCK = import.meta.env.VITE_RUNTIME_API_MOCK !== "0";
const BASE_URL = (import.meta.env.VITE_RUNTIME_API_BASE_URL as string | undefined) ?? "/runtime-api";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// §7 时序断点快照：一个 workflow 级审批 + 一个 agent 级授权请求。
// 两个独立可变状态：回答走各自端点，互不共享状态机（实施 §2.6）。
let mockWorkflowNode = {
  id: "wn_review_1",
  taskBindingId: "tb_1",
  workflowRunId: "wfr_1",
  nodeKey: "review",
  assignedIdentityId: "id_human_pm",
  kind: "choice" as const,
  title: "需求评审",
  question: "是否批准 BA Agent 产出的需求文档（v3）？",
  options: [
    { value: "approve", label: "批准" },
    { value: "reject", label: "驳回" },
    { value: "request_changes", label: "要求修改" },
  ],
  context: { artifactKey: "requirements", artifactVersion: 3 },
  status: "waiting_approval",
  createdAt: "2026-08-31T10:12:00Z",
};

let mockAgentRequest = {
  id: "ahr_1",
  taskBindingId: "tb_1",
  agentRunId: "ar_2",
  gatewayRequestId: "gw_req_7",
  assignedIdentityId: "id_human_pm",
  kind: "permission" as const,
  title: "生产数据库访问授权",
  question: "Developer Agent 请求读取生产库 orders 表以复现缺陷，是否授权？",
  options: [
    { value: "approve", label: "授权" },
    { value: "reject", label: "拒绝" },
  ],
  context: { table: "orders", scope: "read-only" },
  status: "pending",
  deliveryStatus: "not_started" as HumanInboxItem["deliveryStatus"],
  createdAt: "2026-08-31T10:20:00Z",
};

// text 型请求（§5.8 human_kind = text）：无固定选项，需要自由文本回答。
let mockAgentTextRequest = {
  id: "ahr_2",
  taskBindingId: "tb_1",
  agentRunId: "ar_1",
  gatewayRequestId: "gw_req_9",
  assignedIdentityId: "id_human_pm",
  kind: "text" as const,
  title: "需求澄清",
  question: "「支持批量导入」是指 Excel 模板导入还是 API 批量创建？请说明预期场景。",
  options: null,
  context: { requirement: "REQ-1024", source: "需求文档 v3 §2.3" },
  status: "pending",
  deliveryStatus: "not_started" as HumanInboxItem["deliveryStatus"],
  createdAt: "2026-08-31T10:30:00Z",
};

// 当前用户的 Runtime Identity（§12.6.7 真实场景由 BFF 用 Plane session 换取；
// mock 里即 assignedIdentityId = id_human_pm 的那个人）。
const MOCK_CURRENT_IDENTITY_ID = "id_human_pm";

export class AgentTeamRuntimeService extends APIService {
  constructor() {
    super(BASE_URL);
  }

  /** GET /api/v1/runtime/human-inbox — read-only projection of both scopes. */
  async listHumanInbox(): Promise<HumanInboxItem[]> {
    if (MOCK) {
      await delay(120);
      const items: HumanInboxItem[] = [];
      if (mockWorkflowNode.status === "waiting_approval") {
        items.push({
          scope: "workflow",
          requestId: mockWorkflowNode.id,
          tenantId: "tenant_default",
          taskBindingId: mockWorkflowNode.taskBindingId,
          assignedIdentityId: mockWorkflowNode.assignedIdentityId,
          title: mockWorkflowNode.title,
          status: mockWorkflowNode.status,
          createdAt: mockWorkflowNode.createdAt,
        });
      }
      for (const req of [mockAgentRequest, mockAgentTextRequest]) {
        if (req.status !== "pending") continue;
        items.push({
          scope: "agent",
          requestId: req.id,
          tenantId: "tenant_default",
          taskBindingId: req.taskBindingId,
          assignedIdentityId: req.assignedIdentityId,
          title: req.title,
          status: req.status,
          deliveryStatus: req.deliveryStatus,
          createdAt: req.createdAt,
        });
      }
      return items;
    }
    return (await this.get("/api/v1/runtime/human-inbox")).data;
  }

  /** Detail for one inbox item, resolving scope to the right shape. */
  async getHumanInboxDetail(item: HumanInboxItem): Promise<HumanInboxDetail> {
    if (MOCK) {
      await delay(120);
      if (item.scope === "workflow") {
        return {
          scope: "workflow",
          requestId: mockWorkflowNode.id,
          taskBindingId: mockWorkflowNode.taskBindingId,
          workflowRunId: mockWorkflowNode.workflowRunId,
          nodeKey: mockWorkflowNode.nodeKey,
          assignedIdentityId: mockWorkflowNode.assignedIdentityId,
          kind: mockWorkflowNode.kind,
          title: mockWorkflowNode.title,
          question: mockWorkflowNode.question,
          options: mockWorkflowNode.options,
          context: mockWorkflowNode.context,
          status: mockWorkflowNode.status,
          createdAt: mockWorkflowNode.createdAt,
        };
      }
      const req = item.requestId === mockAgentTextRequest.id ? mockAgentTextRequest : mockAgentRequest;
      return {
        scope: "agent",
        requestId: req.id,
        taskBindingId: req.taskBindingId,
        agentRunId: req.agentRunId,
        assignedIdentityId: req.assignedIdentityId,
        kind: req.kind === "permission" ? "choice" : req.kind,
        title: req.title,
        question: req.question,
        options: req.options,
        context: req.context,
        status: req.status,
        deliveryStatus: req.deliveryStatus,
        createdAt: req.createdAt,
      };
    }
    const url =
      item.scope === "workflow"
        ? `/api/v1/runtime/workflow-human-nodes/${item.requestId}`
        : `/api/v1/runtime/agent-human-requests/${item.requestId}`;
    return { scope: item.scope, ...(await this.get(url)).data };
  }

  /**
   * POST /api/v1/runtime/workflow-human-nodes/{id}/answer or
   * POST /api/v1/runtime/agent-human-requests/{id}/answer — scope-routed
   * command with its own authorization and idempotency key (§2.6: the inbox
   * itself never exposes a shared answer state machine).
   */
  async answerHumanInboxItem(item: HumanInboxItem, answer: Record<string, unknown>): Promise<void> {
    if (MOCK) {
      await delay(180);
      if (item.scope === "workflow") {
        // CAS precondition (§5.8): only a waiting_approval node is answerable.
        if (mockWorkflowNode.status !== "waiting_approval") throw new Error("节点不在 waiting_approval 状态");
        mockWorkflowNode = { ...mockWorkflowNode, status: "completed" };
        return;
      }
      if (item.requestId === mockAgentTextRequest.id) {
        if (mockAgentTextRequest.status !== "pending") throw new Error("请求不在 pending 状态");
        mockAgentTextRequest = { ...mockAgentTextRequest, status: "answered", deliveryStatus: "pending" };
        return;
      }
      if (mockAgentRequest.status !== "pending") throw new Error("请求不在 pending 状态");
      // Local answer recorded; Gateway delivery stays pending until the
      // worker confirms (§5.9) — the AgentRun must not look resumed yet.
      mockAgentRequest = { ...mockAgentRequest, status: "answered", deliveryStatus: "pending" };
      return;
    }
    const url =
      item.scope === "workflow"
        ? `/api/v1/runtime/workflow-human-nodes/${item.requestId}/answer`
        : `/api/v1/runtime/agent-human-requests/${item.requestId}/answer`;
    await this.post(url, answer);
  }
}

export const getCurrentRuntimeIdentityId = () => (MOCK ? MOCK_CURRENT_IDENTITY_ID : "");

const runtimeService = new AgentTeamRuntimeService();

export default runtimeService;
