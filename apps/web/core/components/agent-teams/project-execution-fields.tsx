/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — 建项目表单的执行团队/流程联动选择（设计修订
 * 2026-10-08 阶段 4：建项目必选团队与流程，保存即绑定）。字段值不进
 * react-hook-form（runtime 概念不属于 Plane 的 TProject 表单模型），由本
 * 组件自持并通过 ref 回传提交处。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { Button as PropelButton } from "@plane/propel/button";
import { CustomSelect } from "@plane/ui";
import { CheckIcon } from "@plane/propel/icons";
import { ChevronsUpDown } from "lucide-react";
// services
import runtimeService, { type AgentTeam } from "@/services/agent-teams/runtime.service";
import workflowService, { type TeamWorkflow } from "@/services/agent-teams/workflow.service";

export type ExecutionSelection = { teamId: string; workflowVersionId: string } | null;

/** 团队选项：无已发布流程的团队置灰（设计定案：不放行未绑定形态）。 */
type TeamOption = AgentTeam & { bindable: boolean };

export function ProjectExecutionFields({
  value,
  onChange,
}: {
  value: ExecutionSelection;
  onChange: (value: ExecutionSelection) => void;
}) {
  const { t } = useTranslation();
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [workflows, setWorkflows] = useState<TeamWorkflow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  // 表单挂载即拉团队清单（建项目是低频重操作，一次拉取可接受）
  const loadTeams = () => {
    setFailed(false);
    runtimeService
      .listTeams()
      .then(async (items) => {
        // 逐团队探测可绑定流程（published）——只探测 active 团队，量小；
        // 串行探测是刻意行为（并发打 runtime 对小租户是浪费）。
        const active = items.filter((tm) => tm.status === "active");
        const withFlag: TeamOption[] = [];
        for (const tm of active) {
          // oxlint-disable-next-line no-await-in-loop
          const flows = await workflowService.listBindableWorkflows(tm.id).catch(() => [] as TeamWorkflow[]);
          withFlag.push({ ...tm, bindable: flows.length > 0 });
        }
        setTeams(withFlag);
        setLoaded(true);
        return null;
      })
      .catch(() => {
        setFailed(true);
        return null;
      });
  };
  useEffect(loadTeams, []);

  const selectedTeam = teams.find((tm) => tm.id === value?.teamId);
  const selectedFlow = workflows.find((w) => w.currentVersionId === value?.workflowVersionId);

  // 选中团队后拉其流程并预选第一条（团队默认=首条已发布，设计定案）
  useEffect(() => {
    if (!value?.teamId) {
      setWorkflows([]);
      return;
    }
    let ignore = false;
    workflowService
      .listBindableWorkflows(value.teamId)
      .then((flows) => {
        if (ignore) return null;
        setWorkflows(flows);
        const keep = flows.find((w) => w.currentVersionId === value.workflowVersionId);
        if (!keep && flows[0]?.currentVersionId) {
          onChange({ teamId: value.teamId, workflowVersionId: flows[0].currentVersionId });
        }
        return null;
      })
      .catch(() => {
        if (!ignore) setWorkflows([]);
        return null;
      });
    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value?.teamId]);

  if (failed) {
    return (
      <div className="flex w-full items-center justify-between rounded-md border-[0.5px] border-subtle-1 bg-layer-2 px-3 py-2.5">
        <span className="text-12 text-tertiary">{t("agent_teams_exec_load_failed")}</span>
        <PropelButton variant="secondary" size="lg" onClick={loadTeams}>
          {t("agent_teams_exec_retry")}
        </PropelButton>
      </div>
    );
  }

  return (
    <>
      <div className="h-7 flex-shrink-0">
        <CustomSelect
          value={value?.teamId ?? ""}
          onChange={(v: string) => {
            if (v) onChange({ teamId: v, workflowVersionId: "" });
          }}
          label={
            <div className="flex h-full items-center gap-1">
              {selectedTeam ? (
                selectedTeam.name
              ) : (
                <span className="flex-grow truncate text-left">{t("agent_teams_exec_pick_team")} *</span>
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
            <CustomSelect.Option
              key={team.id}
              value={team.bindable ? team.id : ""}
              className={team.bindable ? "" : "cursor-not-allowed"}
            >
              <div className="flex items-start gap-2">
                <div className="-mt-0.5">
                  <p className={team.bindable ? "" : "text-tertiary"}>{team.name}</p>
                  {!team.bindable ? (
                    <p className="text-11 text-placeholder">{t("agent_teams_exec_team_no_flows")}</p>
                  ) : null}
                </div>
              </div>
            </CustomSelect.Option>
          ))}
        </CustomSelect>
      </div>
      {value?.teamId ? (
        <div className="h-7 flex-shrink-0">
          <CustomSelect
            value={value?.workflowVersionId ?? ""}
            onChange={(v: string) => v && value?.teamId && onChange({ teamId: value.teamId, workflowVersionId: v })}
            disabled={!value?.teamId}
            label={
              <div className="flex h-full items-center gap-1">
                {selectedFlow ? (
                  <>
                    {selectedFlow.name} v{selectedFlow.currentVersion}
                  </>
                ) : (
                  <span className="flex-grow truncate text-left">{t("agent_teams_exec_pick_flow")} *</span>
                )}
              </div>
            }
            placement="bottom-start"
            className="h-full"
            buttonClassName="h-full"
            noChevron
          >
            {workflows.map((flow) => (
              <CustomSelect.Option key={flow.currentVersionId} value={flow.currentVersionId ?? ""}>
                <div className="flex items-center gap-2">
                  {value?.workflowVersionId === flow.currentVersionId ? (
                    <CheckIcon className="size-3.5 text-accent-primary" aria-hidden />
                  ) : (
                    <ChevronsUpDown className="size-3.5 opacity-0" aria-hidden />
                  )}
                  <span className="truncate">
                    {flow.name} v{flow.currentVersion}
                  </span>
                </div>
              </CustomSelect.Option>
            ))}
          </CustomSelect>
        </div>
      ) : null}
    </>
  );
}
