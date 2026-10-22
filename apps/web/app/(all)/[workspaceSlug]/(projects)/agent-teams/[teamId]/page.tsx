/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — team detail (design §12.1: Overview, read-only
 * members, projects, work items). Execution records and artifacts stay on
 * the work-item panel (§12.3) and the admin console — the team page keeps
 * only signal-level counts. All data comes from the Agent Team Runtime API;
 * editing stays in the admin console (§12.6.1).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { useParams } from "react-router";
import { TeamStatusIcon } from "@/components/agent-teams/team-status";
import { useTranslation } from "@plane/i18n";
import { controlStateLabel } from "@/services/agent-teams/state-view";
import { Button as PropelButton } from "@plane/propel/button";
import { EmptyStateDetailed } from "@plane/propel/empty-state";
import { ContentWrapper, ERowVariant, Table } from "@plane/ui";
import type { TTableColumn } from "@plane/ui";
import { calculateTimeAgo } from "@plane/utils";
// icons
import { Archive, ListTodo, Power, Settings, User } from "lucide-react";
// components
import { EmptyRow, Section } from "@/components/agent-teams/section";
import { TeamSettingsModal } from "@/components/agent-teams/team-manage-modals";
import { PageHead } from "@/components/core/page-title";
import Link from "next/link";
// services
import runtimeService, {
  type AgentTeam,
  type AgentTeamActiveTask,
  type AgentTeamMember,
  type AgentTeamProject,
} from "@/services/agent-teams/runtime.service";
import { classifyRuntimeFailure, type RuntimeFailureKind } from "@/services/agent-teams/runtime-errors";
// hooks
import { useWorkspace } from "@/hooks/store/use-workspace";
import { useIntersectionObserver } from "@/hooks/use-intersection-observer";
import type { Route } from "./+types/page";

/* 莫奈清晨色板（与团队列表页同源同值）：起色/雾止色/墨色三元组。
 * 详情页 hero 横幅用起色→雾止色渐变 + 墨色文字层。 */
const TEAM_ACCENTS: Array<[string, string, string]> = [
  ["#a3c6de", "#b7d2e6", "#3a668c"],
  ["#aed8d8", "#bfe4dc", "#3a7a70"],
  ["#b7abe0", "#cac8ec", "#5a4a94"],
  ["#eec3a4", "#f1d4c6", "#96603a"],
  ["#e6cf9c", "#ecdfc4", "#8a7333"],
  ["#aebfd6", "#c4d0e8", "#47598a"],
  ["#e2b1b6", "#ecd2d4", "#964a55"],
  ["#e4bcc9", "#ead8e6", "#8d5a78"],
  ["#b1cf9f", "#c6e0cf", "#4a7a3a"],
  ["#a4d1c5", "#bcdeeb", "#3a6e82"],
  ["#e8c6a2", "#eeded0", "#8a6a42"],
  ["#bcb6d2", "#ced2e8", "#5a5480"],
];
const teamHash = (name: string) => {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return hash % TEAM_ACCENTS.length;
};
const teamAccent = (name: string) => TEAM_ACCENTS[teamHash(name)][0];
const teamAccentDark = (name: string) => TEAM_ACCENTS[teamHash(name)][1];
const teamInk = (name: string) => TEAM_ACCENTS[teamHash(name)][2];

/** 加载失败：Plane 空态组件 + 重试（失败不能只留一句灰字，要有出路）。 */

