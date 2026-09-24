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
import { useTranslation } from "@plane/i18n";
import { controlStateLabel } from "@/services/agent-teams/state-view";
import { Breadcrumbs, ContentWrapper, Header } from "@plane/ui";
import { calculateTimeAgo } from "@plane/utils";
// icons
import { Boxes, ListTodo, MessageSquare, User, Users } from "lucide-react";
// components
import { AppHeader } from "@/components/core/app-header";
import { PageHead } from "@/components/core/page-title";
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { useAgentTeamsLinks } from "@/components/agent-teams/helper";
import Link from "next/link";
// services
import runtimeService, {
  type AgentTeam,
  type AgentTeamActiveTask,
  type AgentTeamMember,
  type AgentTeamProject,
} from "@/services/agent-teams/runtime.service";
// hooks
import { useWorkspace } from "@/hooks/store/use-workspace";
import { useIntersectionObserver } from "@/hooks/use-intersection-observer";
import type { Route } from "./+types/page";

/** Quiet section label — the content below is the protagonist. */
function Section({
  label,
  count,
  description,
  icon,
  children,
}: {
  label: string;
  count?: number;
  description?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="inline-flex items-center gap-1.5 text-caption-sm-medium text-secondary">
          {icon}
          {label}
        </span>
        {count !== undefined && <span className="text-caption-sm-regular text-tertiary">{count}</span>}
        {description && (
          <span className="text-caption-sm-regular text-tertiary">— {description}</span>
        )}
      </div>
      {children}
    </section>
  );
}

function RowList({ children }: { children: React.ReactNode }) {
  return <div className="overflow-hidden rounded-lg border border-subtle bg-layer-1">{children}</div>;
}

function EmptyRow({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-subtle px-4 py-8 text-center text-body-sm-regular text-tertiary">
      {label}
    </div>
  );
}

