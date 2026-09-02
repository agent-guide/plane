/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — team list (design §12.1).
 * Read-only summary view backed by the Agent Team Runtime API; member and
 * policy management lives in the admin console (§12.6.1).
 */
import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react";
import { useRouter } from "next/navigation";
// plane imports
import { Button } from "@plane/propel/button";
import { useTranslation } from "@plane/i18n";
import { Breadcrumbs, ContentWrapper, Header } from "@plane/ui";
// icons
import { ChevronRight, Users } from "lucide-react";
// components
import { AppHeader } from "@/components/core/app-header";
import { PageHead } from "@/components/core/page-title";
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { useAgentTeamsLinks } from "@/components/agent-teams/helper";
// services
import runtimeService, { type AgentTeam } from "@/services/agent-teams/runtime.service";
// hooks
import { useWorkspace } from "@/hooks/store/use-workspace";

function WorkspaceAgentTeamsPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const { currentWorkspace } = useWorkspace();
  const { approvalInboxPath, agentTeamDetailPath } = useAgentTeamsLinks();
  // derived values
  const pageTitle = currentWorkspace?.name ? `${currentWorkspace?.name} - Agent Teams` : undefined;

  const [teams, setTeams] = useState<AgentTeam[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const loadTeams = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setTeams(await runtimeService.listTeams());
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTeams();
  }, [loadTeams]);

  const statusBadge = (status: AgentTeam["status"]) => (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-caption-sm-medium ${
        status === "active" ? "bg-accent-subtle text-accent-primary" : "bg-layer-3 text-secondary"
      }`}
    >
      {t(`agent_teams_status_${status}`)}
    </span>
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
                        label="Agent Teams"
                        disableTooltip
                        icon={<Users className="size-4 text-tertiary" />}
                      />
                    }
                  />
                </Breadcrumbs>
              </Header.LeftItem>
              <Header.RightItem>
                {/* Approval Inbox entry (design §12.6.4) */}
                <Button variant="secondary" size="lg" onClick={() => router.push(approvalInboxPath)}>
                  {t("agent_teams_inbox_title")}
                </Button>
              </Header.RightItem>
            </Header>
          }
        />
        <ContentWrapper>
          <div className="flex w-full flex-col gap-4 px-4 pt-4 pb-10">
            <p className="max-w-2xl text-body-xs-regular text-tertiary">{t("agent_teams_page_subtitle")}</p>

            <div className="flex flex-col gap-2">
              {loading ? (
                <div className="rounded-lg border border-dashed border-subtle p-10 text-center text-body-sm-regular text-tertiary">
                  {t("agent_teams_inbox_loading")}
                </div>
              ) : failed ? (
                <div className="rounded-lg border border-dashed border-subtle p-10 text-center text-body-sm-regular text-tertiary">
                  {t("agent_teams_load_failed")}
                </div>
              ) : teams.length === 0 ? (
                <div className="rounded-lg border border-dashed border-subtle p-10 text-center text-body-sm-regular text-tertiary">
                  {t("agent_teams_empty_section")}
                </div>
              ) : (
                <div className="overflow-hidden rounded-lg border border-subtle bg-layer-1">
                  {teams.map((team, index) => (
                    <button
                      key={team.id}
                      type="button"
                      onClick={() => router.push(agentTeamDetailPath(team.id))}
                      className={`flex w-full items-center gap-4 px-4 py-4 text-left hover:bg-layer-2-hover ${
                        index > 0 ? "border-t border-subtle" : ""
                      }`}
                    >
                      <div className="flex min-w-0 flex-grow flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-body-sm-medium text-primary">{team.name}</span>
                          {statusBadge(team.status)}
                        </div>
                        {team.objective && (
                          <span className="truncate text-caption-sm-regular text-tertiary">{team.objective}</span>
                        )}
                        <div className="flex items-center gap-3 text-caption-sm-regular text-tertiary">
                          {team.memberCount !== undefined && (
                            <span>{t("agent_teams_member_count", { count: team.memberCount })}</span>
                          )}
                          {team.activeTaskCount !== undefined && team.activeTaskCount > 0 && (
                            <span>{t("agent_teams_task_count", { count: team.activeTaskCount })}</span>
                          )}
                          {team.runningRunCount !== undefined && team.runningRunCount > 0 && (
                            <span>{t("agent_teams_run_count", { count: team.runningRunCount })}</span>
                          )}
                        </div>
                      </div>
                      <ChevronRight className="size-4 flex-shrink-0 text-tertiary" aria-hidden />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </ContentWrapper>
      </div>
    </>
  );
}

export default observer(WorkspaceAgentTeamsPage);
