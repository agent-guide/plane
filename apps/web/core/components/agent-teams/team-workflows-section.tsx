/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — team workflow library section (设计修订 2026-10-08
 * 阶段 3)：工作流归属团队，编排/发布/元数据编辑都在团队详情完成。数据权威
 * 在 Agent Team Runtime（§17 红线），经 runtime-token 通道调用。
 *
 * UI 词汇严格取自 Plane 端既有形态：行样式/状态点沿用团队列表页，动作收纳
 * 进 ⋯ 菜单（CustomMenu + IconButton），弹层用 ModalCore + Input/TextArea/Button，
 * 主操作用 Button。发布轮询复用管理端验证过的模式（202 → 2s/最长 300s）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { Button as PropelButton } from "@plane/propel/button";

import { AlertModalCore, CustomMenu, EModalPosition, EModalWidth, Input, ModalCore, Table, TextArea } from "@plane/ui";
import { GitBranch, History, MoreHorizontal, Pencil, Plus, Rocket, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "react-router";
// services
import workflowService, {
  type EngineConnectionOption,
  type PublishedExpert,
  type TeamWorkflow,
  type TeamWorkflowVersion,
} from "@/services/agent-teams/workflow.service";
// components
import { EmptyRow, RowList, Section } from "./section";
import { FormSelect } from "./form-select";

type WorkflowForm = {
  name: string;
  description: string;
  ownerExpertId: string;
  engineConnectionId: string;
  singleAgentPrompt: string;
};

const EMPTY_FORM: WorkflowForm = {
  name: "",
  description: "",
  ownerExpertId: "",
  engineConnectionId: "",
  singleAgentPrompt: "",
};

// 串行间隔轮询（2s/最长 300s）用 then 链表达：无循环 await，链上每步有返回值。
function pollPublish(
  teamId: string,
  workflowId: string,
  versionId: string,
  onSettled: (status: string, versionNumber?: number, error?: string) => void
): Promise<void> {
  const deadline = Date.now() + 300_000;
  const tick = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 2000))
      .then(() => workflowService.getTeamWorkflowVersion(teamId, workflowId, versionId))
      .then((version) => {
        if (version.status === "published") {
          onSettled("published", version.version);
          return;
        }
        if (version.status === "failed") {
          onSettled("failed", undefined, version.publishError ?? "");
          return;
        }
        if (Date.now() >= deadline) {
          onSettled("timeout");
          return;
        }
        return tick();
      })
      // 瞬时网络抖动不该中断观测——吞掉后继续下一轮直到 deadline。
      .catch(() => {
        if (Date.now() >= deadline) {
          onSettled("timeout");
          return;
        }
        return tick();
      });
  return tick();
}

/** 状态点：与团队列表页同款（quiet dot + 着色文案），不做实心徽章。 */
function WorkflowStatus({ status }: { status: string }) {
  const { t } = useTranslation();
  const active = status === "published";
  return (
    <span
      className={`inline-flex flex-shrink-0 items-center gap-1 text-caption-sm-regular ${
        active ? "text-accent-primary" : "text-tertiary"
      }`}
    >
      <span className={`size-1.5 rounded-full ${active ? "bg-accent-primary" : "bg-tertiary"}`} aria-hidden />
      {active ? t("agent_teams_workflows_status_published") : t("agent_teams_workflows_status_draft")}
    </span>
  );
}