function StatTile({
  icon,
  value,
  highlight,
}: {
  icon: React.ReactNode;
  value: string;
  highlight?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-lg bg-layer-2 px-3 py-2 text-body-sm-medium ${
        highlight ? "text-accent-primary" : "text-primary"
      }`}
    >
      <span className={highlight ? "" : "text-tertiary"}>{icon}</span>
      {value}
    </span>
  );
}

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
  const { agentTeamsPath, memberChatPath } = useAgentTeamsLinks();
  // derived values
  const pageTitle = currentWorkspace?.name ? `${currentWorkspace?.name} - Agent Team` : undefined;

  const [data, setData] = useState<TTeamDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const [projects, setProjects] = useState<AgentTeamProject[]>([]);
  const [projectTotal, setProjectTotal] = useState(0);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsSentinel, setProjectsSentinel] = useState<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);

  const loadTeam = useCallback(async () => {
    setLoading(true);
    setFailed(false);
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
    } catch {
      setFailed(true);
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
  const emptyLabel = t("agent_teams_empty_section");

  const placeholder = (label: string) => (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-subtle px-6 py-14 text-center">
      <Users className="size-7 text-tertiary" aria-hidden />
      <p className="m-0 text-body-sm-regular text-tertiary">{label}</p>
    </div>
  );

  return (
    <>
      <PageHead title={pageTitle} />
      <div className="flex h-full w-full flex-col overflow-hidden">
        <AppHeader
          header={
            <Header>
              <Header.LeftItem>
                <Breadcrumbs>
                  <Breadcrumbs.Item
                    component={
                      <BreadcrumbLink
                        label={t("agent_teams_breadcrumb")}
                        href={agentTeamsPath}
                        icon={<Users className="size-4 text-tertiary" />}
                      />
                    }
                  />
                  <Breadcrumbs.Item component={<BreadcrumbLink label={data?.team.name ?? teamId} disableTooltip />} />
                </Breadcrumbs>
              </Header.LeftItem>
            </Header>
          }
        />
        <ContentWrapper>
          <div ref={pageRef} className="flex w-full flex-col gap-10 px-4 pt-6 pb-12">
            {loading ? (
              placeholder(t("agent_teams_inbox_loading"))
            ) : failed || !data ? (
              placeholder(t("agent_teams_load_failed"))
            ) : (
              <>
                {/* Hero — identity zone: the only large type on the page,
                    everything below stays caption/body-sm so it reads first. */}
                <header className="flex flex-col gap-4">
                  <div className="flex items-center gap-3.5">
                    <span className="flex size-10 flex-shrink-0 items-center justify-center rounded-xl bg-accent-subtle text-body-lg-medium text-accent-primary">
                      {data.team.name.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <h1 className="m-0 truncate text-h4-medium text-primary">{data.team.name}</h1>
                        <span className="inline-flex flex-shrink-0 items-center gap-1.5 text-caption-sm-regular text-tertiary">
                          <span
                            className={`size-1.5 rounded-full ${
                              data.team.status === "active" ? "bg-accent-primary" : "bg-tertiary"
                            }`}
                            aria-hidden
                          />
                          {statusLabel(data.team.status)}
                        </span>
                      </div>
                      {data.team.objective && (
                        <p className="m-0 max-w-3xl text-body-sm-regular text-tertiary">{data.team.objective}</p>
                      )}
                    </div>
                  </div>
                  {/* Signal tiles — the only tinted blocks, deliberately */}
                  <div className="flex flex-wrap items-center gap-2.5">
                    <StatTile
                      icon={<User className="size-3.5" aria-hidden />}
                      value={t("agent_teams_member_count", { count: data.members.length })}
                    />
                    <StatTile
                      icon={<ListTodo className="size-3.5" aria-hidden />}
                      value={t("agent_teams_run_count", { count: data.activeTasks.length })}
                      highlight={data.activeTasks.length > 0}
                    />
                  </div>
                </header>

                <div className="flex flex-col gap-8">
                  {/* Human & Agent Members (read-only) */}
                  <Section
                    label={t("agent_teams_members_title")}
                    count={data.members.length}
                    icon={<User className="size-3.5" aria-hidden />}
                  >
                    {data.members.length === 0 ? (
                      <EmptyRow label={emptyLabel} />
                    ) : (
                      <RowList>
                        {data.members.map((member, index) => (
                          <div
                            key={member.id}
                            className={`flex items-center gap-2.5 px-4 py-3 ${index > 0 ? "border-t border-subtle" : ""}`}
                          >
                            <span
                              className={`size-1.5 flex-shrink-0 rounded-full ${
                                member.kind === "agent" ? "bg-accent-primary" : "bg-secondary"
                              }`}
                              title={
                                member.kind === "agent"
                                  ? t("agent_teams_kind_agent")
                                  : t("agent_teams_kind_human")
                              }
                              aria-hidden
                            />
                            {member.planeUserId ? (
                              /* Task-mode entry (member page = profile's assigned view, Plane native) */
                              <Link
                                href={`/${currentWorkspace?.slug ?? ""}/profile/${member.planeUserId}`}
                                className="text-body-sm-medium text-primary hover:text-accent-primary hover:underline"
                              >
                                {member.displayName}
                              </Link>
                            ) : (
                              <span className="text-body-sm-medium text-primary">{member.displayName}</span>
                            )}
                            <span className="flex-shrink-0 rounded bg-layer-3 px-1.5 py-0.5 text-caption-sm-regular text-secondary">
                              {member.role}
                            </span>
                            {member.capabilities && member.capabilities.length > 0 && (
                              <span className="ml-auto max-w-60 truncate text-caption-sm-regular text-tertiary">
                                {member.capabilities.join(" · ")}
                              </span>
                            )}
                            {member.kind === "agent" && member.expertId ? (
                              <Link
                                href={memberChatPath(member.expertId, member.displayName)}
                                className={`flex flex-shrink-0 items-center rounded p-1 text-secondary hover:bg-layer-2-hover hover:text-accent-primary ${
                                  !(member.capabilities && member.capabilities.length > 0) ? "ml-auto" : ""
                                }`}
                                title={t("agent_teams_chat_with", { name: member.displayName })}
                              >
                                <MessageSquare className="size-3.5" aria-hidden />
                              </Link>
                            ) : null}
                          </div>
                        ))}
                      </RowList>
                    )}
                  </Section>

                  {/* Active work items — in-flight only; finished/failed history
                      lives in the projects (retry/review on the card, §12.3 panel). */}
                  <Section
                    label={t("agent_teams_work_items_title")}
                    count={data.activeTasks.length}
                    description={t("agent_teams_work_items_description")}
                    icon={<ListTodo className="size-3.5" aria-hidden />}
                  >
                    {data.activeTasks.length === 0 ? (
                      <EmptyRow label={t("agent_teams_empty_tasks")} />
                    ) : (
                      <RowList>
                        {data.activeTasks.map((task, index) => {
                          const cardHref =
                            task.externalProjectId && task.externalItemId && workspaceSlug
                              ? `/${workspaceSlug}/projects/${task.externalProjectId}/issues/${task.externalItemId}`
                              : null;
                          return (
                            <div
                              key={task.taskBindingId}
                              className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 ${
                                index > 0 ? "border-t border-subtle" : ""
                              }`}
                            >
                              {cardHref ? (
                                <a
                                  href={cardHref}
                                  className="truncate text-body-sm-medium text-primary transition-colors hover:text-accent-primary hover:underline"
                                >
                                  {task.taskName}
                                </a>
                              ) : (
                                <span className="truncate text-body-sm-medium text-primary">{task.taskName}</span>
                              )}
                              <span
                                className={`ml-auto inline-flex flex-shrink-0 items-center gap-1.5 text-caption-sm-regular ${
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
                              <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 text-caption-sm-regular text-tertiary sm:w-auto">
                                {task.projectName && <span className="truncate">{task.projectName}</span>}
                                {task.activeMemberName && (
                                  <span className="inline-flex items-center gap-1">
                                    <User className="size-3" aria-hidden />
                                    {task.activeMemberName}
                                  </span>
                                )}
                                {task.updatedAt && <span>{calculateTimeAgo(task.updatedAt)}</span>}
                              </div>
                            </div>
                          );
                        })}
                      </RowList>
                    )}
                  </Section>

                  {/* Projects — Plane-native load-more: pages append on scroll
                      (sentinel) or via the fallback row until total is reached. */}
                  <Section
                    label={t("agent_teams_projects_title")}
                    count={projectTotal}
                    icon={<Boxes className="size-3.5" aria-hidden />}
                  >
                    {projects.length === 0 && !projectsLoading ? (
                      <EmptyRow label={emptyLabel} />
                    ) : (
                      <RowList>
                        {projects.map((project, index) => (
                          <div
                            key={project.projectId}
                            className={`flex items-center gap-3 px-4 py-3 ${index > 0 ? "border-t border-subtle" : ""}`}
                          >
                            <Link
                              href={`/${workspaceSlug}/projects/${project.projectId}`}
                              className="truncate text-body-sm-medium text-primary transition-colors hover:text-accent-primary hover:underline"
                            >
                              {project.projectName}
                            </Link>
                            {project.workflowName && (
                              <span className="ml-auto flex-shrink-0 truncate text-caption-sm-regular text-tertiary">
                                {project.workflowName}
                                {project.workflowVersion != null ? ` v${project.workflowVersion}` : ""}
                              </span>
                            )}
                          </div>
                        ))}
                        {projectsLoading ? (
                          <div className="border-t border-subtle px-4 py-3 text-center text-caption-sm-regular text-tertiary">
                            {t("agent_teams_inbox_loading")}
                          </div>
                        ) : projectsHasMore ? (
                          // oxlint-disable-next-line jsx_a11y/click-events-have-key-events jsx_a11y/no-static-element-interactions
                          <div
                            ref={setProjectsSentinel}
                            className="cursor-pointer border-t border-subtle px-4 py-3 text-center text-caption-sm-medium text-accent-primary hover:underline"
                            onClick={loadMoreProjects}
                          >
                            {t("common.load_more")} &darr;
                          </div>
                        ) : null}
                      </RowList>
                    )}
                  </Section>
                </div>
              </>
            )}
          </div>
        </ContentWrapper>
      </div>
    </>
  );
}

export default observer(WorkspaceAgentTeamDetailPage);
