/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — 团队管理模态组（设计 2026-10-19 §2/§4）：
 * 设置（编辑名称/目标）与添加成员（数字员工/人类成员双页签）。仅
 * viewerCanManage 渲染入口；权限判定在服务端，前端只做可见性。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { Button as PropelButton } from "@plane/propel/button";
import { EModalPosition, EModalWidth, Input, ModalCore, TextArea } from "@plane/ui";
import { CustomSelect } from "@plane/ui";
// services
import runtimeService from "@/services/agent-teams/runtime.service";
import workflowService, { type PublishedExpert } from "@/services/agent-teams/workflow.service";
import { expertsAuthHeaders } from "@/services/agent-teams/experts-auth";

export function TeamSettingsModal({
  isOpen,
  handleClose,
  name,
  objective,
  onSave,
  saving,
  errorKey,
}: {
  isOpen: boolean;
  handleClose: () => void;
  name: string;
  objective: string;
  onSave: (patch: { name: string; objective: string }) => void;
  saving: boolean;
  errorKey: string;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ name, objective });
  useEffect(() => {
    if (isOpen) setForm({ name, objective });
  }, [isOpen, name, objective]);
  return (
    <ModalCore isOpen={isOpen} handleClose={handleClose} position={EModalPosition.TOP} width={EModalWidth.SM}>
      <div className="flex flex-col gap-4 p-5">
        <h3 className="text-body-lg-medium m-0 text-primary">{t("agent_teams_settings_title")}</h3>
        {errorKey ? (
          <p className="border-danger-primary/30 m-0 rounded-md border bg-danger-primary/5 px-3 py-2 text-body-xs-regular text-danger-primary">
            {t(errorKey)}
          </p>
        ) : null}
        <label className="flex flex-col gap-1.5">
          <span className="text-caption-sm-medium text-secondary">{t("agent_teams_create_name_label")}</span>
          <Input
            mode="primary"
            inputSize="sm"
            className="w-full"
            value={form.name}
            onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-caption-sm-medium text-secondary">{t("agent_teams_create_objective_label")}</span>
          <TextArea
            mode="primary"
            textAreaSize="sm"
            className="min-h-20 w-full resize-y"
            value={form.objective}
            onChange={(event) => setForm((prev) => ({ ...prev, objective: event.target.value }))}
          />
        </label>
        <div className="flex items-center justify-end gap-2 border-t border-subtle pt-4">
          <PropelButton variant="secondary" size="lg" onClick={handleClose}>
            {t("cancel")}
          </PropelButton>
          <PropelButton
            variant="primary"
            size="lg"
            loading={saving}
            onClick={() => onSave({ name: form.name.trim(), objective: form.objective.trim() })}
          >
            {t("save")}
          </PropelButton>
        </div>
      </div>
    </ModalCore>
  );
}

type Candidate = { id: string; name: string; hint?: string };

