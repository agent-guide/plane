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
import { Breadcrumbs } from "@plane/ui";
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { Button } from "@plane/propel/button";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { Input, TextArea } from "@plane/ui";
import { Rocket, Users } from "lucide-react";
// services
import runtimeService from "@/services/agent-teams/runtime.service";
import workflowService, {
  type WorkflowGraph,
  type TeamWorkflow,
  type WorkflowToolCatalogEntry,
} from "@/services/agent-teams/workflow.service";
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
  fieldEmployeeEmptyHint: "团队暂无在编数字员工，请先在团队详情添加成员",
  genericAgent: "通用 Agent（不绑定员工）",
  employeePersonaInjected: "能力介绍已自动注入",
  addNode: "添加节点",
  fieldPrompt: "本节点工作要求",
  fieldPromptHint: "员工能力由所绑成员自动注入，此处只写该节点要完成的具体工作（如：拉取数据 / 分级 / 撰写报告…）",
  fieldPromptPlaceholder: "描述该节点要完成的工作、输入与期望产出",
  fieldToolName: "工具 *",
  fieldConnection: "连接（凭证名）",
  noConnection: "（不使用连接）",
  connectionPlaceholder: "连接名称（先在管理端创建）",
  fieldParams: "参数（JSON）",
  fieldMessage: "确认提示 *",
  fieldApprover: "审批人 *",
  fieldApproverPlaceholder: "选择审批人（租户用户）",
  fieldApproverEmptyHint: "团队暂无人类成员，请先在团队详情添加成员",
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
  const [teamName, setTeamName] = useState<string | null>(null);
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
    runtimeService
      .getTeam(teamId)
      .then((team) => setTeamName(team.name))
      .catch(() => undefined);
  }, [reload, teamId, workflowId]);

  // 目录懒加载：进画布才取，失败静默降级为手填 id（与管理端同策略）。
  useEffect(() => {
    if (!teamId) return;
    let ignore = false;
    // 负责员工候选 = 本团队在编数字员工（验收修正 2026-10-15）。不回退
    // 全租户目录：下拉里出现的必须是真团队成员；团队未配数字员工时
    // 保持空列表，由下拉空态文案引导去团队详情配置（错误选项比空更糟）。
    runtimeService
      .listTeamMembers(teamId)
      .then((members) => {
        if (ignore) return;
        setExperts(
          members
            .filter((m) => m.kind === "agent" && m.expertId)
            .map((m) => ({ id: m.expertId as string, name: m.displayName || m.role }))
        );
        return;
      })
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
    // 审批人候选 = 团队内人类成员（验收修正 2026-10-15：谁的事谁审）。
    // 不回退全租户成员——下拉里出现的必须是真团队成员；未配人类成员时
    // 空列表 + 下拉空态文案引导。approverUserId 契约=租户用户 id，
    // 团队成员经 identity 富化取 planeUserId。
    runtimeService
      .listTeamMembers(teamId)
      .then((members) => {
        if (ignore) return;
        setUsers(
          members
            .filter((m) => m.kind === "human" && m.planeUserId)
            .map((m) => ({ id: m.planeUserId as string, name: m.displayName || m.role }))
        );
        return;
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
    <div className="flex h-full w-full flex-col bg-canvas">
      <div className="relative min-h-0 flex-1">
        {loading ? (
          <div className="grid h-full place-items-center text-13 text-tertiary">
            {zh ? "正在加载流程…" : "Loading workflow…"}
          </div>
        ) : loadError ? (
          <div className="text-sm text-red-500 grid h-full place-items-center">{loadError}</div>
        ) : workflow ? (
          <WorkflowCanvasEditor
            initialGraph={workflow.graph ?? null}
            headerLeft={
              <>
                <Breadcrumbs>
                  <Breadcrumbs.Item
                    component={
                      <BreadcrumbLink
                        label={teamName ?? teamId}
                        href={backPath}
                        icon={<Users className="size-4 text-tertiary" />}
                      />
                    }
                  />
                  <Breadcrumbs.Item component={<BreadcrumbLink label={workflow.name} disableTooltip />} />
                </Breadcrumbs>
                {workflow.status === "published" && workflow.currentVersion != null ? (
                  <span className="bg-green-500/15 text-green-600 rounded-full px-2 py-0.5 text-11">
                    v{workflow.currentVersion}
                  </span>
                ) : null}
              </>
            }
            headerRight={
              <>
                {actionMessage ? <span className="text-12 text-tertiary">{actionMessage}</span> : null}
                {actionError ? <span className="text-12 text-danger-primary">{actionError}</span> : null}
                <Button variant="secondary" size="lg" onClick={() => setSettingsOpen(true)}>
                  {zh ? "基本信息" : "Settings"}
                </Button>
                <Button variant="primary" size="lg" onClick={() => void publish()} loading={publishing || loading}>
                  <Rocket className="size-4" aria-hidden />
                  {publishing ? (zh ? "发布中…" : "Publishing…") : zh ? "发布" : "Publish"}
                </Button>
              </>
            }
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
        <ModalCore
          isOpen={settingsOpen}
          handleClose={() => setSettingsOpen(false)}
          position={EModalPosition.TOP}
          width={EModalWidth.XXL}
        >
          {/* 与新建流程弹层同规范（cycles 表单解剖）：p-5/space-y-5、text-18 标题、
              占位符即标签、text-11 错误、border-t-[0.5px] 通栏页脚。 */}
          <div className="space-y-5 p-5">
            <h3 className="text-18 font-medium text-secondary">{zh ? "流程基本信息" : "Workflow settings"}</h3>
            <div className="space-y-3">
              <div className="space-y-1">
                <Input
                  mode="primary"
                  inputSize="sm"
                  className="w-full"
                  value={form.name}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder={zh ? "名称" : "Name"}
                />
              </div>
              <div className="space-y-1">
                <TextArea
                  mode="primary"
                  textAreaSize="sm"
                  className="font-normal min-h-20 w-full resize-none text-13"
                  rows={3}
                  value={form.description}
                  onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                  placeholder={zh ? "描述" : "Description"}
                />
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 border-t-[0.5px] border-subtle px-5 py-4">
            <Button variant="secondary" size="lg" onClick={() => setSettingsOpen(false)}>
              {zh ? "取消" : "Cancel"}
            </Button>
            <Button variant="primary" size="lg" onClick={() => void saveInfo()} loading={savingInfo}>
              {savingInfo ? (zh ? "保存中…" : "Saving…") : zh ? "保存" : "Save"}
            </Button>
          </div>
        </ModalCore>
      </div>
    </div>
  );
}

export default AgentTeamWorkflowCanvasPage;