export function TeamWorkflowsSection({ teamId }: { teamId: string }) {
  const { t } = useTranslation();
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();

  const [workflows, setWorkflows] = useState<TeamWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  // 存 i18n key 而非译文——避免把 t 放进回调依赖（t 每渲染新引用会触发
  // effect 重跑 → loading 反复置位 → 区块闪烁，10-09 实证修复）。
  const [errorKey, setErrorKey] = useState("");

  // 目录（弹层打开时取一次——与管理端模型清单同一节奏）
  const [experts, setExperts] = useState<PublishedExpert[]>([]);
  const [engines, setEngines] = useState<EngineConnectionOption[]>([]);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editing, setEditing] = useState<TeamWorkflow | null>(null);
  const [form, setForm] = useState<WorkflowForm>(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [publishingId, setPublishingId] = useState("");
  const [message, setMessage] = useState("");
  // 版本历史（管理端工作流库同能力迁移）：选中流程的版本列表弹层。
  const [historyFor, setHistoryFor] = useState<TeamWorkflow | null>(null);
  // 关闭时先让弹层收起再清数据——直接置 null 会让收起动画期间标题闪成「· 版本历史」。
  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    setTimeout(() => setHistoryFor(null), 200);
  }, []);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyVersions, setHistoryVersions] = useState<TeamWorkflowVersion[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const canvasPath = (workflowId: string) => `/${workspaceSlug}/agent-teams/${teamId}/workflows/${workflowId}`;

  // 版本历史列：版本[最新标]/状态[失败⚠]/发布时间/创建人（定义摘要是审计用
  // 内容指纹，对用户无消费价值，不展示）。
  const historyColumns = useMemo(
    () => [
      {
        key: "version",
        content: t("agent_teams_wf_col_version"),
        tdRender: (row: TeamWorkflowVersion) => (
          <span className="text-13 text-primary">
            v{row.version}
            {historyVersions[0]?.id === row.id ? (
              <span className="ml-2 rounded-full bg-accent-subtle px-2 py-0.5 text-11 text-accent-primary">
                {t("agent_teams_wf_latest")}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        key: "status",
        content: t("agent_teams_wf_col_status"),
        tdRender: (row: TeamWorkflowVersion) => (
          <span>
            <WorkflowStatus status={row.status} />
            {row.publishError ? (
              <span className="ml-1 text-11 text-danger-primary" title={row.publishError}>
                ⚠
              </span>
            ) : null}
          </span>
        ),
      },
      {
        key: "publishedAt",
        content: t("agent_teams_wf_col_published_at"),
        tdRender: (row: TeamWorkflowVersion) => (
          <span className="text-12 text-secondary">
            {row.publishedAt ? new Date(row.publishedAt).toLocaleString() : "-"}
          </span>
        ),
      },
      {
        key: "createdBy",
        content: t("agent_teams_wf_col_created_by"),
        tdRender: (row: TeamWorkflowVersion) => (
          <span className="text-12 text-secondary">{row.createdByName ?? row.createdBy ?? "-"}</span>
        ),
      },
    ],
    [t, historyVersions]
  );

  const loadedOnce = useRef(false);
  const load = useCallback(async () => {
    // 只有首帧（无数据）展示加载态；发布/删除后的刷新静默换数据，不闪。
    if (!loadedOnce.current) setLoading(true);
    try {
      const items = await workflowService.listTeamWorkflows(teamId);
      setWorkflows(items);
      setErrorKey("");
      loadedOnce.current = true;
    } catch {
      setErrorKey("agent_teams_workflows_load_failed");
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 弹层打开时懒加载目录（负责成员/引擎清单），失败静默降级为手填。
  useEffect(() => {
    if (!isModalOpen) return;
    let ignore = false;
    Promise.all([
      workflowService.listPublishedExperts().catch(() => [] as PublishedExpert[]),
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
  }, [isModalOpen]);

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
    setForm(EMPTY_FORM);
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

  // 删除确认走 AlertModalCore（Plane 标准确认弹层，cycles/delete-modal 同款），
  // 不用原生 window.confirm。
  const [deleteFor, setDeleteFor] = useState<TeamWorkflow | null>(null);
  const [deleting, setDeleting] = useState(false);

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

  return (
    <Section
      label={t("agent_teams_workflows_title")}
      count={workflows.length}
      icon={<GitBranch className="size-3.5" aria-hidden />}
      action={
        <PropelButton variant="secondary" size="lg" onClick={openCreate}>
          <Plus className="size-3.5" aria-hidden />
          {t("agent_teams_workflows_create")}
        </PropelButton>
      }
    >
      {message ? <span className="text-caption-sm-regular text-tertiary">{message}</span> : null}
      {loading ? (
        <div className="rounded-lg border border-subtle px-4 py-6 text-center text-body-sm-regular text-tertiary">
          {t("agent_teams_inbox_loading")}
        </div>
      ) : errorKey ? (
        <EmptyRow label={t(errorKey)} />
      ) : workflows.length === 0 ? (
        <EmptyRow label={t("agent_teams_workflows_empty")} />
      ) : (
        <RowList>
          {workflows.map((workflow, index) => (
            <div
              key={workflow.id}
              className={`flex items-center gap-3 px-4 py-3 ${index > 0 ? "border-t border-subtle" : ""}`}
            >
              <Link
                href={canvasPath(workflow.id)}
                className="truncate text-body-sm-medium text-primary transition-colors hover:text-accent-primary hover:underline"
              >
                {workflow.name}
              </Link>
              <WorkflowStatus status={workflow.status} />
              {workflow.currentVersion != null ? (
                <span className="text-caption-sm-regular text-tertiary">v{workflow.currentVersion}</span>
              ) : null}
              {publishingId === workflow.id ? (
                <span className="text-caption-sm-regular text-accent-primary">
                  {t("agent_teams_workflows_publishing")}
                </span>
              ) : null}
              <span className="ml-auto" />
              <CustomMenu
                customButton={<MoreHorizontal className="size-4 text-tertiary hover:text-primary" aria-hidden />}
                placement="bottom-end"
                closeOnSelect
              >
                <CustomMenu.MenuItem
                  onClick={() => window.open(canvasPath(workflow.id), "_self")}
                  className="flex items-center gap-2"
                >
                  <GitBranch className="size-3.5" aria-hidden />
                  {t("agent_teams_workflows_open_canvas")}
                </CustomMenu.MenuItem>
                <CustomMenu.MenuItem onClick={() => openHistory(workflow)} className="flex items-center gap-2">
                  <History className="size-3.5" aria-hidden />
                  {t("agent_teams_workflows_history")}
                </CustomMenu.MenuItem>
                <CustomMenu.MenuItem onClick={() => openEdit(workflow)} className="flex items-center gap-2">
                  <Pencil className="size-3.5" aria-hidden />
                  {t("agent_teams_workflows_edit")}
                </CustomMenu.MenuItem>
                <CustomMenu.MenuItem
                  onClick={() => void handlePublish(workflow)}
                  disabled={busy}
                  className="flex items-center gap-2"
                >
                  <Rocket className="size-3.5" aria-hidden />
                  {t("agent_teams_workflows_publish")}
                </CustomMenu.MenuItem>
                <CustomMenu.MenuItem
                  onClick={() => setDeleteFor(workflow)}
                  className="text-red-500 flex items-center gap-2"
                >
                  <Trash2 className="size-3.5" aria-hidden />
                  {t("agent_teams_workflows_delete")}
                </CustomMenu.MenuItem>
              </CustomMenu>
            </div>
          ))}
        </RowList>
      )}

      <ModalCore
        isOpen={isModalOpen}
        handleClose={() => setIsModalOpen(false)}
        position={EModalPosition.TOP}
        width={EModalWidth.XXL}
      >
        {/* 逐字对齐 Plane 周期创建表单（cycles/form.tsx）的结构与规格：
            p-5/space-y-5 外层、text-18 标题、竖排 space-y-3 字段、
            Input md + text-14、错误 text-11 红字、
            border-t-[0.5px] 页脚 + propel Button secondary/primary size lg。 */}
        <div className="space-y-5 p-5">
          <h3 className="text-18 font-medium text-secondary">
            {editing ? t("agent_teams_wf_modal_edit_title") : t("agent_teams_wf_modal_create_title")}
          </h3>
          <div className="space-y-3">
            <div className="space-y-1">
              <Input
                name="name"
                type="text"
                inputSize="sm"
                className="w-full"
                placeholder={`${t("agent_teams_wf_field_name")} *`}
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                hasError={Boolean(formError)}
              />
              {formError ? <span className="text-11 text-danger-primary">{formError}</span> : null}
            </div>
            <div className="space-y-1">
              <FormSelect
                value={form.ownerExpertId}
                placeholder={`${t("agent_teams_wf_field_owner")} *`}
                options={experts.map((e) => ({ id: e.id, name: e.name }))}
                onChange={(v) => setForm((prev) => ({ ...prev, ownerExpertId: v }))}
              />
            </div>
            <div className="space-y-1">
              <TextArea
                name="description"
                mode="primary"
                textAreaSize="sm"
                className="font-normal min-h-16 w-full resize-none text-13"
                placeholder={t("agent_teams_wf_field_desc")}
                value={form.description}
                onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <FormSelect
                value={form.engineConnectionId}
                placeholder={t("agent_teams_wf_engine_auto")}
                options={engines.map((e) => ({ id: e.id, name: e.name }))}
                onChange={(v) => setForm((prev) => ({ ...prev, engineConnectionId: v }))}
              />
              <span className="text-11 text-tertiary">{t("agent_teams_wf_engine_auto")}</span>
            </div>
            {!editing ? (
              <div className="space-y-1">
                <TextArea
                  name="singleAgentPrompt"
                  mode="primary"
                  textAreaSize="sm"
                  className="font-normal min-h-24 w-full resize-none text-13"
                  placeholder={t("agent_teams_wf_field_prompt")}
                  value={form.singleAgentPrompt}
                  onChange={(e) => setForm((prev) => ({ ...prev, singleAgentPrompt: e.target.value }))}
                />
                <span className="text-11 text-tertiary">{t("agent_teams_wf_prompt_hint")}</span>
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t-[0.5px] border-subtle px-5 py-4">
          <PropelButton variant="secondary" size="lg" onClick={() => setIsModalOpen(false)}>
            {t("cancel")}
          </PropelButton>
          <PropelButton variant="primary" size="lg" onClick={() => void handleSubmit()} loading={submitting}>
            {submitting ? t("agent_teams_wf_saving") : t("save")}
          </PropelButton>
        </div>
      </ModalCore>

      {/* 版本历史：管理端同内容（版本[最新]/状态[失败⚠]/发布时间/发布人/定义摘要），
          Plane 弹层与表格样式。 */}
      <ModalCore isOpen={historyOpen} handleClose={closeHistory} position={EModalPosition.TOP} width={EModalWidth.XXL}>
        <div className="space-y-4 p-5">
          <h3 className="text-18 font-medium text-secondary">
            {t("agent_teams_workflows_history_title", { name: historyFor?.name ?? "" })}
          </h3>
          {historyLoading ? (
            <div className="py-8 text-center text-13 text-tertiary">{t("agent_teams_inbox_loading")}</div>
          ) : historyVersions.length === 0 ? (
            <EmptyRow label={t("agent_teams_workflows_history_empty")} />
          ) : (
            <Table
              columns={historyColumns}
              data={historyVersions}
              keyExtractor={(row) => row.id}
              tHeadClassName="border-b border-subtle"
              thClassName="text-left font-medium divide-x-0 text-placeholder"
              tBodyClassName="divide-y-0"
              tBodyTrClassName="divide-x-0 h-[40px] text-secondary"
              tHeadTrClassName="divide-x-0"
            />
          )}
        </div>
        <div className="flex items-center justify-end border-t-[0.5px] border-subtle px-5 py-4">
          <PropelButton variant="secondary" size="lg" onClick={closeHistory}>
            {t("close")}
          </PropelButton>
        </div>
      </ModalCore>

      {/* 删除确认：AlertModalCore（Plane 标准形态）。 */}
      <AlertModalCore
        handleClose={() => setDeleteFor(null)}
        handleSubmit={() => void handleDelete()}
        isSubmitting={deleting}
        isOpen={!!deleteFor}
        title={t("agent_teams_workflows_delete")}
        primaryButtonText={{
          loading: t("agent_teams_workflows_deleting"),
          default: t("agent_teams_workflows_delete"),
        }}
        secondaryButtonText={t("cancel")}
        content={
          <>
            {t("agent_teams_workflows_delete_confirm_prefix")}
            {' "'}
            <span className="font-medium break-words text-primary">{deleteFor?.name}</span>
            {'"'}
            {t("agent_teams_workflows_delete_confirm_suffix")}
          </>
        }
      />
    </Section>
  );
}
