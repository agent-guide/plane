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
import { EIssuesStoreType } from "@plane/types";
import { Breadcrumbs, ContentWrapper, Header } from "@plane/ui";
import { Bot, ExternalLink, ListTodo, Plus, RefreshCw, Users } from "lucide-react";
// components
import { AppHeader } from "@/components/core/app-header";
import { PageHead } from "@/components/core/page-title";
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { useAgentTeamsLinks } from "@/components/agent-teams/helper";
// services
import { IssueService } from "@/services/issue/issue.service";
import runtimeService, { type ProjectRuntimeOverview } from "@/services/agent-teams/runtime.service";
// hooks
import { useCommandPalette } from "@/hooks/store/use-command-palette";
import { useProject } from "@/hooks/store/use-project";
import { useWorkspace } from "@/hooks/store/use-workspace";
import type { TIssue } from "@plane/types";

const POLL_SECONDS = 10;
const RECENT_ITEMS = 8;
const issueService = new IssueService();

const CONTROL_STATUS_STYLES: Record<string, string> = {
  queued: "bg-layer-3 text-secondary",
  running: "bg-accent-subtle text-accent-primary",
  waiting_human: "bg-accent-subtle text-accent-primary",
  blocked: "bg-warning-subtle text-warning-primary",
  failed: "bg-danger-subtle text-danger-primary",
  completed: "bg-success-subtle text-success-primary",
  cancelled: "bg-layer-3 text-tertiary",
};

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
  const { currentWorkspace } = useWorkspace();
  const { currentProjectDetails: project } = useProject();
  const { toggleCreateIssueModal } = useCommandPalette();
  const { agentTeamDetailPath } = useAgentTeamsLinks();

  const [overview, setOverview] = useState<ProjectRuntimeOverview | null>(null);
  const [issues, setIssues] = useState<TIssue[] | null>(null);
  const [runtimeFailed, setRuntimeFailed] = useState(false);
  // Manual retry in-flight flag: without it a retry against a still-down
  // backend leaves the error state visually unchanged — the click looks dead.
  const [retrying, setRetrying] = useState(false);
  const hasLoadedOnce = useRef(false);

  const load = useCallback(async () => {
    // Runtime aggregate and native issues load independently: the page stays
    // useful when only one of them is available. The runtime promise is
    // returned so the manual-retry button can show its in-flight state.
    const runtimeLoad = runtimeService
      .getProjectRuntimeOverview(projectId)
      .then((next) => {
        setOverview(next);
        setRuntimeFailed(false);
      })
      .catch(() => setRuntimeFailed(true));
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
      })
      .catch(() => setIssues((prev) => prev));
    if (!hasLoadedOnce.current) {
      hasLoadedOnce.current = true;
    }
    return runtimeLoad;
  }, [projectId, workspaceSlug]);

  useEffect(() => {
    hasLoadedOnce.current = false;
    setIssues(null);
    void load();
    const timer = window.setInterval(() => void load(), POLL_SECONDS * 1000);
    return () => window.clearInterval(timer);
  }, [load]);

  const consoleBaseUrl = import.meta.env.VITE_RUNTIME_CONSOLE_BASE_URL as string | undefined;
  const binding = overview?.binding ?? null;
  const loading = !hasLoadedOnce.current;
  const statusLabel = (key: string) => t(`agent_teams_status_${key}`);

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
      (issues ?? []).slice(0, RECENT_ITEMS).map((issue) => ({
        ...issue,
        isTeamExecuted: controlledExternalIds.has(issue.id),
        controlStatus: overview?.tasks.find((task) => task.externalItemId === issue.id)?.controlStatus ?? null,
      })),
    [issues, controlledExternalIds, overview]
  );

  const pageTitle = project?.name ? `${project.name} - ${t("agent_teams_project_title")}` : undefined;

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
                      <BreadcrumbLink href={`/${workspaceSlug}`} label={currentWorkspace?.name ?? "Workspace"} />
                    }
                  />
                  <Breadcrumbs.Item
                    component={
                      <BreadcrumbLink
                        href={`/${workspaceSlug}/projects/${projectId}`}
                        label={project?.name ?? projectId}
                      />
                    }
                  />
                  <Breadcrumbs.Item component={<span>{t("agent_teams_project_title")}</span>} />
                </Breadcrumbs>
              </Header.LeftItem>
            </Header>
          }
        />
        <ContentWrapper>
          {loading ? (
            <div className="m-4 grid max-w-5xl gap-5">
              <div className="h-28 animate-pulse rounded-xl bg-layer-2" />
              <div className="h-36 animate-pulse rounded-xl bg-layer-2" />
              <div className="h-56 animate-pulse rounded-xl bg-layer-2" />
            </div>
          ) : (
            <div className="m-4 grid max-w-5xl gap-5">
              {/* ① Project summary + progress (native data, Linear-style) */}
              <section className="rounded-xl border border-subtle bg-surface-1 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-body-lg-medium truncate text-primary">{project?.name ?? projectId}</h2>
                    {project?.description && (
                      <p className="mt-1 line-clamp-2 max-w-2xl text-body-sm-regular text-tertiary">
                        {project?.description}
                      </p>
                    )}
                  </div>
                  <Link
                    href={`/${workspaceSlug}/projects/${projectId}/issues`}
                    className="flex items-center gap-1.5 rounded-md border-subtle bg-layer-2 px-3 py-1.5 text-caption-sm-medium text-secondary hover:bg-layer-3"
                  >
                    <ListTodo className="size-3.5" aria-hidden />
                    {t("agent_teams_project_all_items")}
                  </Link>
                </div>
                {issues ? (
                  <div className="mt-4">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-layer-3">
                      <div
                        className="h-full rounded-full bg-success-primary transition-all"
                        style={{ width: `${progress.percent}%` }}
                      />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-caption-sm-regular text-tertiary">
                      <span>{t("agent_teams_progress_done", { done: progress.done, total: progress.total })}</span>
                      <span>{t("agent_teams_progress_started", { count: progress.groups.started })}</span>
                      <span>
                        {t("agent_teams_progress_backlog", {
                          count: progress.groups.backlog + progress.groups.unstarted,
                        })}
                      </span>
                    </div>
                  </div>
                ) : null}
              </section>

              {/* ② Responsible team (the §12.2 panel as a section) */}
              <section className="rounded-xl border border-subtle bg-surface-1 p-5">
                <h3 className="mb-3 text-body-xs-medium text-secondary">{t("agent_teams_project_team_section")}</h3>
                {runtimeFailed ? (
                  <div className="grid place-items-center gap-2 py-4">
                    <p className="text-body-sm-regular text-tertiary">{t("agent_teams_project_load_failed")}</p>
                    <button
                      type="button"
                      disabled={retrying}
                      onClick={() => {
                        setRetrying(true);
                        void load().finally(() => setRetrying(false));
                      }}
                      className="flex items-center gap-1.5 rounded-md border-subtle bg-layer-2 px-3 py-1.5 text-caption-sm-medium text-secondary hover:bg-layer-3 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <RefreshCw className={`size-3.5 ${retrying ? "animate-spin" : ""}`} aria-hidden />
                      {retrying ? t("agent_teams_project_retrying") : t("agent_teams_project_retry")}
                    </button>
                  </div>
                ) : binding ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <Users className="size-4 text-accent-primary" aria-hidden />
                      <Link
                        href={agentTeamDetailPath(binding.teamId)}
                        className="hover:text-secondary-hover text-body-md-medium text-secondary"
                      >
                        {binding.teamName}
                      </Link>
                      {overview && overview.counts.waitingHuman > 0 && (
                        <span className="rounded bg-accent-subtle px-1.5 py-0.5 text-caption-sm-medium text-accent-primary">
                          {t("agent_teams_project_waiting_badge", { count: overview.counts.waitingHuman })}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-body-sm-regular text-tertiary">
                      <span>
                        {t("agent_teams_project_workflow")}: {binding.workflowName ?? "-"}
                        {binding.workflowVersion != null ? ` v${binding.workflowVersion}` : ""}
                      </span>
                      <span>
                        {t("agent_teams_project_count_agents")}: {overview?.counts.runningAgents ?? 0}
                      </span>
                      <span>
                        {t("agent_teams_project_count_active")}: {overview?.counts.activeTasks ?? 0}
                      </span>
                    </div>
                  </>
                ) : (
                  /* Guided empty state scoped to the team section only. */
                  <div className="grid place-items-center gap-2 py-6">
                    <Bot className="size-6 text-tertiary" aria-hidden />
                    <p className="max-w-md text-center text-body-sm-regular text-tertiary">
                      {t("agent_teams_project_unbound_hint")}
                    </p>
                    {consoleBaseUrl && (
                      <a
                        href={`${consoleBaseUrl}/admin/agent-teams`}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 flex items-center gap-1.5 rounded-md bg-accent-primary px-3 py-1.5 text-caption-sm-medium text-on-color hover:bg-accent-primary-hover"
                      >
                        {t("agent_teams_project_bind_cta")}
                        <ExternalLink className="size-3" aria-hidden />
                      </a>
                    )}
                  </div>
                )}
              </section>

              {/* ③ Recent work items (native data, runtime-marked) */}
              <section className="rounded-xl border border-subtle bg-surface-1">
                <h3 className="border-b border-subtle px-5 py-3 text-body-xs-medium text-secondary">
                  {t("agent_teams_project_recent_items")}
                </h3>
                {recentIssues.length > 0 ? (
                  <div className="divide-y divide-subtle">
                    {recentIssues.map((issue) => (
                      <div key={issue.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                        <Link
                          href={`/${workspaceSlug}/projects/${projectId}/issues?issueId=${issue.id}`}
                          className="hover:text-secondary-hover text-body-sm-medium text-secondary"
                        >
                          {issue.name}
                        </Link>
                        {issue.isTeamExecuted && (
                          <span
                            title={t("agent_teams_project_team_executed")}
                            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-caption-sm-medium ${CONTROL_STATUS_STYLES[issue.controlStatus ?? "queued"] ?? "bg-layer-3 text-secondary"}`}
                          >
                            <Bot className="size-3" aria-hidden />
                            {issue.controlStatus ? statusLabel(issue.controlStatus) : ""}
                          </span>
                        )}
                        <span className="ml-auto text-caption-sm-regular text-tertiary">
                          {relativeTime(issue.updated_at, locale)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3 px-5 py-8">
                    <p className="text-body-sm-regular text-tertiary">{t("agent_teams_project_no_items")}</p>
                    <button
                      type="button"
                      onClick={() => toggleCreateIssueModal(true, EIssuesStoreType.PROJECT, [projectId])}
                      className="flex items-center gap-1.5 rounded-md bg-accent-primary px-3 py-1.5 text-caption-sm-medium text-on-color hover:bg-accent-primary-hover"
                    >
                      <Plus className="size-3.5" aria-hidden />
                      {t("agent_teams_project_new_item")}
                    </button>
                  </div>
                )}
              </section>

              {/* ④ Activity stream over recent runs — human sentences, not run ids */}
              {binding && overview && overview.recentRuns.length > 0 && (
                <section className="rounded-xl border border-subtle bg-surface-1">
                  <h3 className="border-b border-subtle px-5 py-3 text-body-xs-medium text-secondary">
                    {t("agent_teams_project_activity")}
                  </h3>
                  <div className="divide-y divide-subtle">
                    {overview.recentRuns.map((run) => (
                      <div key={run.runId} className="flex flex-wrap items-center gap-2 px-5 py-3">
                        <Link
                          href={`/${workspaceSlug}/projects/${projectId}/issues?issueId=${run.taskId}`}
                          className="hover:text-secondary-hover text-body-sm-medium text-secondary"
                        >
                          {run.taskTitle}
                        </Link>
                        <span className="text-body-sm-regular text-tertiary">
                          {t(RUN_RESULT_PAST[run.status] ?? "run_unknown")}
                        </span>
                        <span className="ml-auto text-caption-sm-regular text-tertiary">
                          {relativeTime(run.finishedAt ?? run.startedAt, locale)}
                        </span>
                        {consoleBaseUrl && (
                          <a
                            href={`${consoleBaseUrl}/admin/runs/${run.runId}`}
                            target="_blank"
                            rel="noreferrer"
                            title={t("agent_teams_project_run_detail")}
                            className="hover:text-secondary-hover text-secondary"
                          >
                            <ExternalLink className="size-3" aria-hidden />
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </ContentWrapper>
      </div>
    </>
  );
}

export default observer(ProjectOverviewPage);
