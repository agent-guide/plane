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
import { Bot, ChevronRight, Inbox, ListTodo, User, Users } from "lucide-react";
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
                  <Inbox className="size-4" aria-hidden />
                  {t("agent_teams_inbox_title")}
                </Button>
              </Header.RightItem>
            </Header>
          }
        />
        <ContentWrapper>
          <div className="flex w-full flex-col gap-5 px-4 pt-4 pb-10">
            <div className="flex flex-col gap-1">
              <h1 className="m-0 text-body-lg-medium text-primary">{t("agent_teams_breadcrumb")}</h1>
              <p className="m-0 max-w-2xl text-body-xs-regular text-tertiary">{t("agent_teams_page_subtitle")}</p>
            </div>

            {loading ? (
              placeholder(t("agent_teams_inbox_loading"))
            ) : failed ? (
              placeholder(t("agent_teams_load_failed"))
            ) : teams.length === 0 ? (
              placeholder(t("agent_teams_empty_section"))
            ) : (
              <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                {teams.map((team) => (
                  <button
                    key={team.id}
                    type="button"
                    onClick={() => router.push(agentTeamDetailPath(team.id))}
                    className="group flex items-center gap-3.5 rounded-lg border border-subtle bg-layer-1 px-4 py-3.5 text-left transition-colors hover:border-accent-primary/40 hover:bg-layer-2-hover"
                  >
                    <span className="flex size-8 flex-shrink-0 items-center justify-center rounded-full bg-accent-subtle text-caption-sm-medium text-accent-primary">
                      {team.name.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="flex min-w-0 flex-grow flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-body-sm-medium text-primary group-hover:text-accent-primary">
                          {team.name}
                        </span>
                        <span
                          className={`inline-flex flex-shrink-0 items-center gap-1 text-caption-sm-regular ${
                            team.status === "active" ? "text-accent-primary" : "text-tertiary"
                          }`}
                        >
                          <span
                            className={`size-1.5 rounded-full ${
                              team.status === "active" ? "bg-accent-primary" : "bg-tertiary"
                            }`}
                            aria-hidden
                          />
                          {t(`agent_teams_status_${team.status}`)}
                        </span>
                      </div>
                      {team.objective && (
                        <p className="m-0 truncate text-caption-sm-regular text-tertiary">{team.objective}</p>
                      )}
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                        {team.memberCount !== undefined && team.memberCount > 0 && (
                          <span className="inline-flex items-center gap-1 text-caption-sm-regular text-secondary">
                            <User className="size-3 text-tertiary" aria-hidden />
                            {team.memberCount}
                          </span>
                        )}
                        {team.activeTaskCount !== undefined && team.activeTaskCount > 0 && (
                          <span className="inline-flex items-center gap-1 text-caption-sm-regular text-accent-primary">
                            <ListTodo className="size-3" aria-hidden />
                            {team.activeTaskCount}
                          </span>
                        )}
                        {team.runningRunCount !== undefined && team.runningRunCount > 0 && (
                          <span className="inline-flex items-center gap-1 text-caption-sm-regular text-secondary">
                            <Bot className="size-3 text-tertiary" aria-hidden />
                            {team.runningRunCount}
                          </span>
                        )}
                      </div>
                    </div>
                    <ChevronRight
                      className="size-4 flex-shrink-0 text-tertiary group-hover:text-accent-primary"
                      aria-hidden
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
        </ContentWrapper>
      </div>
    </>
  );
}

export default observer(WorkspaceAgentTeamsPage);
