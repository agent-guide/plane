/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — Work Item detail Extension Slot (design §12.5-5).
 * Placeholder shell: layout and routing only. Runtime summary rows
 * (team / current member / workflow step / status / cost / artifacts /
 * approval actions — design §12.3) will be fed by the Runtime console API
 * once the Phase 4 contract is frozen; this panel must not import Runtime
 * source code (design §12.6.6).
 */
import { observer } from "mobx-react";
// i18n
import { useTranslation } from "@plane/i18n";
// icons
import { Users } from "lucide-react";

type WorkItemRuntimePanelProps = {
  issueId: string;
};

export const WorkItemRuntimePanel = observer(function WorkItemRuntimePanel({ issueId }: WorkItemRuntimePanelProps) {
  const { t } = useTranslation();
  return (
    <div className="w-full py-4" data-issue-id={issueId}>
      <h5 className="flex items-center gap-1.5 text-body-xs-medium text-placeholder">
        <Users className="size-3.5 flex-shrink-0" />
        {t("agent_teams_panel_title")}
      </h5>
      <div className="mt-3 rounded-sm border border-dashed border-subtle px-3 py-4 text-center text-caption-sm-regular text-tertiary">
        {t("agent_teams_panel_pending")}
      </div>
    </div>
  );
});
