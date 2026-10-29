/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Agent Teams extension — 项目流程库整页编排（流程归项目所有，团队负责执行：
 * 2026-10-29 方案 A，自团队维度迁移）。持全部数据与操作状态，行/弹层拆到
 * workflows/ 下各组件。数据走编排域同源 API。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { useParams } from "react-router";
import { EmptyStateDetailed } from "@plane/propel/empty-state";
import { Table } from "@plane/ui";
// services
import {
  orchestrationService,
  type OrchestrationAgentCatalogEntry,
  type OrchestrationWorkflow,
  type OrchestrationWorkflowVersion,
} from "@/services/agent-teams/orchestration.service";
import { classifyRuntimeFailure, type RuntimeFailureKind } from "@/services/agent-teams/runtime-errors";
// components
import { useWorkflowColumns } from "./workflow-columns";
import { WorkflowFormModal, EMPTY_WORKFLOW_FORM, type WorkflowForm } from "./workflow-form-modal";
import { WorkflowHistoryModal } from "./workflow-history-modal";
import { WorkflowDeleteModal } from "./workflow-delete-modal";

export type WorkflowsManagerHandle = {
  openCreate: () => void;
};

export const ProjectWorkflowsManager = forwardRef<WorkflowsManagerHandle, { projectId: string }>(
  function ProjectWorkflowsManager({ projectId }, ref) {
    const { t } = useTranslation();
    const { workspaceSlug } = useParams<{ workspaceSlug: string }>();

    const [workflows, setWorkflows] = useState<OrchestrationWorkflow[]>([]);
    const [loading, setLoading] = useState(true);
    // 存失败分类而非译文/key——避免把 t 放进回调依赖（t 每渲染新引用会触发
    // effect 重跑 → loading 反复置位 → 区块闪烁，10-09 实证修复）。
    const [failure, setFailure] = useState<RuntimeFailureKind | null>(null);

    // 目录（弹层打开时取一次——agent 目录经编排域代理 agwmngr）
    const [experts, setExperts] = useState<OrchestrationAgentCatalogEntry[]>([]);

    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editing, setEditing] = useState<OrchestrationWorkflow | null>(null);
    const [form, setForm] = useState<WorkflowForm>(EMPTY_WORKFLOW_FORM);
    const [formError, setFormError] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [publishingId, setPublishingId] = useState("");
    const [message, setMessage] = useState("");
    // 版本历史（选中流程的版本列表弹层）
    const [historyFor, setHistoryFor] = useState<OrchestrationWorkflow | null>(null);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [historyVersions, setHistoryVersions] = useState<OrchestrationWorkflowVersion[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    // 删除确认
    const [deleteFor, setDeleteFor] = useState<OrchestrationWorkflow | null>(null);
    const [deleting, setDeleting] = useState(false);

    const canvasPath = (workflowId: string) => `/${workspaceSlug}/projects/${projectId}/workflows/${workflowId}`;

    // 关闭时先让弹层收起再清数据——直接置 null 会让收起动画期间标题闪成「· 版本历史」。
    const closeHistory = useCallback(() => {
      setHistoryOpen(false);
      setTimeout(() => setHistoryFor(null), 200);
    }, []);

    const loadedOnce = useRef(false);
    const load = useCallback(async () => {
      // 只有首帧（无数据）展示加载态；发布/删除后的刷新静默换数据，不闪。
      if (!loadedOnce.current) setLoading(true);
      try {
        const items = await orchestrationService.listWorkflows(workspaceSlug!, projectId);
        setWorkflows(items);
        setFailure(null);
        loadedOnce.current = true;
      } catch (error) {
        setFailure(classifyRuntimeFailure(error));
      } finally {
        setLoading(false);
      }
    }, [workspaceSlug, projectId]);

    useEffect(() => {
      void load();
    }, [load]);

    // 弹层打开时懒加载 agent 目录，失败静默降级为手填。
    useEffect(() => {
      if (!isModalOpen) return;
      let ignore = false;
      orchestrationService
        .listAgentCatalog(workspaceSlug!)
        .then((items) => {
          if (!ignore) setExperts(items);
          return null;
        })
        .catch(() => undefined);
      return () => {
        ignore = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isModalOpen]);

    function openHistory(workflow: OrchestrationWorkflow) {
      setHistoryFor(workflow);
      setHistoryOpen(true);
      setHistoryVersions([]);
      setHistoryLoading(true);
      orchestrationService
        .getWorkflow(workspaceSlug!, projectId, workflow.id)
        .then((wf) => setHistoryVersions(wf.versions ?? []))
        .catch(() => setHistoryVersions([]))
        .finally(() => setHistoryLoading(false));
    }

    function openCreate() {
      setEditing(null);
      setForm(EMPTY_WORKFLOW_FORM);
      setFormError("");
      setIsModalOpen(true);
    }

    function openEdit(workflow: OrchestrationWorkflow) {
      setEditing(workflow);
      setForm({
        name: workflow.name,
        description: workflow.description ?? "",
        expertId: "",
        singleAgentPrompt: "",
      });
      setFormError("");
      setIsModalOpen(true);
    }

    useImperativeHandle(ref, () => ({ openCreate }));

    async function handleSubmit() {
      setFormError("");
      const name = form.name.trim();
      if (!name || !form.expertId.trim()) {
        setFormError(t("agent_teams_wf_form_incomplete"));
        return;
      }
      setSubmitting(true);
      try {
        if (editing) {
          // 元数据编辑：名称/描述（引擎连接不再显式管理——env 承载，终局方案）。
          await orchestrationService.updateWorkflowInfo(workspaceSlug!, projectId, editing.id, {
            name,
            description: form.description.trim() || "",
          });
          setIsModalOpen(false);
          await load();
        } else {
          // 单 Agent 预设：创建即一个 agent 节点，多节点在画布扩展。
          const created = await orchestrationService.createWorkflow(workspaceSlug!, projectId, {
            name,
            description: form.description.trim() || undefined,
          });
          await orchestrationService.saveDraft(workspaceSlug!, projectId, created.id, {
            version: 1,
            nodes: [
              {
                id: "agent_1",
                type: "agent",
                position: { x: 240, y: 200 },
                data: {
                  name,
                  prompt: form.singleAgentPrompt.trim() || undefined,
                  expertId: form.expertId.trim(),
                },
              },
            ],
            edges: [],
          });
          setIsModalOpen(false);
          // 建完直达画布——创建只是起点，编排才是主体。
          window.location.assign(canvasPath(created.id));
        }
      } catch (err) {
        setFormError(t("agent_teams_wf_save_failed") + `：${(err as Error).message ?? ""}`);
      } finally {
        setSubmitting(false);
      }
    }

    async function handlePublish(workflow: OrchestrationWorkflow) {
      setPublishingId(workflow.id);
      setMessage("");
      try {
        const version = await orchestrationService.saveDraftVersion(workspaceSlug!, projectId, workflow.id);
        const published = await orchestrationService.publishVersion(workspaceSlug!, projectId, workflow.id, version.id);
        setMessage(
          published.status === "published"
            ? t("agent_teams_workflows_publish_ok", { version: String(published.version) })
            : `${t("agent_teams_workflows_publish_failed")}：${published.status}`
        );
        await load();
      } catch (err) {
        const errText = (err as Error).message ?? "";
        setMessage(
          /\[WORKFLOW_DRAFT_NOT_FOUND\]|\[WORKFLOW_DRAFT_EMPTY\]/.test(errText)
            ? t("agent_teams_workflows_publish_no_draft")
            : t("agent_teams_workflows_publish_failed")
        );
      } finally {
        setPublishingId("");
      }
    }

    async function handleDelete() {
      if (!deleteFor) return;
      setDeleting(true);
      try {
        await orchestrationService.deleteWorkflow(workspaceSlug!, projectId, deleteFor.id);
        setDeleteFor(null);
        await load();
      } catch {
        setMessage(t("agent_teams_workflows_delete_failed"));
      } finally {
        setDeleting(false);
      }
    }

    const busy = submitting || publishingId !== "";

    const columns = useWorkflowColumns({
      canvasPath,
      publishingId,
      busy,
      onOpenHistory: openHistory,
      onOpenEdit: openEdit,
      onPublish: (workflow) => void handlePublish(workflow),
      onDelete: setDeleteFor,
    });

    return (
      <>
        {message ? <span className="text-caption-sm-regular text-tertiary">{message}</span> : null}
        {loading ? (
          <div className="rounded-lg border border-subtle px-4 py-6 text-center text-body-sm-regular text-tertiary">
            {t("agent_teams_inbox_loading")}
          </div>
        ) : failure ? (
          <EmptyStateDetailed
            assetKey="server-error"
            assetClassName="size-40"
            title={t(
              failure === "unavailable" ? "agent_teams_runtime_unavailable_title" : "agent_teams_workflows_load_failed"
            )}
            description={failure === "unavailable" ? t("agent_teams_runtime_unavailable_hint") : undefined}
            actions={[{ label: t("agent_teams_project_retry"), variant: "secondary", onClick: () => void load() }]}
          />
        ) : workflows.length === 0 ? (
          // 空态不放「新建流程」按钮：与右上角主操作重复（新增/空态共用 header 入口）。
          <EmptyStateDetailed assetKey="module" assetClassName="size-40" title={t("agent_teams_workflows_empty")} />
        ) : (
          <div className="overflow-x-auto">
            <Table
              data={workflows}
              columns={columns}
              keyExtractor={(workflow) => workflow.id}
              tHeadClassName="border-b border-subtle"
              tHeadTrClassName="divide-x-0"
              thClassName="text-left font-medium text-placeholder"
              tBodyTrClassName="divide-x-0"
            />
          </div>
        )}

        <WorkflowFormModal
          isOpen={isModalOpen}
          editing={editing}
          form={form}
          formError={formError}
          submitting={submitting}
          experts={experts}
          onClose={() => setIsModalOpen(false)}
          onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
          onSubmit={() => void handleSubmit()}
        />

        <WorkflowHistoryModal
          isOpen={historyOpen}
          workflow={historyFor}
          versions={historyVersions}
          loading={historyLoading}
          onClose={closeHistory}
        />

        <WorkflowDeleteModal
          workflow={deleteFor}
          deleting={deleting}
          onClose={() => setDeleteFor(null)}
          onConfirm={() => void handleDelete()}
        />
      </>
    );
  }
);
