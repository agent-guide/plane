/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — 建项目表单的执行团队选择（2026-11-03 复活，两步绑定
 * 形态：只选团队，流程进项目后再配置）。交互沿 2026-10-13 阶段 4 定案：与
 * 「网络」等原生属性控件同形态（无框 CustomSelect、h-7、bottom-start、
 * noChevron），在 ProjectAttributes 行内并排——不另起带标签的表单块。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { CustomSelect } from "@plane/ui";
// services
import { orchestrationService, type OrchestrationTeam } from "@/services/agent-teams/orchestration.service";

export function ProjectExecutionTeamField({
  workspaceSlug,
  value,
  onChange,
}: {
  workspaceSlug: string;
  value: string;
  onChange: (teamId: string) => void;
}) {
  const { t } = useTranslation();
  const [teams, setTeams] = useState<OrchestrationTeam[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  // 表单挂载即拉团队清单（建项目是低频重操作，一次拉取可接受）
  const loadTeams = () => {
    setFailed(false);
    orchestrationService
      .listTeams(workspaceSlug)
      .then((items: OrchestrationTeam[]) => {
        setTeams(items.filter((tm) => tm.status === "active"));
        setLoaded(true);
        return null;
      })
      .catch(() => {
        setFailed(true);
        return null;
      });
  };
  useEffect(loadTeams, [workspaceSlug]);

  const selectedTeam = teams.find((tm) => tm.id === value);

  if (failed) {
    return (
      <div className="flex h-7 flex-shrink-0 items-center gap-2">
        <span className="text-12 text-tertiary">{t("agent_teams_exec_load_failed")}</span>
        <button type="button" className="text-12 text-accent-primary" onClick={loadTeams}>
          {t("agent_teams_exec_retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="h-7 flex-shrink-0">
      <CustomSelect
        value={value}
        onChange={(v: string) => {
          if (v) onChange(v);
        }}
        label={
          <div className="flex h-full items-center gap-1">
            {selectedTeam ? (
              selectedTeam.name
            ) : (
              <span className="flex-grow truncate text-left text-placeholder">{t("agent_teams_exec_pick_team")} *</span>
            )}
          </div>
        }
        placement="bottom-start"
        className="h-full"
        buttonClassName="h-full"
        noChevron
      >
        {loaded && teams.length === 0 ? (
          <CustomSelect.Option key="__empty" value="">
            <span className="text-12 text-tertiary">{t("agent_teams_exec_no_teams")}</span>
          </CustomSelect.Option>
        ) : null}
        {teams.map((team) => (
          <CustomSelect.Option key={team.id} value={team.id}>
            <div className="flex items-start gap-2">
              <div className="-mt-0.5">
                <p>{team.name}</p>
                {team.objective ? (
                  <p className="line-clamp-1 max-w-60 text-11 text-placeholder">{team.objective}</p>
                ) : null}
              </div>
            </div>
          </CustomSelect.Option>
        ))}
      </CustomSelect>
    </div>
  );
}
