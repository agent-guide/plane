/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — 团队流程库整页编排（从 team-workflows-section 拆出）。
 * 持全部数据与操作状态，行/弹层拆到 workflows/ 下各组件。数据权威在 Agent
 * Team Runtime（§17 红线），经 runtime-token 通道调用。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { useParams } from "react-router";
import { EmptyStateDetailed } from "@plane/propel/empty-state";
import { Table } from "@plane/ui";
// services
import workflowService, {
  type EngineConnectionOption,
  type PublishedExpert,
  type TeamWorkflow,
  type TeamWorkflowVersion,
} from "@/services/agent-teams/workflow.service";
import runtimeService from "@/services/agent-teams/runtime.service";
import { classifyRuntimeFailure, type RuntimeFailureKind } from "@/services/agent-teams/runtime-errors";
import { setExpertsWorkspaceSlug } from "@/services/agent-teams/experts-auth";
// components
import { useWorkflowColumns } from "./workflow-columns";
import { WorkflowFormModal, EMPTY_WORKFLOW_FORM, type WorkflowForm } from "./workflow-form-modal";
import { WorkflowHistoryModal } from "./workflow-history-modal";
import { WorkflowDeleteModal } from "./workflow-delete-modal";
import { pollPublish } from "./publish-poll";

export type TeamWorkflowsManagerHandle = {
  openCreate: () => void;
};

