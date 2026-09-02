/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — team detail (design §12.1 first batch: Overview,
 * read-only members, projects, active tasks, run & artifact summaries).
 * All data comes from the Agent Team Runtime API; editing stays in the
 * admin console (§12.6.1).
 */
import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Breadcrumbs, ContentWrapper, Header } from "@plane/ui";
// icons
import { Bot, User, Users } from "lucide-react";
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
  type AgentTeamArtifactSummary,
  type AgentTeamMember,
  type AgentTeamProject,
  type AgentTeamRunSummary,
} from "@/services/agent-teams/runtime.service";
// hooks
import { useWorkspace } from "@/hooks/store/use-workspace";
import type { Route } from "./+types/page";

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h4 className="flex items-center gap-2 text-16 font-medium text-primary">
        {title}
        {count !== undefined && <span className="text-caption-sm-regular text-tertiary">{count}</span>}
      </h4>
      {children}
    </section>
  );
}

function EmptyRow({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-subtle px-4 py-6 text-center text-body-sm-regular text-tertiary">
      {label}
    </div>
  );
}

type TTeamDetailData = {
  team: AgentTeam;
  members: AgentTeamMember[];
  projects: AgentTeamProject[];
  activeTasks: AgentTeamActiveTask[];
  runs: AgentTeamRunSummary[];
  artifacts: AgentTeamArtifactSummary[];
};

