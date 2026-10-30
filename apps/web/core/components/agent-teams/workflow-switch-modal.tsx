/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — 项目内切换执行流程（设计修订 2026-10-08 阶段 4）：
 * 分组列表（流程→版本），当前流程默认展开、其余收起只显示最新版；选中即
 * 钉住该版本；确认层固定告知切换语义（进行中不受影响，新工作项用新流程）。
 * 全部组件复用 Plane 体系（ModalCore/CustomSelect 不适用——分组展开结构）。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { Button as PropelButton } from "@plane/propel/button";
import { CheckIcon, ChevronDownIcon } from "@plane/propel/icons";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
import { format, parseISO } from "date-fns";
// services
// 数据源切换（阶段 2′）：切换绑定改走编排域（流程归项目；版本=已发布可选）
import {
  orchestrationService,
  type OrchestrationTeam,
  type OrchestrationWorkflow,
  type OrchestrationWorkflowVersion,
} from "@/services/agent-teams/orchestration.service";
import { FormSelect } from "@/components/agent-teams/form-select";

const publishedVersionsOf = (map: Record<string, OrchestrationWorkflowVersion[]>, flowId: string) =>
  (map[flowId] ?? []).filter((v) => v.status === "published");

export function WorkflowSwitchModal({
  isOpen,
  handleClose,
  workspaceSlug,
  projectId,
  currentWorkflowVersionId,
  onSwitched,
}: {
  isOpen: boolean;
  handleClose: () => void;
  workspaceSlug: string;
  projectId: string;
  /** 当前绑定的 workflow_version id；null = 首次绑定模式（需选团队）。 */
  currentWorkflowVersionId: string | null;
  onSwitched: () => void;
}) {
  const { t } = useTranslation();
  // 首次绑定（无当前版本）需同时选团队；已绑定则只换版本
  const isBindMode = currentWorkflowVersionId === null;
  const [teams, setTeams] = useState<OrchestrationTeam[]>([]);
  const [teamId, setTeamId] = useState("");
  const [workflows, setWorkflows] = useState<OrchestrationWorkflow[]>([]);
  const [versionsByFlow, setVersionsByFlow] = useState<Record<string, OrchestrationWorkflowVersion[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // 存 i18n key 而非译文：t 每渲染新引用，进 effect 依赖会死循环（闪烁）。
  const [errorKey, setErrorKey] = useState("");

  useEffect(() => {
    if (!isOpen || !projectId) return;
    let ignore = false;
    setLoading(true);
    setErrorKey("");
    setTeamId("");
    (async () => {
      try {
        if (isBindMode) {
          const teamItems = await orchestrationService.listTeams(workspaceSlug);
          setTeams(teamItems.filter((tm) => tm.status === "active"));
        }
        const flows = await orchestrationService.listWorkflows(workspaceSlug, projectId);
        const entries = await Promise.all(
          flows.map(
            async (f) =>
              [f.id, (await orchestrationService.getWorkflow(workspaceSlug, projectId, f.id)).versions ?? []] as const
          )
        );
        if (ignore) return;
        const versionsMap = Object.fromEntries(entries);
        // 只保留有可绑定版本（已发布）的流程
        const bindableFlows = flows.filter((f) => publishedVersionsOf(versionsMap, f.id).length > 0);
        setWorkflows(bindableFlows);
        setVersionsByFlow(versionsMap);
        // 当前流程默认展开
        const currentFlow = bindableFlows.find(
          (f) => f.id && publishedVersionsOf(versionsMap, f.id).some((v) => v.id === currentWorkflowVersionId)
        );
        setExpanded(currentFlow?.id ?? bindableFlows[0]?.id ?? null);
        setSelected(currentWorkflowVersionId);
      } catch {
        if (!ignore) setErrorKey("agent_teams_workflows_load_failed");
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, workspaceSlug, projectId, isBindMode]);

  const submit = async () => {
    if (!selected || selected === currentWorkflowVersionId) {
      handleClose();
      return;
    }
    setSubmitting(true);
    setErrorKey("");
    try {
      if (isBindMode) {
        if (!teamId) {
          setErrorKey("agent_teams_wf_form_incomplete");
          setSubmitting(false);
          return;
        }
        await orchestrationService.bindProject(workspaceSlug, projectId, {
          teamId,
          workflowVersionId: selected,
        });
      } else {
        await orchestrationService.upgradeBinding(workspaceSlug, projectId, selected);
      }
      onSwitched();
      handleClose();
    } catch (err) {
      const detail = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setErrorKey("agent_teams_wf_switch_failed" + (detail ? "::detail::" + detail : ""));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalCore isOpen={isOpen} handleClose={handleClose} position={EModalPosition.TOP} width={EModalWidth.XXL}>
      <div className="space-y-5 p-5">
        <h3 className="text-18 font-medium text-secondary">
          {t(isBindMode ? "agent_teams_wf_bind_title" : "agent_teams_wf_switch_title")}
        </h3>
        {isBindMode ? (
          <div className="space-y-1">
            <FormSelect
              value={teamId}
              placeholder={t("agent_teams_wf_bind_pick_team")}
              options={teams.map((tm) => ({ id: tm.id, name: tm.name }))}
              onChange={(v) => setTeamId(v)}
            />
          </div>
        ) : null}
        {loading ? (
          <div className="py-8 text-center text-13 text-tertiary">{t("agent_teams_inbox_loading")}</div>
        ) : errorKey && workflows.length === 0 ? (
          <div className="py-6 text-center text-13 text-danger-primary">{t(errorKey)}</div>
        ) : (
          <div className="space-y-2">
            {workflows.map((flow) => {
              const versions = publishedVersionsOf(versionsByFlow, flow.id)
                .slice()
                .toSorted((a: { version: number }, b: { version: number }) => b.version - a.version);
              const isOpenGroup = expanded === flow.id;
              return (
                <div key={flow.id} className="rounded-md border-[0.5px] border-subtle-1 bg-layer-1">
                  {/* 流程头：点击展开/收起（统一可展开，不做两种行为） */}
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left"
                    onClick={() => setExpanded(isOpenGroup ? null : flow.id)}
                  >
                    <ChevronDownIcon
                      className={cn("size-3.5 text-tertiary transition-transform", !isOpenGroup && "-rotate-90")}
                      aria-hidden
                    />
                    <span className="text-13 font-medium text-primary">{flow.name}</span>
                    {versions[0] ? <span className="text-12 text-tertiary">v{versions[0].version}</span> : null}
                    {currentWorkflowVersionId && versions.some((v) => v.id === currentWorkflowVersionId) ? (
                      <span className="ml-auto rounded-full bg-accent-subtle px-2 py-0.5 text-11 text-accent-primary">
                        {t("agent_teams_wf_current")}
                      </span>
                    ) : null}
                  </button>
                  {isOpenGroup ? (
                    <div className="border-t border-subtle">
                      {versions.map((version) => (
                        <button
                          key={version.id}
                          type="button"
                          className="flex w-full items-center gap-2 px-3.5 py-2 pl-9 text-left hover:bg-layer-2-hover"
                          onClick={() => setSelected(version.id)}
                        >
                          <span className="w-4 shrink-0">
                            {selected === version.id ? (
                              <CheckIcon className="size-3.5 text-accent-primary" aria-hidden />
                            ) : null}
                          </span>
                          <span className="text-13 text-primary">v{version.version}</span>
                          {version.id === currentWorkflowVersionId ? (
                            <span className="text-11 text-tertiary">（{t("agent_teams_wf_current")}）</span>
                          ) : null}
                          <span className="ml-auto text-11 text-tertiary">
                            {/* renderFormattedDate 只取日期串前 10 位（时间恒
                                00:00），精确到分钟用 date-fns 直接解析。 */}
                            {version.publishedAt ? format(parseISO(version.publishedAt), "yyyy-MM-dd HH:mm") : ""}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        {errorKey && workflows.length > 0 ? (
          <p className="text-11 text-danger-primary">
            {errorKey.split("::detail::")[0] === errorKey
              ? t(errorKey)
              : `${t(errorKey.split("::detail::")[0])}：${errorKey.split("::detail::")[1]}`}
          </p>
        ) : null}
        {/* 绑定/切换语义固定告知（§4.5 定案） */}
        <p className="text-11 text-tertiary">
          {t(isBindMode ? "agent_teams_wf_bind_semantics" : "agent_teams_wf_switch_semantics")}
        </p>
        <div className="flex items-center justify-end gap-2 border-t-[0.5px] border-subtle px-5 py-4">
          <PropelButton variant="secondary" size="lg" onClick={handleClose}>
            {t("cancel")}
          </PropelButton>
          <PropelButton
            variant="primary"
            size="lg"
            onClick={() => void submit()}
            loading={submitting}
            disabled={!selected || (!isBindMode && selected === currentWorkflowVersionId) || (isBindMode && !teamId)}
          >
            {t(isBindMode ? "agent_teams_wf_bind_confirm" : "agent_teams_wf_switch_confirm")}
          </PropelButton>
        </div>
      </div>
    </ModalCore>
  );
}
