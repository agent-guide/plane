/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — Project Overview page (design §12.2, Linear-style).
 * The project's landing view: what's in the project (progress + recent work
 * items from the native Plane API), who runs it (the §12.2 responsible-team
 * panel as a section, not the whole page), and what happened lately (a
 * human-readable activity stream over recent runs). Unbound projects keep a
 * useful overview — only the team section shows its guided empty state.
 * Deep links: team page, work item, admin run archive; the full board/list
 * stays one click away on the native /issues tab (never rebuilt here).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import Link from "next/link";
// plane imports
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { EIconSize } from "@plane/constants";
import { StateGroupIcon } from "@plane/propel/icons";
import type { TStateGroups } from "@plane/types";
import { controlStateLabel } from "@/services/agent-teams/state-view";
import { EIssuesStoreType } from "@plane/types";
import { ContentWrapper, ERowVariant, Table } from "@plane/ui";
import type { TTableColumn } from "@plane/ui";
import { Logo } from "@plane/propel/emoji-icon-picker";
import { Lock, Plus, RefreshCw, Workflow } from "lucide-react";
// components
import { EmptyRow, Section } from "@/components/agent-teams/section";
import { CoverImage } from "@/components/common/cover-image";
import { WorkflowSwitchModal } from "@/components/agent-teams/workflow-switch-modal";
import { PageHead } from "@/components/core/page-title";
import { useAgentTeamsLinks, teamInk } from "@/components/agent-teams/helper";
// services
import { IssueService } from "@/services/issue/issue.service";
import { useProjectRuntimeOverview } from "@/services/agent-teams/runtime-swr";
// hooks
import { useCommandPalette } from "@/hooks/store/use-command-palette";
import { useProject } from "@/hooks/store/use-project";
import type { TIssue } from "@plane/types";

const RECENT_ITEMS = 8;

/* 状态组配色：取 Propel StateGroupIcon 的权威色值（STATE_GROUP_COLORS，
 * 未从包导出，此处按源同值声明）——Plane 全站状态图标同色，勿用
 * @plane/constants 的 STATE_GROUPS 旧色（cancelled 红/backlog 浅灰与
 * 站内实际显示不符，且浅灰在 layer-2 轨道上不可见）。 */
const STATE_BAR_COLORS = {
  completed: "#46A758",
  started: "#F59E0B",
  cancelled: "#9AA4BC",
  todo: "#60646C",
} as const;

// 就地补运行时标记后的最近工作项行类型（列表复用 @plane/ui Table）。
type TRecentIssue = TIssue & {
  isTeamExecuted?: boolean;
  controlStatus?: string | null;
  stateName?: string | null;
  stateColor?: string | null;
};
const issueService = new IssueService();

const RUN_RESULT_PAST: Record<string, string> = {
  success: "run_completed",
  failed: "run_failed",
  cancelled: "run_cancelled",
  running: "run_running",
  queued: "run_queued",
  created: "run_queued",
};