function WorkspaceAgentTeamDetailPage({ params }: Route.ComponentProps) {
  const { teamId } = params;
  const { t } = useTranslation();
  const { currentWorkspace } = useWorkspace();
  const { agentTeamsPath } = useAgentTeamsLinks();
  // derived values
  const pageTitle = currentWorkspace?.name ? `${currentWorkspace?.name} - Agent Team` : undefined;

  const [data, setData] = useState<TTeamDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const loadTeam = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const [team, members, projects, activeTasks, runs, artifacts] = await Promise.all([
        runtimeService.getTeam(teamId),
        runtimeService.listTeamMembers(teamId),
        runtimeService.listTeamProjects(teamId),
        runtimeService.listTeamActiveTasks(teamId),
        runtimeService.listTeamRuns(teamId),
        runtimeService.listTeamArtifacts(teamId),
      ]);
      setData({ team, members, projects, activeTasks, runs, artifacts });
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    void loadTeam();
  }, [loadTeam]);

  const statusLabel = (key: string) => t(`agent_teams_status_${key}`);
  const emptyLabel = t("agent_teams_empty_section");

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
                        label="Agent Teams"
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
          <div className="flex w-full flex-col gap-8 px-4 pt-4 pb-10">
            {loading ? (
              <div className="rounded-lg border border-dashed border-subtle p-10 text-center text-body-sm-regular text-tertiary">
                {t("agent_teams_inbox_loading")}
              </div>
            ) : failed || !data ? (
              <div className="rounded-lg border border-dashed border-subtle p-10 text-center text-body-sm-regular text-tertiary">
                {t("agent_teams_load_failed")}
              </div>
            ) : (
              <>
                {/* Overview */}
                <Section title={t("agent_teams_overview")}>
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-subtle bg-layer-1 px-4 py-4">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-body-sm-medium text-primary">{data.team.name}</span>
                        <span
                          className={`inline-flex items-center rounded px-1.5 py-0.5 text-caption-sm-medium ${
                            data.team.status === "active"
                              ? "bg-accent-subtle text-accent-primary"
                              : "bg-layer-3 text-secondary"
                          }`}
                        >
                          {statusLabel(data.team.status)}
                        </span>
                      </div>
                      {data.team.objective && (
                        <span className="text-caption-sm-regular text-tertiary">{data.team.objective}</span>
                      )}
                    </div>
                    <div className="ml-auto flex flex-wrap items-center gap-4 text-caption-sm-regular text-tertiary">
                      <span>{t("agent_teams_member_count", { count: data.members.length })}</span>
                      <span>{t("agent_teams_task_count", { count: data.activeTasks.length })}</span>
                      <span>
                        {t("agent_teams_run_count", { count: data.runs.filter((r) => r.status === "running").length })}
                      </span>
                      <span>{t("agent_teams_artifact_count", { count: data.artifacts.length })}</span>
                    </div>
                  </div>
                </Section>

                {/* Human & Agent Members (read-only) */}
                <Section title={t("agent_teams_members_title")} count={data.members.length}>
                  {data.members.length === 0 ? (
                    <EmptyRow label={emptyLabel} />
                  ) : (
                    <div className="overflow-hidden rounded-lg border border-subtle bg-layer-1">
                      {data.members.map((member, index) => (
                        <div
                          key={member.id}
                          className={`flex items-center gap-3 px-4 py-3 ${index > 0 ? "border-t border-subtle" : ""}`}
                        >
                          <span
                            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-caption-sm-medium ${
                              member.kind === "agent"
                                ? "bg-danger-subtle text-danger-primary"
                                : "bg-layer-3 text-secondary"
                            }`}
                          >
                            {member.kind === "agent" ? (
                              <Bot className="size-3" aria-hidden />
                            ) : (
                              <User className="size-3" aria-hidden />
                            )}
                            {member.kind === "agent" ? t("agent_teams_kind_agent") : t("agent_teams_kind_human")}
                          </span>
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
                          <span className="text-caption-sm-regular text-tertiary">{member.role}</span>
                          {member.capabilities && member.capabilities.length > 0 && (
                            <span className="ml-auto truncate text-caption-sm-regular text-tertiary">
                              {member.capabilities.join(" · ")}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </Section>

                {/* Projects */}
                <Section title={t("agent_teams_projects_title")} count={data.projects.length}>
                  {data.projects.length === 0 ? (
                    <EmptyRow label={emptyLabel} />
                  ) : (
                    <div className="overflow-hidden rounded-lg border border-subtle bg-layer-1">
                      {data.projects.map((project, index) => (
                        <div
                          key={project.projectId}
                          className={`flex items-center gap-3 px-4 py-3 ${index > 0 ? "border-t border-subtle" : ""}`}
                        >
                          <span className="truncate text-body-sm-medium text-primary">{project.projectName}</span>
                          {project.workflowName && (
                            <span className="text-caption-sm-regular text-tertiary">
                              {project.workflowName}
                              {project.workflowVersion != null ? ` v${project.workflowVersion}` : ""}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </Section>

                {/* Active Tasks */}
                <Section title={t("agent_teams_active_tasks_title")} count={data.activeTasks.length}>
                  {data.activeTasks.length === 0 ? (
                    <EmptyRow label={emptyLabel} />
                  ) : (
                    <div className="overflow-hidden rounded-lg border border-subtle bg-layer-1">
                      {data.activeTasks.map((task, index) => (
                        <div
                          key={task.taskBindingId}
                          className={`flex items-center gap-3 px-4 py-3 ${index > 0 ? "border-t border-subtle" : ""}`}
                        >
                          <span className="text-body-sm-medium text-primary">{task.taskName}</span>
                          {task.activeMemberName && (
                            <span className="text-caption-sm-regular text-tertiary">{task.activeMemberName}</span>
                          )}
                          <span
                            className={`ml-auto inline-flex items-center rounded px-1.5 py-0.5 text-caption-sm-medium ${
                              task.controlStatus === "waiting_human"
                                ? "bg-accent-subtle text-accent-primary"
                                : task.controlStatus === "failed"
                                  ? "bg-danger-subtle text-danger-primary"
                                  : "bg-layer-3 text-secondary"
                            }`}
                          >
                            {statusLabel(task.controlStatus)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </Section>

                {/* Runs summary */}
                <Section title={t("agent_teams_runs_title")} count={data.runs.length}>
                  {data.runs.length === 0 ? (
                    <EmptyRow label={emptyLabel} />
                  ) : (
                    <div className="overflow-hidden rounded-lg border border-subtle bg-layer-1">
                      {data.runs.map((run, index) => (
                        <div
                          key={run.id}
                          className={`flex items-center gap-3 px-4 py-3 ${index > 0 ? "border-t border-subtle" : ""}`}
                        >
                          <span className="text-body-sm-medium text-primary">{run.agentName}</span>
                          <span className="truncate text-caption-sm-regular text-tertiary">{run.nodeKey ?? "-"}</span>
                          <span
                            className={`ml-auto inline-flex items-center rounded px-1.5 py-0.5 text-caption-sm-medium ${
                              run.status === "failed" || run.status === "unknown"
                                ? "bg-danger-subtle text-danger-primary"
                                : run.status === "running"
                                  ? "bg-accent-subtle text-accent-primary"
                                  : "bg-layer-3 text-secondary"
                            }`}
                          >
                            {statusLabel(run.status)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </Section>

                {/* Artifacts summary */}
                <Section title={t("agent_teams_artifacts_title")} count={data.artifacts.length}>
                  {data.artifacts.length === 0 ? (
                    <EmptyRow label={emptyLabel} />
                  ) : (
                    <div className="overflow-hidden rounded-lg border border-subtle bg-layer-1">
                      {data.artifacts.map((artifact, index) => (
                        <div
                          key={artifact.id}
                          className={`flex items-center gap-3 px-4 py-3 ${index > 0 ? "border-t border-subtle" : ""}`}
                        >
                          <span className="text-body-sm-medium text-primary">{artifact.name}</span>
                          <span className="text-caption-sm-regular text-tertiary">
                            {artifact.artifactKey} · v{artifact.version}
                          </span>
                          {artifact.producedBy && (
                            <span className="ml-auto text-caption-sm-regular text-tertiary">{artifact.producedBy}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </Section>
              </>
            )}
          </div>
        </ContentWrapper>
      </div>
    </>
  );
}

export default observer(WorkspaceAgentTeamDetailPage);
