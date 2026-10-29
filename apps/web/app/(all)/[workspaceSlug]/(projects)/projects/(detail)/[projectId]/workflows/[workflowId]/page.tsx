/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Agent Teams extension — 项目流程画布（流程归项目，2026-10-29 方案 A，自
 * /agent-teams/[teamId]/workflows/[workflowId] 迁移）。画布独占视口，元数据在
 * 区块抽屉，发布在头栏（Dify/n8n pattern）。数据走编排域同源 API：草稿=画布
 * graph，存版本时后端编译为可执行 definition。
 */
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import { Breadcrumbs } from "@plane/ui";
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { Button } from "@plane/propel/button";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { Input, TextArea } from "@plane/ui";
import { Rocket, Workflow } from "lucide-react";
// services
import {
  orchestrationService,
  type OrchestrationAgentCatalogEntry,
  type OrchestrationWorkflow,
} from "@/services/agent-teams/orchestration.service";
import { WorkspaceService } from "@/services/workspace.service";
// components
import { WorkflowCanvasEditor } from "@/components/agent-teams/workflow-canvas";
import type { WorkflowCanvasEditorLabels } from "@/components/agent-teams/workflow-canvas";
// 画布 graph 形状（编辑态契约）仍在 workflow.service 导出——纯类型引用，不触发旧数据链
import type { WorkflowGraph } from "@/services/agent-teams/workflow.service";
// hooks
import { useProject } from "@/hooks/store/use-project";

const workspaceService = new WorkspaceService();

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
  fieldEmployeeEmptyHint: "数字员工目录暂不可用，可先手填标识后保存",
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
  fieldApproverPlaceholder: "选择审批人（工作区成员）",
  fieldApproverEmptyHint: "工作区成员目录暂不可用，可先手填用户标识后保存",
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

function ProjectWorkflowCanvasPage({ params }: { params: { projectId: string; workflowId: string } }) {
  const routeParams = useParams<{ workspaceSlug: string }>();
  const workspaceSlug = routeParams.workspaceSlug ?? "";
  const { projectId, workflowId } = params;
  const { currentProjectDetails: project } = useProject();

  const [workflow, setWorkflow] = useState<OrchestrationWorkflow | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  useEffect(() => {
    if (project?.name) setProjectName(project.name);
  }, [project?.name]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });
  const [savingInfo, setSavingInfo] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");

  // 画布目录：数字员工（agent 目录代理）/ 审批人（工作区成员）。
  // 工具/连接目录暂空（终局 env 承载引擎连接；工具注册表后续随执行域补）。
  const [experts, setExperts] = useState<Array<{ id: string; name: string }>>([]);
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([]);

  const zh = typeof navigator !== "undefined" && navigator.language?.startsWith("zh");

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const loaded = await orchestrationService.getWorkflow(workspaceSlug, projectId, workflowId);
      setWorkflow(loaded);
      setForm({ name: loaded.name, description: loaded.description ?? "" });
    } catch {
      setLoadError("流程加载失败，请稍后重试 / Failed to load the workflow");
    } finally {
      setLoading(false);
    }
  }, [workspaceSlug, projectId, workflowId]);

  useEffect(() => {
    if (!projectId || !workflowId) return;
    void reload();
  }, [reload, projectId, workflowId]);

  // 目录懒加载：进画布才取，失败静默降级为手填 id。
  useEffect(() => {
    if (!workspaceSlug) return;
    let ignore = false;
    orchestrationService
      .listAgentCatalog(workspaceSlug)
      .then((entries: OrchestrationAgentCatalogEntry[]) => {
        if (!ignore) setExperts(entries.map((e) => ({ id: e.id, name: e.name })));
        return null;
      })
      .catch(() => undefined);
    workspaceService
      .fetchWorkspaceMembers(workspaceSlug)
      .then((members) => {
        if (!ignore) {
          setUsers(
            members.map((m) => ({
              id: m.member.id,
              name: m.member.display_name || m.member.first_name || m.member.email || m.member.id,
            }))
          );
        }
        return null;
      })
      .catch(() => undefined);
    return () => {
      ignore = true;
    };
  }, [workspaceSlug]);

  async function saveGraph(graph: Record<string, unknown>) {
    const saved = await orchestrationService.saveDraft(workspaceSlug, projectId, workflowId, graph);
    setWorkflow((prev) => (prev ? { ...prev, draft: saved.draft } : prev));
  }

  async function saveInfo() {
    if (!form.name.trim()) return;
    setSavingInfo(true);
    try {
      const saved = await orchestrationService.updateWorkflowInfo(workspaceSlug, projectId, workflowId, {
        name: form.name.trim(),
        description: form.description.trim() || "",
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
      const version = await orchestrationService.saveDraftVersion(workspaceSlug, projectId, workflowId);
      const published = await orchestrationService.publishVersion(workspaceSlug, projectId, workflowId, version.id);
      if (published.status === "published") {
        setActionMessage(`已发布 v${published.version} / Published v${published.version}`);
        await reload();
      } else {
        setActionError(`发布失败 / Publish failed：${published.status}`);
      }
    } catch (err) {
      const message = (err as Error).message ?? "";
      setActionError(
        /\[WORKFLOW_DRAFT_NOT_FOUND\]|\[WORKFLOW_DRAFT_EMPTY\]/.test(message)
          ? "没有待发布的新改动 / No new draft to publish"
          : "发布失败，请稍后重试 / Publish failed"
      );
    } finally {
      setPublishing(false);
    }
  }

  const backPath = `/${workspaceSlug}/projects/${projectId}/workflows`;

  // 发布态徽标：详情响应带版本列表，取最新已发布版本
  const publishedVersion = workflow?.versions?.find((v) => v.status === "published");

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
            initialGraph={(workflow.draft as unknown as WorkflowGraph | null) ?? null}
            headerLeft={
              <>
                <Breadcrumbs>
                  <Breadcrumbs.Item
                    component={
                      <BreadcrumbLink
                        label={projectName ?? projectId}
                        href={backPath}
                        icon={<Workflow className="size-4 text-tertiary" />}
                      />
                    }
                  />
                  <Breadcrumbs.Item component={<BreadcrumbLink label={workflow.name} disableTooltip />} />
                </Breadcrumbs>
                {publishedVersion ? (
                  <span className="bg-green-500/15 text-green-600 rounded-full px-2 py-0.5 text-11">
                    v{publishedVersion.version}
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
            toolCatalog={[]}
            connections={[]}
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

export default ProjectWorkflowCanvasPage;
