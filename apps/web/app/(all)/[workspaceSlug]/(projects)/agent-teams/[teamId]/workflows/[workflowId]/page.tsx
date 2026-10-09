/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — team workflow canvas (设计修订 2026-10-08 阶段 3)。
 * 与管理端画布同一模式：画布独占视口，元数据在区块抽屉，发布在头栏
 * （Dify/n8n pattern）。数据经 runtime-token 通道，权威在 Agent Team Runtime。
 */
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import Link from "next/link";
import { ArrowLeft, Rocket, Save, Settings } from "lucide-react";
// services
import workflowService, {
  type WorkflowGraph,
  type TeamWorkflow,
  type WorkflowToolCatalogEntry,
} from "@/services/agent-teams/workflow.service";
import { expertsAuthHeaders } from "@/services/agent-teams/experts-auth";
// components
import { WorkflowCanvasEditor } from "@/components/agent-teams/workflow-canvas";
import type { WorkflowCanvasEditorLabels } from "@/components/agent-teams/workflow-canvas";

// 画布文案双语文料（与管理端 adminWorkflowCanvas 同源）：画布是专用编辑面，
// 文案随组件内联避免 40+ 键 × 全语言铺开；zh 之外回退英文。
const CANVAS_LABELS_ZH: WorkflowCanvasEditorLabels = {
  addAgent: "Agent 节点",
  addTool: "工具节点",
  addConfirm: "人工确认",
  addCondition: "条件节点",
  fieldBranches: "分支（对应出边）",
  fieldBranchesHint: "从本节点拉出多条连线，每条连线一个分支标签；执行时由员工 agent 判断走哪条。",
  branchLabel: "分支标签",
  noBranches: "先从节点下方拉出连线，再配置分支标签。",
  save: "保存画布",
  saving: "保存中...",
  savedMessage: "画布已保存",
  saveFailed: "保存画布失败，请稍后重试",
  emptyFieldError: "有 Agent 节点缺少工作要求，请补全后再保存",
  cycleError: "流程中存在循环连线，请检查后再保存",
  nodePanelTitle: "节点属性",
  fieldName: "节点名称 *",
  fieldEmployee: "负责员工",
  genericAgent: "通用 Agent（不绑定员工）",
  employeePersonaInjected: "能力介绍已自动注入",
  addNode: "添加节点",
  fieldPrompt: "本节点工作要求",
  fieldPromptHint: "员工能力由所绑成员自动注入，此处只写该节点要完成的具体工作（如：拉取数据 / 分级 / 撰写报告…）",
  fieldPromptPlaceholder: "例如：拉取禅道中指派的 Bug，并按优先级分级",
  fieldToolName: "工具 *",
  fieldConnection: "连接（凭证名）",
  noConnection: "（不使用连接）",
  connectionPlaceholder: "连接名称（先在管理端创建）",
  fieldParams: "参数（JSON）",
  fieldMessage: "确认提示 *",
  fieldApprover: "审批人 *",
  fieldApproverPlaceholder: "选择审批人（租户用户）",
  fieldFreeText: "自由文本答复（不提供选项，答复任意内容继续流程）",
  fieldOptions: "选项（自定义）",
  fieldOptionsHint: "留空 = 默认「通过并继续 / 驳回」。勾选「终止」的选项会结束流程，其余带着所选文案继续执行。",
  optionLabel: "选项文案",
  terminate: "终止",
  terminateHint: "勾选 = 该选项终止流程；不勾 = 带着所选文案继续执行",
  addOption: "添加选项",
  deleteNode: "删除节点",
  selectNodeHint: "点击画布上的节点编辑属性；从节点下方的圆点拖出连线到下一个节点。Delete/Backspace 删除选中节点。",
};
const CANVAS_LABELS_EN: WorkflowCanvasEditorLabels = {
  ...CANVAS_LABELS_ZH,
  addAgent: "Agent node",
  addTool: "Tool node",
  addConfirm: "Human confirm",
  addCondition: "Condition node",
  save: "Save canvas",
  saving: "Saving...",
  savedMessage: "Canvas saved",
  saveFailed: "Failed to save the canvas, please retry",
  nodePanelTitle: "Node properties",
  fieldName: "Node name *",
  addNode: "Add node",
  deleteNode: "Delete node",
};

