/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — 绑定团队弹层（成员收敛 §3.4 两步绑定第一步）：
 * 只选团队，不涉流程/版本——绑定后项目才能建流程（成员从团队中挑），
 * 流程发布后再第二步「配置流程」挂载版本。轻量小弹层。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { Button as PropelButton } from "@plane/propel/button";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
// services
import { orchestrationService, type OrchestrationTeam } from "@/services/agent-teams/orchestration.service";
import { FormSelect } from "@/components/agent-teams/form-select";

export function TeamBindModal({
  isOpen,
  handleClose,
  workspaceSlug,
  projectId,
  onBound,
}: {
  isOpen: boolean;
  handleClose: () => void;
  workspaceSlug: string;
  projectId: string;
  /** 绑定成功回调（调用方刷新绑定态/团队面板）。 */
  onBound: () => void;
}) {
  const { t } = useTranslation();
  const [teams, setTeams] = useState<OrchestrationTeam[]>([]);
  const [teamId, setTeamId] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // 存 i18n key 而非译文：t 每渲染新引用，进 effect 依赖会死循环（同 WorkflowSwitchModal）。
  const [errorKey, setErrorKey] = useState("");

  useEffect(() => {
    if (!isOpen || !projectId) return;
    let ignore = false;
    setLoading(true);
    setErrorKey("");
    setTeamId("");
    orchestrationService
      .listTeams(workspaceSlug)
      .then((items: OrchestrationTeam[]) => {
        if (!ignore) setTeams(items.filter((tm) => tm.status === "active"));
        return null;
      })
      .catch(() => {
        if (!ignore) setErrorKey("agent_teams_workflows_load_failed");
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [isOpen, workspaceSlug, projectId]);

  const submit = async () => {
    if (!teamId) {
      handleClose();
      return;
    }
    setSubmitting(true);
    setErrorKey("");
    try {
      await orchestrationService.bindProject(workspaceSlug, projectId, { teamId });
      onBound();
      handleClose();
    } catch {
      setErrorKey("agent_teams_bind_team_failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalCore isOpen={isOpen} handleClose={handleClose} position={EModalPosition.TOP} width={EModalWidth.SM}>
      <div className="space-y-5 p-5">
        <h3 className="text-18 font-medium text-secondary">{t("agent_teams_bind_team_title")}</h3>
        {loading ? (
          <div className="py-8 text-center text-13 text-tertiary">{t("agent_teams_inbox_loading")}</div>
        ) : errorKey && teams.length === 0 ? (
          <div className="py-6 text-center text-13 text-danger-primary">{t(errorKey)}</div>
        ) : teams.length === 0 ? (
          <div className="py-2 text-13 text-tertiary">{t("agent_teams_bind_team_empty")}</div>
        ) : (
          <FormSelect
            value={teamId}
            placeholder={t("agent_teams_bind_team_pick")}
            options={teams.map((tm) => ({ id: tm.id, name: tm.name }))}
            onChange={(v) => setTeamId(v)}
          />
        )}
        {errorKey && teams.length > 0 ? <p className="text-11 text-danger-primary">{t(errorKey)}</p> : null}
        {/* 两步语义告知：绑定只定「谁干活」，流程随后配置 */}
        <p className="text-11 text-tertiary">{t("agent_teams_bind_team_semantics")}</p>
        <div className="flex items-center justify-end gap-2 border-t-[0.5px] border-subtle px-5 py-4">
          <PropelButton variant="secondary" size="lg" onClick={handleClose}>
            {t("cancel")}
          </PropelButton>
          <PropelButton
            variant="primary"
            size="lg"
            onClick={() => void submit()}
            loading={submitting}
            disabled={!teamId}
          >
            {t("agent_teams_bind_team_confirm")}
          </PropelButton>
        </div>
      </div>
    </ModalCore>
  );
}
