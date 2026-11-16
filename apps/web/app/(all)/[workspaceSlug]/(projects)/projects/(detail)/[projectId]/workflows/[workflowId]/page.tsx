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
import { useTranslation } from "@plane/i18n";
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
  type OrchestrationWorkflow,
  type OrchestrationWorkflowVersion,
} from "@/services/agent-teams/orchestration.service";
import { connectionsService } from "@/services/agent-teams/connections.service";
// components
import { WorkflowCanvasEditor } from "@/components/agent-teams/workflow-canvas";
// 画布 graph 形状（编辑态契约）仍在 workflow.service 导出——纯类型引用，不触发旧数据链
import type { WorkflowGraph } from "@/services/agent-teams/workflow.service";
// hooks
import { useProject } from "@/hooks/store/use-project";


/** 发布终态轮询：publish 接口是"启动发布"语义——引擎就绪在请求外完成，
 * 窗口内未就绪时返回 `publishing`（进行中），由 worker 对账收尾。
 * 因此 `publishing` 绝不能当失败：只有明确 `published` / `failed` 才是终态。
 * 预算取后端对账的最大窗口（600s）之上：超龄 15 分钟才判 failed。 */
const PUBLISH_POLL_INTERVAL_MS = 3_000;
const PUBLISH_POLL_BUDGET_MS = 15 * 60 * 1000;

type PublishOutcome = OrchestrationWorkflowVersion["status"] | "timeout";

/** 轮询单个版本到终态；预算内没等到终态返回 "timeout"（仍是发布中，
 * 不是失败）。轮询瞬时错误不改变结论，等下一轮。 */
async function waitForVersionSettled(
  workspace: string,
  projectId: string,
  workflowId: string,
  versionId: string,
  isCancelled: () => boolean
): Promise<PublishOutcome> {
  const deadline = Date.now() + PUBLISH_POLL_BUDGET_MS;
  while (!isCancelled() && Date.now() < deadline) {
    // 轮询必须串行（间隔 + 顺序读状态），不适用并发收集
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, PUBLISH_POLL_INTERVAL_MS));
    if (isCancelled()) return "timeout";
    try {
      // eslint-disable-next-line no-await-in-loop
      const detail = await orchestrationService.getWorkflow(workspace, projectId, workflowId);
      const target = detail.versions?.find((item) => item.id === versionId);
      if (target?.status === "published" || target?.status === "failed") return target.status;
    } catch {
      /* 轮询瞬时失败（网络/网关抖动）不改变结论，下一轮继续 */
    }
  }
  return "timeout";
}