// 详情骨架（2026-10-22 排版整改）：与真实布局同构——全宽横幅占位 +
// px-6 内容列，避免加载完成瞬间的整体跳动。
const detailSkeleton = (
  <div className="flex flex-col" aria-hidden>
    <div className="h-[160px] w-full animate-pulse bg-layer-2" />
    <div className="flex flex-col gap-10 px-8 pt-6 pb-16">
      <div className="h-4 w-56 animate-pulse rounded bg-layer-2" />
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-4">
          <div className="h-4 w-32 animate-pulse rounded bg-layer-3" />
          <div className="overflow-hidden rounded-lg border border-subtle bg-layer-1">
            {[0, 1].map((j) => (
              <div key={j} className="flex items-center gap-3 px-4 py-3.5">
                <div className="size-5 animate-pulse rounded-full bg-layer-3" />
                <div className="h-3 w-1/4 animate-pulse rounded bg-layer-3" />
                <div className="ml-auto h-3 w-16 animate-pulse rounded bg-layer-2" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  </div>
);

type TTeamDetailData = {
  team: AgentTeam;
  members: AgentTeamMember[];
  activeTasks: AgentTeamActiveTask[];
};

// Projects load incrementally (Plane-native load-more): pages of this size
// append until the backend total is reached.
const PROJECT_PAGE_SIZE = 10;

function WorkspaceAgentTeamDetailPage({ params }: Route.ComponentProps) {
  const { teamId } = params;
  const { t } = useTranslation();
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();

  const { currentWorkspace } = useWorkspace();
  // derived values
  const pageTitle = currentWorkspace?.name ? `${currentWorkspace?.name} - Agent Team` : undefined;

  const [data, setData] = useState<TTeamDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  // 失败原因分类：工作区没接入时重试永远不会成功，不能再给「重试」按钮。
  const [failure, setFailure] = useState<RuntimeFailureKind | null>(null);

  const [projects, setProjects] = useState<AgentTeamProject[]>([]);
  const [projectTotal, setProjectTotal] = useState(0);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsSentinel, setProjectsSentinel] = useState<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);

  // 全员自建（设计 2026-10-19）：管理动作——viewerCanManage 由服务端按
  // principal 填充（创建者或管理员），前端只做可见性。
  const canManage = data?.team.viewerCanManage === true;
  const isAdmin = data?.team.viewerIsAdmin === true;
  const enabledMembers = (data?.members ?? []).filter((m) => m.enabled);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  // 存 i18n key：t 每渲染新引用，不进状态依赖（既往教训）。
  const [actionErrorKey, setActionErrorKey] = useState("");

  const runManageAction = async (action: () => Promise<unknown>) => {
    setActionBusy(true);
    setActionErrorKey("");
    try {
      await action();
      await loadTeam();
    } catch (error) {
      const status = (error as { response?: { data?: { code?: string } } })?.response;
      if (status?.data?.code === "AGENT_TEAM_EMPTY") {
        setActionErrorKey("agent_teams_activate_needs_member");
      } else {
        setActionErrorKey("agent_teams_action_failed");
      }
    } finally {
      setActionBusy(false);
    }
  };

  const loadTeam = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      const [team, members, projectsPage, activeTasks] = await Promise.all([
        runtimeService.getTeam(teamId),
        runtimeService.listTeamMembers(teamId),
        runtimeService.listTeamProjects(teamId, 1, PROJECT_PAGE_SIZE),
        runtimeService.listTeamActiveTasks(teamId),
      ]);
      setData({ team, members, activeTasks });
      setProjects(projectsPage.items);
      setProjectTotal(projectsPage.total);
    } catch (error) {
      setFailure(classifyRuntimeFailure(error));
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  const projectsHasMore = projects.length < projectTotal;

  const loadMoreProjects = useCallback(() => {
    if (projectsLoading || !projectsHasMore) return;
    setProjectsLoading(true);
    const page = Math.floor(projects.length / PROJECT_PAGE_SIZE) + 1;
    runtimeService
      .listTeamProjects(teamId, page, PROJECT_PAGE_SIZE)
      .then((res) => {
        setProjects((prev) => [...prev, ...res.items]);
        setProjectTotal(res.total);
        return res;
      })
      .catch(() => {
        // keep the current pages; the sentinel stays so the user can retry
        // by scrolling again or clicking the load-more row
      })
      .finally(() => setProjectsLoading(false));
  }, [projectsLoading, projectsHasMore, projects.length, teamId]);

  useIntersectionObserver(
    pageRef,
    projectsHasMore && !projectsLoading ? projectsSentinel : null,
    loadMoreProjects,
    "100% 0% 100% 0%"
  );

  useEffect(() => {
    void loadTeam();
  }, [loadTeam]);

  const statusLabel = (key: string) => t(`agent_teams_status_${key}`);

  // 列表统一走 @plane/ui Table（与成员/流程子页同款：表头分隔线 + 左对齐表头）。
  const taskColumns: TTableColumn<AgentTeamActiveTask>[] = [
    {
      key: "work_item",
      content: t("agent_teams_column_work_item"),
      tdRender: (task) => {
        const cardHref =
          task.externalProjectId && task.externalItemId && workspaceSlug
            ? `/${workspaceSlug}/projects/${task.externalProjectId}/issues/${task.externalItemId}`
            : null;
        return cardHref ? (
          <Link href={cardHref} className="block truncate text-primary hover:text-accent-primary hover:underline">
            {task.taskName}
          </Link>
        ) : (
          <span className="block truncate text-primary">{task.taskName}</span>
        );
      },
    },
    {
      key: "status",
      content: t("agent_teams_panel_status"),
      tdRender: (task) => (
        <span
          className={`inline-flex items-center gap-1.5 ${
            task.controlStatus === "waiting_human" ? "text-accent-primary" : "text-secondary"
          }`}
        >
          <span
            className={`size-1.5 rounded-full ${
              task.controlStatus === "waiting_human" ? "bg-accent-primary" : "bg-secondary"
            }`}
            aria-hidden
          />
          {controlStateLabel(task, t)}
        </span>
      ),
    },
    {
      key: "project",
      content: t("agent_teams_column_project"),
      tdRender: (task) =>
        task.projectName ? (
          <span className="block max-w-60 truncate text-secondary">{task.projectName}</span>
        ) : (
          <span className="text-tertiary">—</span>
        ),
    },
    {
      key: "member",
      content: t("agent_teams_panel_member"),
      tdRender: (task) =>
        task.activeMemberName ? (
          <span className="inline-flex items-center gap-1 text-secondary">
            <User className="size-3 text-tertiary" aria-hidden />
            {task.activeMemberName}
          </span>
        ) : (
          <span className="text-tertiary">—</span>
        ),
    },
    {
      key: "updated",
      content: t("agent_teams_column_updated"),
      tdRender: (task) => (
        <span className="text-tertiary">{task.updatedAt ? calculateTimeAgo(task.updatedAt) : "—"}</span>
      ),
    },
  ];

  const projectColumns: TTableColumn<AgentTeamProject>[] = [
    {
      key: "project",
      content: t("agent_teams_column_project"),
      tdRender: (project) => {
        // 路由要 Plane 项目 UUID（externalProjectId），内部 projectId 拼进去必 404；
        // 本地项目无映射 → 无 Plane 页面，退化为纯文本。项目也没有裸根路由
        // （只有 issues/overview/... 子路由），概览页是入口页。
        const href =
          project.externalProjectId && workspaceSlug
            ? `/${workspaceSlug}/projects/${project.externalProjectId}/overview`
            : null;
        return href ? (
          <Link href={href} className="block truncate text-primary hover:text-accent-primary hover:underline">
            {project.projectName}
          </Link>
        ) : (
          <span className="block truncate text-primary">{project.projectName}</span>
        );
      },
    },
    {
      key: "workflow",
      content: t("agent_teams_workflow"),
      tdRender: (project) =>
        project.workflowName ? (
          <span className="text-tertiary">
            {project.workflowName}
            {project.workflowVersion != null ? ` v${project.workflowVersion}` : ""}
          </span>
        ) : (
          <span className="text-tertiary">—</span>
        ),
    },
  ];

  return (
    <>
      <PageHead title={pageTitle} />
      <div className="flex h-full w-full flex-col overflow-hidden">
        {/* 无页级面包屑栏：标题已由 hero 横幅承载（横幅本身即页面标题），
            与成员/流程子页的面包屑导航不同——详情页是落地页而非子页。 */}
        <ContentWrapper variant={ERowVariant.HUGGING}>
          {/* 横幅全出血（设计 10-21）：容器顶/左右 padding 移除，横幅贴
              边铺满；下方区块统一 px-6 保持阅读边距，底部 pb-12 不变。 */}
          {/* 排版节奏（2026-10-22 整改）：横幅全出血贴边，其下所有内容收进
              一条 px-6 pt-8 的内容列，块间距统一 32px（gap-8）——原 gap-10
              与区块 gap-8 混用，节奏断裂。 */}
          <div ref={pageRef} className="flex min-h-0 w-full flex-1 flex-col">
            {loading ? (
              detailSkeleton
            ) : failure || !data ? (
              // 未接入的工作区重试永远不成功——只给说明与指引，不给重试按钮。
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
                    failure === "unavailable" ? "agent_teams_runtime_unavailable_title" : "agent_teams_load_failed"
                  )}
                  description={failure === "unavailable" ? t("agent_teams_runtime_unavailable_hint") : undefined}
                  actions={[
                    { label: t("agent_teams_project_retry"), variant: "secondary", onClick: () => void loadTeam() },
                  ]}
                />
              )
            ) : (
              <>
                {/* Hero（2026-10-22 重排）：内容底部对齐（items-end），但
                 * 标识与文字组包成内部居中组——两者共享一条中轴线（原整体
                 * 底部对齐时文字组比标识高 12px，标识悬浮无对齐）；按钮组
                 * 仍锚在横幅下沿。 */}
                <header className="flex flex-col">
                  <div
                    className="relative flex min-h-[160px] w-full items-end gap-4 px-8 pt-8 pb-6"
                    style={{
                      background: `linear-gradient(160deg, ${teamAccent(data.team.name)}, ${teamAccentDark(data.team.name)})`,
                    }}
                  >
                    {/* 同色墨晕：右下轻染，垫在底部文字区下产生承托感 */}
                    <div
                      className="absolute inset-x-0 bottom-0 h-20"
                      style={{ background: `linear-gradient(to top, ${teamInk(data.team.name)}26, transparent)` }}
                      aria-hidden
                    />
                    {/* 标识+文字组：内部垂直居中，共享中轴线 */}
                    <div className="relative flex min-w-0 flex-grow items-center gap-4">
                      {/* 标识：48px 墨色块，白字 20px */}
                      <span
                        className="font-extrabold relative grid size-12 flex-shrink-0 place-items-center rounded-xl text-[20px] leading-none tracking-[0.02em] text-white"
                        style={{ backgroundColor: teamInk(data.team.name) }}
                      >
                        {data.team.name.slice(0, 1).toUpperCase()}
                      </span>
                      {/* 文字组：行盒压缩为 26+6+16=48px，与标识块同高，
                          居中组内像素级对齐（原 56px 文字组高出标识 4px）。 */}
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                          <h1
                            className="m-0 truncate text-[22px] leading-[26px] font-semibold tracking-tight"
                            style={{ color: teamInk(data.team.name) }}
                          >
                            {data.team.name}
                          </h1>
                          {/* 状态玻璃药丸：语义图标与侧栏团队行共用
                              TeamStatusIcon（活跃=脉搏/草稿=拟稿/归档=归档盒）。 */}
                          <span className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-full bg-white/35 px-2.5 py-[5px] backdrop-blur-[2px]">
                            <TeamStatusIcon
                              status={data.team.status}
                              className="size-3"
                              strokeWidth={2.5}
                              style={{ color: teamInk(data.team.name) }}
                            />
                            <span
                              className="text-[11px] leading-none font-medium tracking-[0.04em]"
                              style={{ color: teamInk(data.team.name) }}
                            >
                              {statusLabel(data.team.status)}
                            </span>
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[13px] leading-4">
                          {data.team.createdByDisplayName ? (
                            <span style={{ color: `${teamInk(data.team.name)}b3` }}>
                              {t("agent_teams_created_by", { name: data.team.createdByDisplayName })}
                            </span>
                          ) : null}
                          {data.team.createdByDisplayName && data.team.objective ? (
                            <span aria-hidden style={{ color: `${teamInk(data.team.name)}59` }}>
                              ·
                            </span>
                          ) : null}
                          {data.team.objective ? (
                            <p className="m-0 line-clamp-1 max-w-xl" style={{ color: `${teamInk(data.team.name)}b3` }}>
                              {data.team.objective}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    {/* 管理操作：横幅垂直居中右侧；非管理者不渲染。 */}
                    {data.team.status !== "archived" && canManage ? (
                      <div className="relative ml-auto flex flex-shrink-0 items-center gap-2">
                        {data.team.status === "draft" ? (
                          <PropelButton
                            variant="primary"
                            size="lg"
                            loading={actionBusy}
                            disabled={enabledMembers.length === 0}
                            title={enabledMembers.length === 0 ? t("agent_teams_activate_needs_member") : undefined}
                            onClick={() =>
                              void runManageAction(() => runtimeService.updateTeam(teamId, { status: "active" }))
                            }
                          >
                            <Power className="size-3.5" aria-hidden />
                            {t("agent_teams_activate")}
                          </PropelButton>
                        ) : null}
                        <PropelButton
                          variant="secondary"
                          size="lg"
                          onClick={() => {
                            setActionErrorKey("");
                            setSettingsOpen(true);
                          }}
                        >
                          <Settings className="size-3.5" aria-hidden />
                          {t("agent_teams_settings_title")}
                        </PropelButton>
                        {isAdmin ? (
                          <PropelButton
                            variant="secondary"
                            size="lg"
                            loading={actionBusy}
                            onClick={() => {
                              if (window.confirm(t("agent_teams_archive_confirm", { name: data.team.name }))) {
                                void runManageAction(() => runtimeService.archiveTeam(teamId));
                              }
                            }}
                          >
                            <Archive className="size-3.5" aria-hidden />
                            {t("agent_teams_archive")}
                          </PropelButton>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  {actionErrorKey ? (
                    <p className="border-danger-primary/30 m-0 mx-8 mt-4 rounded-lg border bg-danger-primary/5 px-3 py-2 text-body-xs-regular text-danger-primary">
                      {t(actionErrorKey)}
                    </p>
                  ) : null}
                </header>

                {/* 内容列：与横幅同一条 32px 左边轨（px-8）；块间距 40px
                    （gap-10）拉开区块层级，底部 pb-16 + 末尾 spacer 双保险
                    保证页面下边距。 */}
                <div className="flex flex-col gap-10 px-8 pt-6 pb-16">
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[13px] text-secondary">
                    <span className="inline-flex items-center gap-1.5">
                      <User className="size-3.5 text-tertiary" aria-hidden />
                      {t("agent_teams_member_count", { count: data.members.length })}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <ListTodo
                        className={`size-3.5 ${data.activeTasks.length > 0 ? "text-accent-primary" : "text-tertiary"}`}
                        aria-hidden
                      />
                      <span className={data.activeTasks.length > 0 ? "font-medium text-accent-primary" : ""}>
                        {t("agent_teams_run_count", { count: data.activeTasks.length })}
                      </span>
                    </span>
                  </div>
                  {/* Active work items — in-flight only; finished/failed history
                      lives in the projects (retry/review on the card, §12.3 panel). */}
                  <Section
                    label={t("agent_teams_work_items_title")}
                    count={data.activeTasks.length}
                    description={t("agent_teams_work_items_description")}
                  >
                    {data.activeTasks.length === 0 ? (
                      <EmptyRow
                        assetKey="work-item"
                        label={t("agent_teams_empty_tasks")}
                        description={t("agent_teams_empty_tasks_hint")}
                      />
                    ) : (
                      <div className="overflow-x-auto">
                        <Table
                          data={data.activeTasks}
                          columns={taskColumns}
                          keyExtractor={(task) => task.taskBindingId}
                          tHeadClassName="border-b border-subtle"
                          tHeadTrClassName="divide-x-0"
                          thClassName="text-left font-medium text-placeholder"
                          tBodyTrClassName="divide-x-0"
                          tdClassName="py-3"
                        />
                      </div>
                    )}
                  </Section>

                  {/* Projects — Plane-native load-more: pages append on scroll
                      (sentinel) or via the fallback row until total is reached. */}
                  <Section label={t("agent_teams_projects_title")} count={projectTotal}>
                    {projects.length === 0 && !projectsLoading ? (
                      <EmptyRow
                        assetKey="project"
                        label={t("agent_teams_projects_empty_title")}
                        description={t("agent_teams_projects_empty_hint")}
                      />
                    ) : (
                      <>
                        <div className="overflow-x-auto">
                          <Table
                            data={projects}
                            columns={projectColumns}
                            keyExtractor={(project) => project.projectId}
                            tHeadClassName="border-b border-subtle"
                            tHeadTrClassName="divide-x-0"
                            thClassName="text-left font-medium text-placeholder"
                            tBodyTrClassName="divide-x-0"
                            tdClassName="py-3"
                          />
                        </div>
                        {projectsLoading ? (
                          <div className="border-b border-subtle px-2.5 py-2 text-center text-13 text-tertiary">
                            {t("agent_teams_inbox_loading")}
                          </div>
                        ) : projectsHasMore ? (
                          // oxlint-disable-next-line jsx-a11y/click-events-have-key-events jsx-a11y/no-static-element-interactions
                          <div
                            ref={setProjectsSentinel}
                            className="cursor-pointer border-b border-subtle px-2.5 py-2 text-center text-13 font-medium text-accent-primary hover:underline"
                            onClick={loadMoreProjects}
                          >
                            {t("load_more")} &darr;
                          </div>
                        ) : null}
                      </>
                    )}
                  </Section>

                  {/* 底部留白锚点：flex 子元素的 padding-bottom 在部分滚动
                      容器里会被裁掉，spacer 保证页面下边距稳定存在。 */}
                  <div className="h-2 shrink-0" aria-hidden />
                </div>
              </>
            )}
          </div>
        </ContentWrapper>
      </div>

      {/* 设置/加成员模态（设计 §4） */}
      {data ? (
        <>
          <TeamSettingsModal
            isOpen={settingsOpen}
            handleClose={() => setSettingsOpen(false)}
            name={data.team.name}
            objective={data.team.objective ?? ""}
            saving={actionBusy}
            errorKey={actionErrorKey}
            onSave={(patch) => {
              void (async () => {
                setActionBusy(true);
                setActionErrorKey("");
                try {
                  await runtimeService.updateTeam(teamId, {
                    name: patch.name || undefined,
                    objective: patch.objective || undefined,
                  });
                  setSettingsOpen(false);
                  await loadTeam();
                } catch (error) {
                  const status = (error as { response?: { data?: { code?: string } } })?.response;
                  if (status?.data?.code === "AGENT_TEAM_NAME_CONFLICT") {
                    setActionErrorKey("agent_teams_create_name_conflict");
                  } else {
                    setActionErrorKey("agent_teams_action_failed");
                  }
                } finally {
                  setActionBusy(false);
                }
              })();
            }}
          />
        </>
      ) : null}
    </>
  );
}

export default observer(WorkspaceAgentTeamDetailPage);