export function AddMemberModal({
  isOpen,
  handleClose,
  teamId,
  onAdded,
}: {
  isOpen: boolean;
  handleClose: () => void;
  teamId: string;
  onAdded: () => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<"agent" | "human">("agent");
  const [role, setRole] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // 存 i18n key：t 每渲染新引用，进 effect 依赖会死循环（既往三次同款教训）。
  const [errorKey, setErrorKey] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    let ignore = false;
    setSelected("");
    // 后端 role 必填：按类型预填常规默认值，可改（描述性字段，暂无派发
    // 语义耦合——admin 表单同款自由文本）。
    setRole(kind === "agent" ? "worker" : "approver");
    setErrorKey("");
    setLoading(true);
    (async () => {
      try {
        let list: Candidate[] = [];
        if (kind === "agent") {
          const experts: PublishedExpert[] = await workflowService.listPublishedExperts();
          list = experts.map((expert) => ({ id: expert.id, name: expert.name }));
        } else {
          const headers = await expertsAuthHeaders();
          const tenantId = headers["X-Tenant-ID"] ?? headers["x-tenant-id"];
          if (typeof tenantId === "string" && tenantId) {
            const members = await workflowService.listTenantMembers(tenantId);
            list = members.map((m) => ({ id: m.userId, name: m.name || m.email || m.userId, hint: m.email }));
          }
        }
        if (!ignore) setCandidates(list);
      } catch {
        if (!ignore) setErrorKey("agent_teams_member_candidates_failed");
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [isOpen, kind]);

  const submit = async () => {
    if (!selected) return;
    setSubmitting(true);
    setErrorKey("");
    try {
      if (kind === "agent") {
        await runtimeService.addTeamMember(teamId, { kind, expertId: selected, role: role.trim() || "worker" });
      } else {
        await runtimeService.addTeamMember(teamId, { kind, userId: selected, role: role.trim() || "approver" });
      }
      onAdded();
      handleClose();
    } catch (error) {
      const status = (error as { response?: { status?: number; data?: { code?: string } } })?.response;
      if (status?.data?.code === "AGENT_TEAM_MEMBER_CONFLICT") {
        setErrorKey("agent_teams_member_conflict");
      } else if (status?.status === 404) {
        setErrorKey("agent_teams_member_source_missing");
      } else {
        setErrorKey("agent_teams_member_add_failed");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalCore isOpen={isOpen} handleClose={handleClose} position={EModalPosition.TOP} width={EModalWidth.SM}>
      <div className="flex flex-col gap-4 p-5">
        <h3 className="text-body-lg-medium m-0 text-primary">{t("agent_teams_add_member_title")}</h3>
        {/* 双页签（设计 §2）：数字员工=已发布专家目录；人类成员=租户成员目录 */}
        <div className="grid grid-cols-2 gap-2 rounded-md bg-layer-2 p-1 text-body-sm-regular">
          <button
            type="button"
            onClick={() => setKind("agent")}
            className={`rounded px-3 py-1.5 ${kind === "agent" ? "shadow-sm bg-layer-1 font-medium text-primary" : "text-tertiary"}`}
          >
            {t("agent_teams_member_kind_agent")}
          </button>
          <button
            type="button"
            onClick={() => setKind("human")}
            className={`rounded px-3 py-1.5 ${kind === "human" ? "shadow-sm bg-layer-1 font-medium text-primary" : "text-tertiary"}`}
          >
            {t("agent_teams_member_kind_human")}
          </button>
        </div>
        {errorKey ? (
          <p className="border-danger-primary/30 m-0 rounded-md border bg-danger-primary/5 px-3 py-2 text-body-xs-regular text-danger-primary">
            {t(errorKey)}
          </p>
        ) : null}
        <span className="flex flex-col gap-1.5">
          <span className="text-caption-sm-medium text-secondary">{t("agent_teams_member_pick_label")}</span>
          {loading ? (
            <p className="m-0 py-3 text-center text-body-sm-regular text-tertiary">{t("agent_teams_inbox_loading")}</p>
          ) : (
            <CustomSelect
              value={selected}
              onChange={(value: string) => setSelected(value)}
              label={
                <div className="flex h-full items-center gap-1">
                  {selected ? (
                    (candidates.find((candidate) => candidate.id === selected)?.name ?? selected)
                  ) : (
                    <span className="flex-grow truncate text-left text-placeholder">
                      {t("agent_teams_member_pick_placeholder")}
                    </span>
                  )}
                </div>
              }
              placement="bottom-start"
              className="h-8"
              buttonClassName="h-8"
              noChevron
            >
              {candidates.length === 0 ? (
                <CustomSelect.Option key="__empty" value="">
                  <span className="text-caption-sm-regular text-tertiary">
                    {kind === "agent" ? t("agent_teams_member_no_experts") : t("agent_teams_member_no_humans")}
                  </span>
                </CustomSelect.Option>
              ) : (
                candidates.map((candidate) => (
                  <CustomSelect.Option key={candidate.id} value={candidate.id}>
                    <div className="flex items-center gap-2">
                      <span className="truncate">{candidate.name}</span>
                      {candidate.hint ? (
                        <span className="ml-auto truncate text-caption-sm-regular text-tertiary">{candidate.hint}</span>
                      ) : null}
                    </div>
                  </CustomSelect.Option>
                ))
              )}
            </CustomSelect>
          )}
        </span>
        <label className="flex flex-col gap-1.5">
          <span className="text-caption-sm-medium text-secondary">{t("agent_teams_member_role_label")}</span>
          <Input
            mode="primary"
            inputSize="sm"
            className="w-full"
            value={role}
            onChange={(event) => setRole(event.target.value)}
            placeholder={kind === "agent" ? "worker" : "approver"}
          />
        </label>
        <p className="m-0 text-caption-sm-regular text-tertiary">
          {kind === "agent" ? t("agent_teams_member_agent_hint") : t("agent_teams_member_human_hint")}
        </p>
        <div className="flex items-center justify-end gap-2 border-t border-subtle pt-4">
          <PropelButton variant="secondary" size="lg" onClick={handleClose}>
            {t("cancel")}
          </PropelButton>
          <PropelButton
            variant="primary"
            size="lg"
            loading={submitting}
            disabled={!selected}
            onClick={() => void submit()}
          >
            {t("agent_teams_add_member_title")}
          </PropelButton>
        </div>
      </div>
    </ModalCore>
  );
}