function AgentTeamWorkflowCanvasPage({ params }: { params: { teamId: string; workflowId: string } }) {
  const routeParams = useParams<{ workspaceSlug: string }>();
  const workspaceSlug = routeParams.workspaceSlug ?? "";
  const { teamId, workflowId } = params;

  const [workflow, setWorkflow] = useState<TeamWorkflow | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });
  const [savingInfo, setSavingInfo] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");

  // 画布目录：专家（agent 节点）/工具/连接/审批人（租户成员）。
  const [experts, setExperts] = useState<Array<{ id: string; name: string }>>([]);
  const [tools, setTools] = useState<WorkflowToolCatalogEntry[]>([]);
  const [connections, setConnections] = useState<Array<{ name: string; type: string }>>([]);
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([]);

  const zh = typeof navigator !== "undefined" && navigator.language?.startsWith("zh");

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const loaded = await workflowService.getTeamWorkflow(teamId, workflowId);
      setWorkflow(loaded);
      setForm({ name: loaded.name, description: loaded.description ?? "" });
    } catch {
      setLoadError("流程加载失败，请稍后重试 / Failed to load the workflow");
    } finally {
      setLoading(false);
    }
  }, [teamId, workflowId]);

  useEffect(() => {
    if (!teamId || !workflowId) return;
    void reload();
  }, [reload, teamId, workflowId]);

  // 目录懒加载：进画布才取，失败静默降级为手填 id（与管理端同策略）。
  useEffect(() => {
    if (!teamId) return;
    let ignore = false;
    workflowService
      .listPublishedExperts()
      .then((items) => !ignore && setExperts(items))
      .catch(() => undefined);
    workflowService
      .listWorkflowTools()
      .then((res) => !ignore && setTools(res.items ?? []))
      .catch(() => undefined);
    workflowService
      .listEngineConnections()
      .then(
        (items) =>
          !ignore &&
          setConnections(items.filter((c) => c.status === "active").map((c) => ({ name: c.name, type: c.engineType })))
      )
      .catch(() => undefined);
    // 审批人候选 = 租户成员：token 里带 tenantId，从交换头取。
    expertsAuthHeaders()
      .then((headers) => {
        const tenantId = headers["X-Tenant-ID"] ?? headers["x-tenant-id"];
        if (typeof tenantId !== "string" || !tenantId) return;
        return workflowService
          .listTenantMembers(tenantId)
          .then(
            (items) => !ignore && setUsers(items.map((m) => ({ id: m.userId, name: m.name || m.email || m.userId })))
          )
          .catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      ignore = true;
    };
  }, [teamId]);

  async function saveGraph(graph: WorkflowGraph) {
    await workflowService.updateTeamWorkflow(teamId, workflowId, { graph });
    setWorkflow((prev) => (prev ? { ...prev, graph } : prev));
  }

  async function saveInfo() {
    if (!form.name.trim()) return;
    setSavingInfo(true);
    try {
      const saved = await workflowService.updateTeamWorkflow(teamId, workflowId, {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
      });
      setWorkflow((prev) => (prev ? { ...prev, name: saved.name } : prev));
      setSettingsOpen(false);
    } finally {
      setSavingInfo(false);
    }
  }

  async function publish() {
    setPublishing(true);
    setActionError("");
    setActionMessage("");
    try {
      const version = await workflowService.publishTeamWorkflow(teamId, workflowId);
      // 串行间隔轮询（2s/最长 300s）——then 链表达，超时收敛。
      const deadline = Date.now() + 300_000;
      const tick = (): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, 2000))
          .then(() => workflowService.getTeamWorkflowVersion(teamId, workflowId, version.id))
          .then((polled) => {
            if (polled.status === "published") {
              setActionMessage(`已发布 v${polled.version} / Published v${polled.version}`);
              return reload();
            }
            if (polled.status === "failed") {
              setActionError(`发布失败 / Publish failed${polled.publishError ? `：${polled.publishError}` : ""}`);
              return;
            }
            if (Date.now() >= deadline) {
              setActionError("发布超时，请稍后刷新查看结果 / Publish timed out");
              return;
            }
            return tick();
          });
      await tick();
    } catch (err) {
      const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
      setActionError(
        code === "WORKFLOW_DRAFT_NOT_FOUND"
          ? "没有待发布的新改动 / No new draft to publish"
          : "发布失败，请稍后重试 / Publish failed"
      );
    } finally {
      setPublishing(false);
    }
  }

  const backPath = `/${workspaceSlug}/agent-teams/${teamId}`;

  return (
    <div className="bg-custom-background-100 flex h-screen w-full flex-col">
      <header className="border-custom-border-100 flex items-center gap-3 border-b px-4 py-2.5">
        <Link
          href={backPath}
          className="text-sm text-custom-text-200 hover:bg-custom-background-80 hover:text-custom-text-100 inline-flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {zh ? "返回团队" : "Back to team"}
        </Link>
        <span className="text-sm text-custom-text-100 font-medium">
          {workflow?.name ?? (zh ? "流程画布" : "Workflow canvas")}
        </span>
        {workflow?.status === "published" && workflow.currentVersion != null ? (
          <span className="bg-green-500/15 text-green-600 rounded-full px-2 py-0.5 text-[11px]">
            v{workflow.currentVersion}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {actionMessage ? <span className="text-xs text-custom-text-300">{actionMessage}</span> : null}
          {actionError ? <span className="text-xs text-red-500">{actionError}</span> : null}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title={zh ? "基本信息" : "Settings"}
            className="border-custom-border-200 text-sm text-custom-text-200 hover:bg-custom-background-80 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5"
          >
            <Settings className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => void publish()}
            disabled={publishing || loading}
            className="bg-custom-primary-100 text-sm hover:bg-custom-primary-90 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium text-white disabled:opacity-60"
          >
            <Rocket className="size-4" aria-hidden />
            {publishing ? (zh ? "发布中…" : "Publishing…") : zh ? "发布" : "Publish"}
          </button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        {loading ? (
          <div className="text-sm text-custom-text-300 grid h-full place-items-center">
            {zh ? "正在加载流程…" : "Loading workflow…"}
          </div>
        ) : loadError ? (
          <div className="text-sm text-red-500 grid h-full place-items-center">{loadError}</div>
        ) : workflow ? (
          <WorkflowCanvasEditor
            initialGraph={workflow.graph ?? null}
            toolCatalog={tools.map((tool) => ({
              tool_name: tool.name,
              description: tool.description ?? "",
              connection_type: tool.connectionType,
            }))}
            connections={connections}
            employees={experts}
            users={users}
            onSave={saveGraph}
            labels={zh ? CANVAS_LABELS_ZH : CANVAS_LABELS_EN}
          />
        ) : null}

        {/* 元数据抽屉：与画布同层，背板关闭 */}
        {settingsOpen ? (
          <div
            role="presentation"
            className="bg-custom-backdrop fixed inset-0 z-50 flex justify-end"
            onClick={() => setSettingsOpen(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setSettingsOpen(false);
            }}
          >
            <section
              role="dialog"
              aria-modal="true"
              className="bg-custom-background-100 shadow-xl flex h-full w-[440px] max-w-full flex-col"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <header className="border-custom-border-100 flex items-center justify-between border-b px-5 py-4">
                <h2 className="text-sm text-custom-text-100 font-medium">
                  {zh ? "流程基本信息" : "Workflow settings"}
                </h2>
                <button
                  type="button"
                  className="text-2xl text-custom-text-300 hover:text-custom-text-100 leading-none"
                  onClick={() => setSettingsOpen(false)}
                >
                  ×
                </button>
              </header>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
                <label className="text-sm text-custom-text-200 grid gap-1">
                  <span>{zh ? "名称" : "Name"}</span>
                  <input
                    value={form.name}
                    onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                    className="border-custom-border-200 text-sm text-custom-text-100 focus:border-custom-primary-100 rounded-lg border bg-transparent px-3 py-2 outline-none"
                  />
                </label>
                <label className="text-sm text-custom-text-200 grid gap-1">
                  <span>{zh ? "描述" : "Description"}</span>
                  <textarea
                    value={form.description}
                    onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                    className="border-custom-border-200 text-sm text-custom-text-100 focus:border-custom-primary-100 min-h-[72px] resize-y rounded-lg border bg-transparent px-3 py-2 outline-none"
                  />
                </label>
              </div>
              <footer className="border-custom-border-100 flex justify-end gap-2 border-t px-5 py-4">
                <button
                  type="button"
                  onClick={() => setSettingsOpen(false)}
                  className="border-custom-border-200 text-sm text-custom-text-200 hover:bg-custom-background-80 rounded-lg border px-4 py-2"
                >
                  {zh ? "取消" : "Cancel"}
                </button>
                <button
                  type="button"
                  onClick={() => void saveInfo()}
                  disabled={savingInfo}
                  className="bg-custom-primary-100 text-sm hover:bg-custom-primary-90 inline-flex items-center gap-1.5 rounded-lg px-4 py-2 font-medium text-white disabled:opacity-60"
                >
                  <Save className="size-4" aria-hidden />
                  {savingInfo ? (zh ? "保存中…" : "Saving…") : zh ? "保存" : "Save"}
                </button>
              </footer>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default AgentTeamWorkflowCanvasPage;
