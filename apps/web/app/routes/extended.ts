/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Compile-time extension routes (design §5.4 / §12.5-3): Agent Teams pages.
 *
 * mergeRoutes dedupes/merges by route file at each nesting level, so the
 * extension must mirror the core layout chain ((all) > [workspaceSlug] >
 * (projects)) for the children below to be deep-merged into the core tree
 * instead of producing duplicate route ids.
 */
import type { RouteConfigEntry } from "@react-router/dev/routes";
import { layout, route } from "@react-router/dev/routes";

export const extendedRoutes: RouteConfigEntry[] = [
  layout("./(all)/layout.tsx", [
    layout("./(all)/[workspaceSlug]/layout.tsx", [
      layout("./(all)/[workspaceSlug]/(projects)/layout.tsx", [
        route(":workspaceSlug/agent-teams", "./(all)/[workspaceSlug]/(projects)/agent-teams/page.tsx"),
        route(":workspaceSlug/agent-teams/:teamId", "./(all)/[workspaceSlug]/(projects)/agent-teams/[teamId]/page.tsx"),
      ]),
    ]),
  ]),
];