function relativeTime(value?: string | null, locale = "en") {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const diffMinutes = Math.round((Date.now() - date.getTime()) / 60000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (diffMinutes < 1) return rtf.format(0, "minute");
  if (diffMinutes < 60) return rtf.format(-diffMinutes, "minute");
  const hours = Math.round(diffMinutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  return rtf.format(-Math.round(hours / 24), "day");
}

function ProjectOverviewPage() {
  const { workspaceSlug, projectId } = useParams<{ workspaceSlug: string; projectId: string }>();
  const { t, currentLocale: locale } = useTranslation();
  const { currentProjectDetails: project } = useProject();
  const commandPalette = useCommandPalette();
  const { agentTeamDetailPath } = useAgentTeamsLinks();

  // SWR-backed (runtime-swr): the runtime aggregate polls only while the
  // project has something running; native issues refresh on focus/mutate.
  const { data: overview, error: runtimeError, isLoading: runtimeLoading } = useProjectRuntimeOverview(projectId);
  const [issues, setIssues] = useState<TIssue[] | null>(null);
  // PROJECT_NOT_FOUND（external 寻址无 work_management 项目映射）= 项目
  // 尚未接入治理：与「未绑定团队」同态——显示绑定引导，而非加载失败。
  const runtimeUnmapped =
    !overview &&
    (runtimeError as { response?: { data?: { code?: string } } } | null)?.response?.data?.code === "PROJECT_NOT_FOUND";
  const runtimeFailed = !!runtimeError && !overview && !runtimeUnmapped;
  const [switchOpen, setSwitchOpen] = useState(false);
  const { mutate: mutateRuntimeOverview } = useProjectRuntimeOverview(projectId);

  // 团队区块已并入横幅；未绑定/未映射/加载失败不再占页面区块，改为
  // 数据就绪后弹一次提示——文案按用户视角组织：问题是什么 + 该怎么办。
  const runtimeNoticeFired = useRef(false);
  useEffect(() => {
    if (runtimeNoticeFired.current || runtimeLoading) return;
    if (runtimeFailed) {
      runtimeNoticeFired.current = true;
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("agent_teams_project_load_failed"),
        message: t("agent_teams_project_failed_toast_hint"),
      });
    } else if (!overview) {
      runtimeNoticeFired.current = true;
      setToast({
        type: TOAST_TYPE.INFO,
        title: t("agent_teams_project_unbound_toast_title"),
        message: t("agent_teams_project_unbound_toast_hint"),
      });
    }
    // ref 不进依赖（既往惯例）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeLoading, runtimeFailed, overview, t]);

  const loadIssues = useCallback(() => {
    issueService
      .getIssues(workspaceSlug, projectId, { per_page: "100", order_by: "-updated_at" })
      .then((res) => {
        // TIssuesResponse wraps a `results` payload that is either a flat
        // array (no group_by) or a grouped map keyed by state id. Flatten
        // both shapes and re-sort by recency — the overview only needs a
        // flat recent slice + counts.
        const payload = res?.results ?? [];
        const flat: TIssue[] = Array.isArray(payload)
          ? (payload as TIssue[])
          : Object.values(payload).flatMap((group) =>
              group && Array.isArray(group.results) ? (group.results as TIssue[]) : []
            );
        flat.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
        setIssues(flat);
        return null;
      })
      .catch(() => {
        setIssues((prev) => prev);
        return null;
      });
  }, [projectId, workspaceSlug]);

  useEffect(() => {
    setIssues(null);
    loadIssues();
  }, [loadIssues]);

  // 新建工作项后刷新最近列表：创建弹窗关闭（成功或取消）即重拉，
  // 否则空态里「新建工作项」保存成功列表不更新（09-23 验收发现）。
  const createModalOpen = commandPalette.isCreateIssueModalOpen;
  useEffect(() => {
    if (!createModalOpen) return;
    // open→closed 的 cleanup 触发一次刷新（取消时多拉一次无害）。
    return () => {
      loadIssues();
    };
  }, [createModalOpen, loadIssues]);

  const binding = overview?.binding ?? null;
  const loading = runtimeLoading && !overview && !issues;

  // Native progress: work items grouped by state group.
  const progress = useMemo(() => {
    const groups: Record<string, number> = { backlog: 0, unstarted: 0, started: 0, completed: 0, cancelled: 0 };
    for (const issue of issues ?? []) {
      const group = issue.state__group ?? "backlog";
      groups[group] = (groups[group] ?? 0) + 1;
    }
    const total = issues?.length ?? 0;
    const done = groups.completed;
    return { groups, total, done, percent: total ? Math.round((done / total) * 100) : 0 };
  }, [issues]);

  // Recent work items with the runtime marker for team-executed ones.
  const controlledExternalIds = useMemo(
    () => new Set((overview?.tasks ?? []).map((task) => task.externalItemId).filter(Boolean)),
    [overview]
  );
  const recentIssues = useMemo(
    () =>
      (issues ?? []).slice(0, RECENT_ITEMS).map((issue) => {
        // 就地补运行时标记（避免逐行展开拷贝）：控制态显示走状态视图。
        const row = issue as TRecentIssue;
        row.isTeamExecuted = controlledExternalIds.has(issue.id);
        const task = overview?.tasks.find((item) => item.externalItemId === issue.id);
        row.controlStatus = task?.controlStatus ?? null;
        row.stateName = task?.stateName ?? null;
        row.stateColor = task?.stateColor ?? null;
        return row;
      }),
    [issues, controlledExternalIds, overview]
  );

  // 列定义与团队详情同款：@plane/ui Table（表头分隔线 + 左对齐表头）。
  const recentIssueColumns: TTableColumn<TRecentIssue>[] = [
    {
      key: "work_item",
      content: t("agent_teams_column_work_item"),
      tdRender: (issue) => (
        <span className="inline-flex min-w-0 items-center gap-2">
          {/* 直达 browse 独立详情页（标识-序号寻址）；identifier 缺失时回退
              issues 列表 + peek 深链。 */}
          <Link
            href={
              project?.identifier
                ? `/${workspaceSlug}/browse/${project.identifier}-${issue.sequence_id}`
                : `/${workspaceSlug}/projects/${projectId}/issues?issueId=${issue.id}`
            }
            className="block truncate text-primary hover:text-accent-primary hover:underline"
          >
            {issue.name}
          </Link>
          {issue.isTeamExecuted && issue.controlStatus && issue.stateName && (
            /* 复用工作项列表同款状态渲染（StateGroupIcon + 名称）：
                图标用原生状态组 + 运行时状态色，与 /issues 列表同观感。 */
            <span
              title={t("agent_teams_project_team_executed")}
              className="inline-flex flex-shrink-0 items-center gap-1.5 text-caption-sm-medium text-secondary"
            >
              <StateGroupIcon
                stateGroup={(issue.state__group ?? "backlog") as TStateGroups}
                color={issue.stateColor ?? undefined}
                size={EIconSize.SM}
              />
              {controlStateLabel({ ...issue, controlStatus: issue.controlStatus }, t)}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "updated",
      content: t("agent_teams_column_updated"),
      tdRender: (issue) => <span className="text-tertiary">{relativeTime(issue.updated_at, locale)}</span>,
    },
  ];

  const activityColumns: TTableColumn<NonNullable<typeof overview>["recentRuns"][number]>[] = [
    {
      key: "work_item",
      content: t("agent_teams_column_work_item"),
      tdRender: (run) => (
        <Link
          href={`/${workspaceSlug}/projects/${projectId}/issues?issueId=${run.taskId}`}
          className="block truncate text-primary hover:text-accent-primary hover:underline"
        >
          {run.taskTitle}
        </Link>
      ),
    },
    {
      key: "result",
      content: t("agent_teams_panel_status"),
      tdRender: (run) => <span className="text-secondary">{t(RUN_RESULT_PAST[run.status] ?? "run_unknown")}</span>,
    },
    {
      key: "updated",
      content: t("agent_teams_column_updated"),
      tdRender: (run) => <span className="text-tertiary">{relativeTime(run.finishedAt ?? run.startedAt, locale)}</span>,
    },
    // 执行详情外链列已移除（2026-10-22）：admin 端 runs 路由不存在，
    // 链接恒 404；需要时以正确路由恢复。
  ];

  const pageTitle = project?.name ? `${project.name} - ${t("agent_teams_project_title")}` : undefined;

  return (
    <>
      <PageHead title={pageTitle} />
      <div className="flex h-full w-full flex-col overflow-hidden">
        {/* 无页级面包屑栏（2026-10-22，与团队详情对齐）：封面横幅即页头，
            项目导航由左侧项目栏承载，面包屑在此冗余。 */}
        <ContentWrapper variant={ERowVariant.HUGGING}>
          {/* 排版与团队详情同体系（2026-10-22 整改）：px-8 左边轨、块间距
              40px、底部 pb-16 + spacer；区块用 Section 静寂头（15px 半粗 +
              计数 chip），内容用 Plane 原生行，不套灰卡。 */}
          {/* 骨架与真实布局同构（全出血横幅条 + px-8 内容列），避免加载
              完成瞬间的整体跳动（团队详情同款手法）。 */}
          {loading ? (
            <div className="flex flex-col" aria-hidden>
              <div className="h-[160px] w-full animate-pulse bg-layer-2" />
              <div className="flex flex-col gap-10 px-8 pt-6 pb-16">
                <div className="h-4 w-64 animate-pulse rounded bg-layer-2" />
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex flex-col gap-4">
                    <div className="h-4 w-32 animate-pulse rounded bg-layer-3" />
                    <div className="flex flex-col gap-3 border-t border-subtle pt-3">
                      <div className="h-3 w-2/3 animate-pulse rounded bg-layer-3" />
                      <div className="h-3 w-1/2 animate-pulse rounded bg-layer-2" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex w-full flex-col">
              {/* ① 页头横幅（与团队详情同构，2026-10-22）：ContentWrapper 用
                  HUGGING（px-0），横幅全出血贴边铺满；其下区块收进 px-8 内容
                  列——与团队详情页同一骨架。 */}
              <header className="flex flex-col">
                <div className="relative flex min-h-[160px] w-full items-end gap-4 px-8 pt-8 pb-6">
                  {/* 封面走通用 CoverImage：上载图经 getFileURL 签名、无封面回
                      退默认封面（与项目卡同源）；其上再加底部叠层保白字可读。 */}
                  <CoverImage
                    src={project?.cover_image_url}
                    showDefaultWhenEmpty
                    alt=""
                    className="absolute inset-0 size-full"
                  />
                  {/* 底部叠层：任意封面下都保证白字可读（与项目卡同手法）。 */}
                  <div
                    className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/25 to-transparent"
                    aria-hidden
                  />
                  {/* 标识+文字组：内部垂直居中，共享中轴线（同团队详情）。 */}
                  <div className="relative flex min-w-0 flex-grow items-center gap-4">
                    <span className="font-extrabold relative grid size-12 flex-shrink-0 place-items-center rounded-xl bg-white/15 text-[20px] leading-none tracking-[0.02em] text-white backdrop-blur-[6px]">
                      {project ? <Logo logo={project.logo_props} size={24} /> : null}
                    </span>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <h1 className="m-0 truncate text-[22px] leading-[26px] font-semibold tracking-tight text-white">
                        {project?.name ?? projectId}
                      </h1>
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[13px] leading-4 text-white/80">
                        {project?.identifier ? <span className="font-medium">{project.identifier}</span> : null}
                        {typeof project?.project_lead === "object" && project?.project_lead ? (
                          <>
                            <span aria-hidden>·</span>
                            <span>
                              {t("project_settings.members.project_lead")}:{" "}
                              {project.project_lead.display_name ??
                                `${project.project_lead.first_name} ${project.project_lead.last_name}`.trim()}
                            </span>
                          </>
                        ) : null}
                        {project?.members?.length ? (
                          <>
                            <span aria-hidden>·</span>
                            <span>{t("agent_teams_member_count", { count: project.members.length })}</span>
                          </>
                        ) : null}
                        {project?.description ? (
                          <>
                            <span aria-hidden>·</span>
                            <p className="m-0 line-clamp-1 max-w-xl">{project.description}</p>
                          </>
                        ) : null}
                      </div>
                    </div>
                    {project?.network === 0 ? (
                      <Lock className="relative ml-auto size-3.5 flex-shrink-0 text-white/70" aria-hidden />
                    ) : null}
                  </div>
                  {/* 负责团队：横幅只留一枚徽章——团队专属色字母牌 + 团队名 +
                      等待计数（运行 meta 在横幅下方 meta 带）。字母牌沿用团队
                      莫奈色系（helper 共享），徽章继承团队视觉身份。 */}
                  {binding && !runtimeFailed ? (
                    <div className="relative ml-auto flex max-w-[40%] flex-shrink-0 items-center gap-2">
                      <Link
                        href={agentTeamDetailPath(binding.teamId)}
                        className="group inline-flex min-w-0 items-center gap-2 rounded-full bg-white/20 py-1 pr-3.5 pl-1.5 text-[13px] font-medium text-white backdrop-blur-[4px] transition-colors hover:bg-white/30"
                      >
                        <span
                          className="font-extrabold grid size-6 flex-shrink-0 place-items-center rounded-full text-[12px] leading-none text-white"
                          style={{ backgroundColor: teamInk(binding.teamName) }}
                        >
                          {binding.teamName.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="truncate">{binding.teamName}</span>
                      </Link>
                      {overview && overview.counts.waitingHuman > 0 ? (
                        <span className="flex-shrink-0 rounded-full bg-white/25 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur-[2px]">
                          {t("agent_teams_project_waiting_badge", { count: overview.counts.waitingHuman })}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </header>
              <div className="flex flex-col gap-10 px-8 pt-6 pb-16">
                {/* 页头 meta 带（一条整体行）：状态统计 + 细线 + 流程组紧邻
                    排列（原 justify-between 两端布局把两组甩到行首行尾，中间
                    大片空白显得散）。 */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  {/* issues 就绪即渲染状态统计文案（含 0 工作项的空项目显示
                    全 0）；仅加载中/失败（null）时隐藏。2026-10-22 定案：
                    暂不展示进度条（视觉效果不理想），仅保留文案统计，
                    后续按需求再补充。 */}
                  {issues ? (
                    <div className="flex flex-wrap items-center">
                      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] leading-4 text-tertiary">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className="size-1.5 rounded-full"
                            style={{ backgroundColor: STATE_BAR_COLORS.completed }}
                            aria-hidden
                          />
                          {t("agent_teams_progress_done", { done: progress.done, total: progress.total })}
                          <span className="font-medium text-secondary">{progress.percent}%</span>
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className="size-1.5 rounded-full"
                            style={{ backgroundColor: STATE_BAR_COLORS.started }}
                            aria-hidden
                          />
                          {t("agent_teams_progress_started", { count: progress.groups.started })}
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className="size-1.5 rounded-full"
                            style={{ backgroundColor: STATE_BAR_COLORS.todo }}
                            aria-hidden
                          />
                          {t("agent_teams_progress_backlog", {
                            count: progress.groups.backlog + progress.groups.unstarted,
                          })}
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className="size-1.5 rounded-full"
                            style={{ backgroundColor: STATE_BAR_COLORS.cancelled }}
                            aria-hidden
                          />
                          {t("agent_teams_progress_cancelled", { count: progress.groups.cancelled })}
                        </span>
                      </div>
                    </div>
                  ) : null}
                  {binding && !runtimeFailed ? (
                    /* 流程三件套（名称/版本/切换）装进一枚胶囊：同底同高，
                      整组靠右、与统计行垂直居中；切换按钮嵌在胶囊尾端，
                      版本 chip 底色加深一档与胶囊区分。 */
                    <div className="ml-auto inline-flex h-8 flex-shrink-0 items-center gap-1.5 self-center rounded-full bg-layer-2 pr-1 pl-2.5">
                      <Workflow className="size-3.5 flex-shrink-0 text-tertiary" aria-hidden />
                      <span className="max-w-40 truncate text-[13px] font-medium text-secondary">
                        {binding.workflowName ?? "-"}
                      </span>
                      {binding.workflowVersion != null ? (
                        <span className="font-mono flex-shrink-0 rounded-full bg-layer-3 px-1.5 text-[11px] leading-5 font-medium text-secondary">
                          v{binding.workflowVersion}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="inline-flex h-6 flex-shrink-0 items-center gap-1 rounded-full px-2 text-[12px] font-medium text-accent-primary transition-colors hover:bg-accent-subtle"
                        onClick={() => setSwitchOpen(true)}
                      >
                        <RefreshCw className="size-3" aria-hidden />
                        {t("agent_teams_wf_switch")}
                      </button>
                    </div>
                  ) : null}
                </div>

                {/* ③ 最近工作项（原生数据，就地补运行时标记；列表复用 @plane/ui Table） */}
                <Section label={t("agent_teams_project_recent_items")} count={progress.total}>
                  {recentIssues.length > 0 ? (
                    <div className="overflow-x-auto">
                      <Table
                        data={recentIssues}
                        columns={recentIssueColumns}
                        keyExtractor={(issue) => issue.id}
                        tHeadClassName="border-b border-subtle"
                        tHeadTrClassName="divide-x-0"
                        thClassName="text-left font-medium text-placeholder"
                        tBodyTrClassName="divide-x-0"
                        tdClassName="py-3"
                      />
                    </div>
                  ) : (
                    <EmptyRow
                      assetKey="work-item"
                      label={t("agent_teams_project_no_items")}
                      action={
                        <button
                          type="button"
                          onClick={() =>
                            commandPalette.toggleCreateIssueModal(true, EIssuesStoreType.PROJECT, [projectId])
                          }
                          className="inline-flex items-center gap-1.5 rounded-md bg-accent-primary px-3 py-1.5 text-[13px] font-medium text-on-color hover:bg-accent-primary-hover"
                        >
                          <Plus className="size-3.5" aria-hidden />
                          {t("agent_teams_project_new_item")}
                        </button>
                      }
                    />
                  )}
                </Section>

                {/* ④ 运行动态——人话句子，不是 run id；列表复用 @plane/ui Table */}
                {binding && overview && overview.recentRuns.length > 0 && (
                  <Section label={t("agent_teams_project_activity")} count={overview.recentRuns.length}>
                    <div className="overflow-x-auto">
                      <Table
                        data={overview.recentRuns}
                        columns={activityColumns}
                        keyExtractor={(run) => run.runId}
                        tHeadClassName="border-b border-subtle"
                        tHeadTrClassName="divide-x-0"
                        thClassName="text-left font-medium text-placeholder"
                        tBodyTrClassName="divide-x-0"
                        tdClassName="py-3"
                      />
                    </div>
                  </Section>
                )}

                {/* 底部留白锚点（同团队详情） */}
                <div className="h-2 shrink-0" aria-hidden />
              </div>
            </div>
          )}

          <WorkflowSwitchModal
            isOpen={switchOpen}
            handleClose={() => setSwitchOpen(false)}
            teamId={binding?.teamId ?? ""}
            currentWorkflowVersionId={binding?.workflowVersionId ?? null}
            externalProjectId={projectId}
            onSwitched={() => void mutateRuntimeOverview()}
          />
        </ContentWrapper>
      </div>
    </>
  );
}

export default observer(ProjectOverviewPage);
