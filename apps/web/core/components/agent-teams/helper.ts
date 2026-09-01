/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — internal route builders.
 * The fork has no central links module, and the next/link compat shim does
 * not resolve relative hrefs against the current route — always build
 * absolute paths from the workspace slug.
 */
import { useParams } from "next/navigation";

export const agentTeamsPath = (workspaceSlug: string) => `/${workspaceSlug}/agent-teams`;

export const agentTeamDetailPath = (workspaceSlug: string, teamId: string) =>
  `${agentTeamsPath(workspaceSlug)}/${teamId}`;

export const approvalInboxPath = (workspaceSlug: string) => `${agentTeamsPath(workspaceSlug)}/inbox`;

/** Resolves the workspace slug from route params; for use inside components. */
export const useAgentTeamsLinks = () => {
  const { workspaceSlug } = useParams();
  return {
    agentTeamsPath: agentTeamsPath(workspaceSlug),
    agentTeamDetailPath: (teamId: string) => agentTeamDetailPath(workspaceSlug, teamId),
    approvalInboxPath: approvalInboxPath(workspaceSlug),
  };
};
