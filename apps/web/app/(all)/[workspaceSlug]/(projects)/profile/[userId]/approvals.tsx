"use client";

import { PageHead } from "@/components/core/page-title";
import { useTranslation } from "@plane/i18n";
import { useParams } from "next/navigation";
import { AgentApprovalsProvider } from "@/components/agent-teams/approvals-context";
import { AgentApprovalCardList } from "@/components/agent-teams/approval-card-list";
import { AgentApprovalDetailPane } from "@/components/agent-teams/approval-detail";
import { useAgentApprovalsSelection } from "@/components/agent-teams/approvals-context";

function ApprovalsSplitView({ workspaceSlug }: { workspaceSlug: string }) {
  const { selected } = useAgentApprovalsSelection();
  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden">
      <div className="h-full min-h-0 w-full overflow-y-auto border-r border-subtle md:w-64 lg:w-72">
        <AgentApprovalCardList workspaceSlug={workspaceSlug} />
      </div>
      <div className="hidden h-full min-h-0 flex-1 overflow-y-auto md:block">
        {selected ? (
          <AgentApprovalDetailPane workspaceSlug={workspaceSlug} />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-body-sm-regular text-tertiary">
            {null}
          </div>
        )}
      </div>
    </div>
  );
}

export function ProfileApprovalsView() {
  const { t } = useTranslation();
  const { workspaceSlug } = useParams();
  return (
    <>
      <PageHead title={t("profile.tabs.approvals")} />
      <AgentApprovalsProvider>
        <ApprovalsSplitView workspaceSlug={workspaceSlug?.toString() ?? ""} />
      </AgentApprovalsProvider>
    </>
  );
}