function ProjectWorkflowCanvasPage({ params }: { params: { projectId: string; workflowId: string } }) {
  const { t } = useTranslation();
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

  // 画布目录（成员收敛 §3.5）：可选成员 = 项目绑定团队的 enabled 成员——
  // 数字员工取 agent 成员、审批人取 human 成员；未绑定/拉取失败降级为手填 id，
  // 越界引用由挂载/发布时后端名册校验兜底。
  const [experts, setExperts] = useState<Array<{ id: string; name: string }>>([]);
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([]);
  // 工作区连接（AI 节点连接选择，连接管理设计 §5.2）
  const [connections, setConnections] = useState<Array<{ name: string; type: string; status?: string }>>([]);


  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const loaded = await orchestrationService.getWorkflow(workspaceSlug, projectId, workflowId);
      setWorkflow(loaded);
      setForm({ name: loaded.name, description: loaded.description ?? "" });
    } catch {
      setLoadError(t("agent_teams_workflows_load_failed"));
    } finally {
      setLoading(false);
    }
  }, [workspaceSlug, projectId, workflowId]);

  useEffect(() => {
    if (!projectId || !workflowId) return;
    void reload();
  }, [reload, projectId, workflowId]);

  // 在途发布续轮询：刷新/重进画布时若有版本仍是 publishing，接着等终态。
  // 既避免把进行中误显示为失败，也避免发布按钮被重复触发。
  const inFlightPublishVersionId = workflow?.versions?.find((v) => v.status === "publishing")?.id ?? "";
  useEffect(() => {
    if (!inFlightPublishVersionId) return;
    let cancelled = false;
    setPublishing(true);
    setActionError("");
    setActionMessage(t("agent_teams_workflows_publish_waiting"));
    void (async () => {
      const outcome = await waitForVersionSettled(
        workspaceSlug,
        projectId,
        workflowId,
        inFlightPublishVersionId,
        () => cancelled
      );
      if (cancelled) return;
      setPublishing(false);
      if (outcome === "published") {
        setActionMessage(t("agent_teams_workflows_publish_ok", { version: inFlightPublishVersionId }));
        await reload();
      } else if (outcome === "failed") {
        setActionError(t("agent_teams_workflows_publish_failed"));
        await reload();
      } else {
        setActionMessage(
          t("agent_teams_workflows_still_publishing")
        );
      }
    })().catch(() => {
      if (!cancelled) setPublishing(false);
    });
    return () => {
      cancelled = true;
    };
    // reload 已 useCallback 稳定；t 不进入轮询依赖，避免语言切换重排轮询链
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inFlightPublishVersionId, reload, workspaceSlug, projectId, workflowId]);

  // 目录懒加载（成员收敛 §3.5）：先取项目 active 绑定 → 团队 enabled 成员分拣。
  useEffect(() => {
    if (!workspaceSlug) return;
    let ignore = false;
    orchestrationService
      .listBindings(workspaceSlug, projectId)
      .then((bindings) => {
        const active = bindings.find((b) => b.status === "active");
        if (!active) return null;
        return orchestrationService.listMembers(workspaceSlug, active.teamId);
      })
      .then((members) => {
        if (ignore || !members) return null;
        const enabled = members.filter((m) => m.enabled !== false);
        setExperts(
          enabled
            .filter((m) => m.kind === "agent" && m.agentDefinitionId)
            .map((m) => ({ id: m.agentDefinitionId, name: m.displayName || m.agentDefinitionId }))
        );
        setUsers(
          enabled
            .filter((m) => m.kind === "human" && m.userId)
            .map((m) => ({ id: m.userId as string, name: m.displayName || (m.userId as string) }))
        );
        return null;
      })
      .catch(() => undefined);
    connectionsService
      .listConnections(workspaceSlug)
      .then((items) => {
        if (!ignore) {
          setConnections(items.map((c) => ({ name: c.name, type: c.type as string, status: c.status })));
        }
        return null;
      })
      .catch(() => undefined);
    return () => {
      ignore = true;
    };
    // 目录懒加载一次性获取：projectId 稳定（路由参数），不进依赖避免重复拉取
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (publishing) return;
    setPublishing(true);
    setActionError("");
    setActionMessage(t("agent_teams_workflows_publishing"));
    try {
      const version = await orchestrationService.saveDraftVersion(workspaceSlug, projectId, workflowId);
      const started = await orchestrationService.publishVersion(workspaceSlug, projectId, workflowId, version.id);
      // 状态严格三分支：published=成功；failed=明确失败；publishing=进行中
      // （引擎就绪在请求外完成），轮询到终态再下结论——绝不把进行中当失败。
      let outcome: PublishOutcome = started.status;
      if (started.status === "publishing") {
        setActionMessage(t("agent_teams_workflows_publish_waiting"));
        outcome = await waitForVersionSettled(workspaceSlug, projectId, workflowId, started.id, () => false);
      }
      if (outcome === "published") {
        setActionMessage(t("agent_teams_workflows_publish_ok", { version: String(started.version) }));
        await reload();
      } else if (outcome === "failed") {
        setActionError(`${t("agent_teams_workflows_publish_failed")} v${started.version}`);
        await reload();
      } else if (outcome === "timeout") {
        // 仍在发布中：不报失败，如实告知稍后回看
        setActionMessage(
          t("agent_teams_workflows_still_publishing")
        );
        await reload();
      } else {
        // 后端返回了未知/中间状态（如 draft）：既非成功也非失败，如实呈现
        setActionError(t("agent_teams_workflows_publish_incomplete", { status: outcome }));
      }
    } catch (err) {
      const message = (err as Error).message ?? "";
      setActionError(
        /\[WORKFLOW_DRAFT_NOT_FOUND\]|\[WORKFLOW_DRAFT_EMPTY\]/.test(message)
          ? t("agent_teams_workflows_publish_no_draft")
          : t("agent_teams_workflows_publish_failed")
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
            {t("agent_teams_workflows_loading")}
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
                  {t("agent_teams_workflows_settings")}
                </Button>
                <Button variant="primary" size="lg" onClick={() => void publish()} loading={publishing || loading}>
                  <Rocket className="size-4" aria-hidden />
                  {publishing ? t("agent_teams_workflows_publishing") : t("agent_teams_workflows_publish")}
                </Button>
              </>
            }
            toolCatalog={[]}
            connections={connections}
            employees={experts}
            users={users}
            onSave={saveGraph}
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
            <h3 className="text-18 font-medium text-secondary">{t("agent_teams_workflows_settings_title")}</h3>
            <div className="space-y-3">
              <div className="space-y-1">
                <Input
                  mode="primary"
                  inputSize="sm"
                  className="w-full"
                  value={form.name}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder={t("agent_teams_wf_field_name")}
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
                  placeholder={t("agent_teams_wf_field_desc")}
                />
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 border-t-[0.5px] border-subtle px-5 py-4">
            <Button variant="secondary" size="lg" onClick={() => setSettingsOpen(false)}>
              {t("agent_teams_workflows_cancel")}
            </Button>
            <Button variant="primary" size="lg" onClick={() => void saveInfo()} loading={savingInfo}>
              {savingInfo ? t("agent_teams_workflows_saving") : t("agent_teams_workflows_save")}
            </Button>
          </div>
        </ModalCore>
      </div>
    </div>
  );
}

export default ProjectWorkflowCanvasPage;
