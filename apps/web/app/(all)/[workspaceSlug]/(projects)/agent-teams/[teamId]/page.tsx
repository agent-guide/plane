/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — team detail (workspace scoped).
 * Placeholder shell for the P1 structural slot: layout and routing only.
 */
import { observer } from "mobx-react";
// components
import { PageHead } from "@/components/core/page-title";
// i18n
import { useTranslation } from "@plane/i18n";
// hooks
import { useWorkspace } from "@/hooks/store/use-workspace";

function WorkspaceAgentTeamDetailPage() {
  const { t } = useTranslation();
  const { currentWorkspace } = useWorkspace();
  // derived values
  const pageTitle = currentWorkspace?.name ? `${currentWorkspace?.name} - Agent Team` : undefined;

  return (
    <>
      <PageHead title={pageTitle} />
      <div className="container mx-auto h-full w-full px-5 py-8">
        <h1 className="text-2xl text-custom-text-100 font-semibold">Agent Team</h1>
        <p className="text-sm text-custom-text-300 mt-2 max-w-2xl">{t("agent_teams_detail_subtitle")}</p>
        <div className="border-custom-border-200 bg-custom-background-100 text-sm text-custom-text-300 mt-8 rounded-lg border p-10 text-center">
          {t("agent_teams_detail_pending")}
        </div>
      </div>
    </>
  );
}

export default observer(WorkspaceAgentTeamDetailPage);
