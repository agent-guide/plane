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

export const chatPath = (workspaceSlug: string) => `${agentTeamsPath(workspaceSlug)}/chat`;

/* 莫奈清晨色板（团队列表/详情/项目概览共用同源同值）：起色/雾止色/墨色
 * 三元组，按团队名稳定散列取色。原为列表页与详情页各自复制，抽到此处
 * 供三页共享（2026-10-22）。 */
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

export const teamAccent = (name: string) => TEAM_ACCENTS[teamHash(name)][0];
export const teamAccentDark = (name: string) => TEAM_ACCENTS[teamHash(name)][1];
export const teamInk = (name: string) => TEAM_ACCENTS[teamHash(name)][2];

/** Member-scoped chat deep link: opens (or creates) that member's session. */
export const memberChatPath = (workspaceSlug: string, identityId: string, displayName: string) =>
  `${chatPath(workspaceSlug)}?member=${identityId}&name=${encodeURIComponent(displayName)}`;

/** Resolves the workspace slug from route params; for use inside components. */
export const useAgentTeamsLinks = () => {
  const { workspaceSlug } = useParams();
  return {
    agentTeamsPath: agentTeamsPath(workspaceSlug),
    agentTeamDetailPath: (teamId: string) => agentTeamDetailPath(workspaceSlug, teamId),
    approvalInboxPath: approvalInboxPath(workspaceSlug),
    chatPath: chatPath(workspaceSlug),
    memberChatPath: (identityId: string, displayName: string) => memberChatPath(workspaceSlug, identityId, displayName),
  };
};