export const TeamWorkflowsManager = forwardRef<TeamWorkflowsManagerHandle, { teamId: string }>(
  function TeamWorkflowsManager({ teamId }, ref) {
    const { t } = useTranslation();
    const { workspaceSlug } = useParams<{ workspaceSlug: string }>();

    const [workflows, setWorkflows] = useState<TeamWorkflow[]>([]);
    const [loading, setLoading] = useState(true);
    // 存失败分类而非译文/key——避免把 t 放进回调依赖（t 每渲染新引用会触发
    // effect 重跑 → loading 反复置位 → 区块闪烁，10-09 实证修复）。
    // 分类区分「重试有用」与「工作区没接入，重试永远不成功」。
    const [failure, setFailure] = useState<RuntimeFailureKind | null>(null);

    // 目录（弹层打开时取一次——与管理端模型清单同一节奏）
    const [experts, setExperts] = useState<PublishedExpert[]>([]);
    const [engines, setEngines] = useState<EngineConnectionOption[]>([]);

    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editing, setEditing] = useState<TeamWorkflow | null>(null);
    const [form, setForm] = useState<WorkflowForm>(EMPTY_WORKFLOW_FORM);
    const [formError, setFormError] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [publishingId, setPublishingId] = useState("");
    const [message, setMessage] = useState("");
    // 版本历史（管理端工作流库同能力迁移）：选中流程的版本列表弹层。
    const [historyFor, setHistoryFor] = useState<TeamWorkflow | null>(null);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [historyVersions, setHistoryVersions] = useState<TeamWorkflowVersion[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    // 删除确认
    const [deleteFor, setDeleteFor] = useState<TeamWorkflow | null>(null);
    const [deleting, setDeleting] = useState(false);

    const canvasPath = (workflowId: string) => `/${workspaceSlug}/agent-teams/${teamId}/workflows/${workflowId}`;

    // 关闭时先让弹层收起再清数据——直接置 null 会让收起动画期间标题闪成「· 版本历史」。
    const closeHistory = useCallback(() => {
      setHistoryOpen(false);
      setTimeout(() => setHistoryFor(null), 200);
    }, []);

    const loadedOnce = useRef(false);
    const load = useCallback(async () => {
      setExpertsWorkspaceSlug(workspaceSlug);
      // 只有首帧（无数据）展示加载态；发布/删除后的刷新静默换数据，不闪。
      if (!loadedOnce.current) setLoading(true);
      try {
        const items = await workflowService.listTeamWorkflows(teamId);
        setWorkflows(items);
        setFailure(null);
        loadedOnce.current = true;
      } catch (error) {
        setFailure(classifyRuntimeFailure(error));
      } finally {
        setLoading(false);
      }
    }, [teamId, workspaceSlug]);

    useEffect(() => {
      void load();
    }, [load]);

    // 弹层打开时懒加载目录（负责成员/引擎清单），失败静默降级为手填。
    // 负责成员候选 = 本团队在编数字员工（验收修正 2026-10-15：原全租户
    // 已发布专家目录与团队不符）；团队暂无数字员工时回退全目录防呆。
    useEffect(() => {
      if (!isModalOpen) return;
      let ignore = false;
      Promise.all([
        runtimeService
          .listTeamMembers(teamId)
          .then((members) => {
            const agentEntries = members
              .filter((m) => m.kind === "agent" && m.expertId)
              .map((m) => ({ id: m.expertId as string, name: m.displayName || m.role }));
            return agentEntries.length > 0
              ? agentEntries
              : (workflowService.listPublishedExperts().catch(() => [] as PublishedExpert[]) as Promise<
                  { id: string; name: string }[]
                >);
          })
          .catch(() => workflowService.listPublishedExperts().catch(() => [] as PublishedExpert[])),
        workflowService.listEngineConnections().catch(() => [] as EngineConnectionOption[]),
      ]).then(([expertItems, engineItems]) => {
        if (ignore) return null;
        setExperts(expertItems);
        setEngines(engineItems);
        return null;
      });
      return () => {
        ignore = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isModalOpen, teamId]);

    function openHistory(workflow: TeamWorkflow) {
      setHistoryFor(workflow);
      setHistoryOpen(true);
      setHistoryVersions([]);
      setHistoryLoading(true);
      workflowService
        .listTeamWorkflowVersions(teamId, workflow.id)
        .then((items) => setHistoryVersions(items))
        .catch(() => setHistoryVersions([]))
        .finally(() => setHistoryLoading(false));
    }

    function openCreate() {
      setEditing(null);
      setForm(EMPTY_WORKFLOW_FORM);
      setFormError("");
      setIsModalOpen(true);
    }

    function openEdit(workflow: TeamWorkflow) {
      setEditing(workflow);
      setForm({
        name: workflow.name,
        description: workflow.description ?? "",
        ownerExpertId: workflow.ownerExpertId ?? "",
        engineConnectionId: workflow.engineConnectionId ?? "",
        singleAgentPrompt: "",
      });
      setFormError("");
      setIsModalOpen(true);
    }

    useImperativeHandle(ref, () => ({ openCreate }));

    async function handleSubmit() {
      setFormError("");
      const name = form.name.trim();
      if (!name || !form.ownerExpertId.trim()) {
        setFormError(t("agent_teams_wf_form_incomplete"));
        return;
      }
      setSubmitting(true);
      try {
        if (editing) {
          // 元数据编辑：名称/描述/负责成员/引擎（阶段 3 补齐的入口）。
          await workflowService.updateTeamWorkflow(teamId, editing.id, {
            name,
            description: form.description.trim() || undefined,
            ownerExpertId: form.ownerExpertId.trim(),
            engineConnectionId: form.engineConnectionId || null,
          });
          setIsModalOpen(false);
          await load();
        } else {
          // 单 Agent 预设（plan §5.5/599）：创建即一个 agent 节点，多节点在画布扩展。
          const created = await workflowService.createTeamWorkflow(teamId, {
            name,
            description: form.description.trim() || undefined,
            ownerExpertId: form.ownerExpertId.trim(),
            engineConnectionId: form.engineConnectionId || null,
            graph: {
              version: 1,
              nodes: [
                {
                  id: "agent_1",
                  type: "agent",
                  position: { x: 240, y: 200 },
                  data: {
                    name,
                    prompt: form.singleAgentPrompt.trim() || undefined,
                    expertId: form.ownerExpertId.trim(),
                  },
                },
              ],
              edges: [],
            },
          });
          setIsModalOpen(false);
          // 建完直达画布——与管理端同一节奏（创建只是起点，编排才是主体）。
          window.location.assign(canvasPath(created.id));
        }
      } catch (err) {
        const detail = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
        setFormError(t("agent_teams_wf_save_failed") + (detail ? `：${detail}` : ""));
      } finally {
        setSubmitting(false);
      }
    }

    async function handlePublish(workflow: TeamWorkflow) {
      setPublishingId(workflow.id);
      setMessage("");
      try {
        const version = await workflowService.publishTeamWorkflow(teamId, workflow.id);
        await pollPublish(teamId, workflow.id, version.id, (status, versionNumber, errText) => {
          if (status === "published") {
            setMessage(t("agent_teams_workflows_publish_ok", { version: String(versionNumber ?? "") }));
            void load();
          } else if (status === "failed") {
            setMessage(`${t("agent_teams_workflows_publish_failed")}${errText ? `：${errText}` : ""}`);
          } else {
            setMessage(t("agent_teams_workflows_publish_timeout"));
          }
        });
      } catch (err) {
        const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
        setMessage(
          code === "WORKFLOW_DRAFT_NOT_FOUND"
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
        await workflowService.deleteTeamWorkflow(teamId, deleteFor.id);
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
          // 本页是整页列表：用详细空态（竖版插图、左对齐），与工作项/周期一致。
          // 工作区没接入时重试永远不成功——只给说明与指引。
          failure === "not_connected" ? (
            <EmptyStateDetailed
              assetKey="invalid-link"
              assetClassName="size-40"
              title={t("agent_teams_runtime_not_connected_title")}
              description={t("agent_teams_runtime_not_connected_hint")}
            />
          ) : (
            <EmptyStateDetailed
              assetKey="server-error"
              assetClassName="size-40"
              title={t(
                failure === "unavailable"
                  ? "agent_teams_runtime_unavailable_title"
                  : "agent_teams_workflows_load_failed"
              )}
              description={failure === "unavailable" ? t("agent_teams_runtime_unavailable_hint") : undefined}
              actions={[{ label: t("agent_teams_project_retry"), variant: "secondary", onClick: () => void load() }]}
            />
          )
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
          engines={engines}
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
