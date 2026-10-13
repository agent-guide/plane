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
import { cn, renderFormattedDate } from "@plane/utils";
// services
import workflowService, { type TeamWorkflow, type TeamWorkflowVersion } from "@/services/agent-teams/workflow.service";

const publishedVersionsOf = (map: Record<string, TeamWorkflowVersion[]>, flowId: string) =>
  (map[flowId] ?? []).filter((v) => v.status === "published");

export function WorkflowSwitchModal({
  isOpen,
  handleClose,
  teamId,
  currentWorkflowVersionId,
  externalProjectId,
  onSwitched,
}: {
  isOpen: boolean;
  handleClose: () => void;
  teamId: string;
  /** 当前绑定的 workflow_version id（高亮当前 + 默认展开其所属流程）。 */
  currentWorkflowVersionId: string | null;
  /** Plane 项目 UUID（绑定更新走 idKind=external）。 */
  externalProjectId: string;
  onSwitched: () => void;
}) {
  const { t } = useTranslation();
  const [workflows, setWorkflows] = useState<TeamWorkflow[]>([]);
  const [versionsByFlow, setVersionsByFlow] = useState<Record<string, TeamWorkflowVersion[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // 存 i18n key 而非译文：t 每渲染新引用，进 effect 依赖会死循环（闪烁）。
  const [errorKey, setErrorKey] = useState("");

  useEffect(() => {
    if (!isOpen || !teamId) return;
    let ignore = false;
    setLoading(true);
    setErrorKey("");
    (async () => {
      try {
        const flows = await workflowService.listTeamWorkflows(teamId);
        const entries = await Promise.all(
          flows
            .filter((f) => f.status === "published")
            .map(async (f) => [f.id, await workflowService.listTeamWorkflowVersions(teamId, f.id)] as const)
        );
        if (ignore) return;
        setWorkflows(flows.filter((f) => f.status === "published"));
        setVersionsByFlow(Object.fromEntries(entries));
        // 当前流程默认展开
        const currentFlow = flows.find(
          (f) => f.id && publishedVersionsOf(Object.fromEntries(entries), f.id).some((v) => v.id === currentWorkflowVersionId)
        );
        setExpanded(currentFlow?.id ?? flows[0]?.id ?? null);
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
  }, [isOpen, teamId, currentWorkflowVersionId]);



  const submit = async () => {
    if (!selected || selected === currentWorkflowVersionId) {
      handleClose();
      return;
    }
    setSubmitting(true);
    setErrorKey("");
    try {
      await workflowService.updateBindingForExternalProject(externalProjectId, {
        defaultWorkflowVersionId: selected,
      });
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
        <h3 className="text-18 font-medium text-secondary">{t("agent_teams_wf_switch_title")}</h3>
        {loading ? (
          <div className="py-8 text-center text-13 text-tertiary">{t("agent_teams_inbox_loading")}</div>
        ) : errorKey && workflows.length === 0 ? (
          <div className="py-6 text-center text-13 text-danger-primary">{t(errorKey)}</div>
        ) : (
          <div className="space-y-2">
            {workflows.map((flow) => {
              const versions = publishedVersionsOf(versionsByFlow, flow.id).toSorted((a, b) => b.version - a.version);
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
                    {versions[0] ? (
                      <span className="text-12 text-tertiary">v{versions[0].version}</span>
                    ) : null}
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
                            {version.publishedAt ? (renderFormattedDate(version.publishedAt, "yyyy-MM-dd HH:mm") ?? "") : ""}
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
        {/* 切换语义固定告知（§4.5 定案） */}
        <p className="text-11 text-tertiary">{t("agent_teams_wf_switch_semantics")}</p>
        <div className="flex items-center justify-end gap-2 border-t-[0.5px] border-subtle px-5 py-4">
          <PropelButton variant="secondary" size="lg" onClick={handleClose}>
            {t("cancel")}
          </PropelButton>
          <PropelButton
            variant="primary"
            size="lg"
            onClick={() => void submit()}
            loading={submitting}
            disabled={!selected || selected === currentWorkflowVersionId}
          >
            {t("agent_teams_wf_switch_confirm")}
          </PropelButton>
        </div>
      </div>
    </ModalCore>
  );
}
