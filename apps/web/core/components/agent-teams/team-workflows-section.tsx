/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — team workflow library section (设计修订 2026-10-08
 * 阶段 3)：工作流归属团队，编排/发布/元数据编辑都在团队详情完成。数据权威
 * 在 Agent Team Runtime（§17 红线），经 runtime-token 通道调用。
 *
 * 交互与发布轮询复用管理端已验证的模式：创建走「单 Agent 完成」预设后进
 * 画布；发布 202 → 轮询 2s/最长 300s 到终态。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { GitBranch, Pencil, Plus, Rocket, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "react-router";
// services
import workflowService, {
  type EngineConnectionOption,
  type PublishedExpert,
  type TeamWorkflow,
} from "@/services/agent-teams/workflow.service";
// components
import { EmptyRow, RowList, Section } from "./section";

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

const STATUS_STYLES: Record<string, string> = {
  published: "rounded-full bg-green-500/15 px-2 py-0.5 text-[11px] text-green-600",
  draft: "rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-600",
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

export function TeamWorkflowsSection({ teamId }: { teamId: string }) {
  const { t } = useTranslation();
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();

  const [workflows, setWorkflows] = useState<TeamWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  // 存 i18n key 而非译文——避免把 t 放进回调依赖（t 每渲染新引用会触发
  // effect 重跑 → loading 反复置位 → 区块闪烁）。
  const [errorKey, setErrorKey] = useState("");

  // 目录（弹层打开时取一次——与管理端模型清单同一节奏）
  const [experts, setExperts] = useState<PublishedExpert[]>([]);
  const [engines, setEngines] = useState<EngineConnectionOption[]>([]);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editing, setEditing] = useState<TeamWorkflow | null>(null);
  const [form, setForm] = useState<WorkflowForm>(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pendingId, setPendingId] = useState("");
  const [publishingId, setPublishingId] = useState("");
  const [message, setMessage] = useState("");

  const canvasPath = (workflowId: string) => `/${workspaceSlug}/agent-teams/${teamId}/workflows/${workflowId}`;

  const loadedOnce = useRef(false);
  const load = useCallback(async () => {
    // 只有首帧（无数据）展示加载骨架；发布/删除后的刷新静默换数据，不闪骨架。
    if (!loadedOnce.current) setLoading(true);
    try {
      const items = await workflowService.listTeamWorkflows(teamId);
      setWorkflows(items);
      setErrorKey("");
      loadedOnce.current = true;
    } catch {
      setErrorKey("agent_teams_workflows_load_failed");
    } finally {
      loadedOnce.current = true;
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 弹窗 Esc/背板关闭与目录懒加载：ModalCore 承担交互，这里只备数据。
  useEffect(() => {
    if (!isModalOpen) return;
    let ignore = false;
    Promise.all([
      workflowService.listPublishedExperts().catch(() => [] as PublishedExpert[]),
      workflowService.listEngineConnections().catch(() => [] as EngineConnectionOption[]),
    ]).then(([expertItems, engineItems]) => {
      if (ignore) return;
      setExperts(expertItems);
      setEngines(engineItems);
      return null;
    });
    return () => {
      ignore = true;
    };
  }, [isModalOpen]);

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
        // 元数据编辑（阶段 3 补齐的入口）：名称/描述/负责成员/引擎。
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
      setFormError(
        t("agent_teams_wf_save_failed") +
          ((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "")
      );
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
      if (code === "WORKFLOW_DRAFT_NOT_FOUND") {
        setMessage(t("agent_teams_workflows_publish_no_draft"));
      } else {
        setMessage(t("agent_teams_workflows_publish_failed"));
      }
    } finally {
      setPublishingId("");
    }
  }

  async function handleDelete(workflow: TeamWorkflow) {
    if (!window.confirm(t("agent_teams_workflows_delete_confirm"))) return;
    setPendingId(workflow.id);
    try {
      await workflowService.deleteTeamWorkflow(teamId, workflow.id);
      await load();
    } catch {
      setMessage(t("agent_teams_workflows_delete_failed"));
    } finally {
      setPendingId("");
    }
  }

  const busy = submitting || publishingId !== "" || pendingId !== "";

  return (
    <Section
      label={t("agent_teams_workflows_title")}
      count={workflows.length}
      icon={<GitBranch className="size-3.5" aria-hidden />}
    >
      <div className="flex items-center justify-between gap-2">
        {message ? <span className="text-caption-sm-regular text-tertiary">{message}</span> : <span />}
        <button
          type="button"
          onClick={openCreate}
          className="hover:bg-custom-background-80 inline-flex items-center gap-1.5 rounded-lg border border-subtle bg-layer-2 px-3 py-1.5 text-caption-sm-medium text-primary transition-colors"
        >
          <Plus className="size-3.5" aria-hidden />
          {t("agent_teams_workflows_create")}
        </button>
      </div>
      {loading ? (
        <div className="rounded-lg border border-subtle px-4 py-6 text-center text-body-sm-regular text-tertiary">
          {t("agent_teams_inbox_loading")}
        </div>
      ) : error ? (
        <EmptyRow label={t(errorKey)} />
      ) : workflows.length === 0 ? (
        <EmptyRow label={t("agent_teams_workflows_empty")} />
      ) : (
        <RowList>
          {workflows.map((workflow, index) => (
            <div
              key={workflow.id}
              className={`flex flex-wrap items-center gap-2 px-4 py-3 ${index > 0 ? "border-t border-subtle" : ""}`}
            >
              <Link
                href={canvasPath(workflow.id)}
                className="truncate text-body-sm-medium text-primary transition-colors hover:text-accent-primary hover:underline"
              >
                {workflow.name}
              </Link>
              <span className={STATUS_STYLES[workflow.status] ?? STATUS_STYLES.draft}>
                {workflow.status === "published"
                  ? t("agent_teams_workflows_status_published")
                  : t("agent_teams_workflows_status_draft")}
              </span>
              {workflow.currentVersion != null && (
                <span className="text-caption-sm-regular text-tertiary">v{workflow.currentVersion}</span>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-1">
                <Link
                  href={canvasPath(workflow.id)}
                  className="rounded-md px-2 py-1 text-caption-sm-regular text-accent-primary hover:underline"
                >
                  {t("agent_teams_workflows_open_canvas")}
                </Link>
                <button
                  type="button"
                  onClick={() => openEdit(workflow)}
                  disabled={busy}
                  title={t("agent_teams_workflows_edit")}
                  className="rounded-md p-1.5 text-tertiary transition-colors hover:bg-layer-2 hover:text-primary disabled:opacity-50"
                >
                  <Pencil className="size-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => void handlePublish(workflow)}
                  disabled={busy}
                  title={t("agent_teams_workflows_publish")}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-caption-sm-regular text-accent-primary transition-colors hover:bg-layer-2 disabled:opacity-50"
                >
                  <Rocket className="size-3.5" aria-hidden />
                  {publishingId === workflow.id ? t("agent_teams_workflows_publishing") : ""}
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(workflow)}
                  disabled={busy}
                  title={t("agent_teams_workflows_delete")}
                  className="hover:text-red-500 rounded-md p-1.5 text-tertiary transition-colors hover:bg-layer-2 disabled:opacity-50"
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
              </span>
            </div>
          ))}
        </RowList>
      )}

      <ModalCore
        isOpen={isModalOpen}
        handleClose={() => setIsModalOpen(false)}
        position={EModalPosition.CENTER}
        width={EModalWidth.XXL}
      >
        <div className="flex flex-col gap-4 p-6">
          <h3 className="text-base text-custom-text-100 font-medium">
            {editing ? t("agent_teams_wf_modal_edit_title") : t("agent_teams_wf_modal_create_title")}
          </h3>
          {formError ? (
            <div className="border-red-500/30 bg-red-500/10 text-sm text-red-500 rounded-lg border px-3 py-2">
              {formError}
            </div>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-sm text-custom-text-200 grid gap-1">
              <span>{t("agent_teams_wf_field_name")} *</span>
              <input
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                className="border-custom-border-200 text-sm text-custom-text-100 focus:border-custom-primary-100 rounded-lg border bg-transparent px-3 py-2 outline-none"
              />
            </label>
            <label className="text-sm text-custom-text-200 grid gap-1">
              <span>{t("agent_teams_wf_field_owner")} *</span>
              <select
                value={form.ownerExpertId}
                onChange={(e) => setForm((prev) => ({ ...prev, ownerExpertId: e.target.value }))}
                className="border-custom-border-200 text-sm text-custom-text-100 focus:border-custom-primary-100 rounded-lg border bg-transparent px-3 py-2 outline-none"
              >
                <option value="">{t("agent_teams_wf_owner_placeholder")}</option>
                {experts.map((expert) => (
                  <option key={expert.id} value={expert.id}>
                    {expert.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-custom-text-200 grid gap-1 md:col-span-2">
              <span>{t("agent_teams_wf_field_desc")}</span>
              <input
                value={form.description}
                onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                className="border-custom-border-200 text-sm text-custom-text-100 focus:border-custom-primary-100 rounded-lg border bg-transparent px-3 py-2 outline-none"
              />
            </label>
            <label className="text-sm text-custom-text-200 grid gap-1">
              <span>{t("agent_teams_wf_field_engine")}</span>
              <select
                value={form.engineConnectionId}
                onChange={(e) => setForm((prev) => ({ ...prev, engineConnectionId: e.target.value }))}
                className="border-custom-border-200 text-sm text-custom-text-100 focus:border-custom-primary-100 rounded-lg border bg-transparent px-3 py-2 outline-none"
              >
                <option value="">{t("agent_teams_wf_engine_auto")}</option>
                {engines.map((engine) => (
                  <option key={engine.id} value={engine.id}>
                    {engine.name}
                  </option>
                ))}
              </select>
            </label>
            {!editing ? (
              <label className="text-sm text-custom-text-200 grid gap-1 md:col-span-2">
                <span>{t("agent_teams_wf_field_prompt")}</span>
                <textarea
                  value={form.singleAgentPrompt}
                  onChange={(e) => setForm((prev) => ({ ...prev, singleAgentPrompt: e.target.value }))}
                  rows={4}
                  className="border-custom-border-200 text-sm text-custom-text-100 focus:border-custom-primary-100 resize-y rounded-lg border bg-transparent px-3 py-2 outline-none"
                />
                <span className="text-xs text-custom-text-300">{t("agent_teams_wf_prompt_hint")}</span>
              </label>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsModalOpen(false)}
              className="border-custom-border-200 text-sm text-custom-text-200 hover:bg-custom-background-80 rounded-lg border px-4 py-2"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitting}
              className="bg-custom-primary-100 text-sm hover:bg-custom-primary-90 rounded-lg px-4 py-2 font-medium text-white disabled:opacity-60"
            >
              {submitting ? t("agent_teams_wf_saving") : t("common.save")}
            </button>
          </div>
        </div>
      </ModalCore>
    </Section>
  );
}
