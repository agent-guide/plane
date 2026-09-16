/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — selection bridge for the notifications inbox's
 * "team approvals" tab (design §12.6.4). The left tab list (rendered by the
 * notifications layout) and the right detail pane (rendered by the page
 * outlet) live in separate trees; this context, provided at the layout
 * level, carries the selected waiting decision between them.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { HumanInboxItem } from "@/services/agent-teams/runtime.service";

type AgentApprovalsSelection = {
  selected: HumanInboxItem | null;
  setSelected: (item: HumanInboxItem | null) => void;
};

const AgentApprovalsContext = createContext<AgentApprovalsSelection | null>(null);

export function AgentApprovalsProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<HumanInboxItem | null>(null);
  const value = useMemo(() => ({ selected, setSelected }), [selected]);
  return <AgentApprovalsContext.Provider value={value}>{children}</AgentApprovalsContext.Provider>;
}

export function useAgentApprovalsSelection(): AgentApprovalsSelection {
  const ctx = useContext(AgentApprovalsContext);
  // Default no-op outside the notifications layout (e.g. unit renders) —
  // the list simply stops selecting, nothing crashes.
  return ctx ?? { selected: null, setSelected: () => {} };
}
