/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — 侧边栏团队折叠组（严格参照项目组的交互）：
 * 组头（名称 + [＋新建] + [展开箭头]）→ 团队行（可再展开：成员/流程
 * 子项列表，同项目组的二级结构）→ 底部"查看全部"。数据走 runtime-token
 * 通道（experts-auth）。纯本地 state，无 store 依赖。
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Disclosure, Transition } from "@headlessui/react";
import { useTranslation } from "@plane/i18n";
import { BotIcon, ChevronRightIcon, PlusIcon, UserIcon } from "lucide-react";
import { IconButton } from "@plane/propel/icon-button";
import { Tooltip } from "@plane/ui";
import { cn } from "@plane/utils";
// components
import { SidebarNavItem } from "@/components/sidebar/sidebar-navigation";
import { SidebarDraggableRow } from "@/components/sidebar/sidebar-draggable-row";
import { TeamStatusIcon } from "@/components/agent-teams/team-status";
import { agentTeamDetailPath, agentTeamsPath } from "@/components/agent-teams/helper";
import { setExpertsWorkspaceSlug } from "@/services/agent-teams/experts-auth";
import runtimeService, { type AgentTeam } from "@/services/agent-teams/runtime.service";

const STORAGE_KEY = "isAgentTeamsSidebarOpen";
/** 侧边栏直列上限（项目组同款节流；更多走"查看全部"）。 */
const SIDEBAR_TEAM_LIMIT = 6;

/** 团队侧栏排序键（按工作区隔离）。 */
const orderKey = (workspaceSlug: string) => `agentTeamsSidebarOrder:${workspaceSlug}`;

/** 按已存顺序重排；未记录的团队（新建）按原顺序追加。 */
function sortByStoredOrder<T extends { id: string }>(teams: T[], workspaceSlug: string): T[] {
  if (typeof window === "undefined") return teams;
  let stored: string[] = [];
  try {
    stored = JSON.parse(window.localStorage.getItem(orderKey(workspaceSlug)) ?? "[]");
  } catch {
    stored = [];
  }
  if (!Array.isArray(stored) || stored.length === 0) return teams;
  const rank = new Map(stored.map((id, index) => [id, index]));
  // spread-then-sort: toSorted needs lib es2023; tsconfig targets older（项目
  // 排序同款处理）。
  // oxlint-disable-next-line unicorn/no-array-sort
  return [...teams].sort((a, b) => (rank.get(a.id) ?? stored.length) - (rank.get(b.id) ?? stored.length));
}

export function SidebarAgentTeamsList({ workspaceSlug }: { workspaceSlug: string }) {
  const { t } = useTranslation();
  const pathname = usePathname();
  // 归一化尾斜杠：compat 的 useRouter/Link 会给所有导航补尾斜杠，
  // 而 href 构建为无尾斜杠，直接 === 会恒 false（项目子项用 includes 规避）。
  const path = pathname.replace(/\/+$/, "");
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(true);
  const [teams, setTeams] = useState<AgentTeam[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const stored = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (stored !== null) setIsOpen(stored === "true");
  }, []);

  // 进入团队相关路由时自动展开（项目组同款行为）
  useEffect(() => {
    if (pathname.includes("/agent-teams")) {
      setIsOpen(true);
      window.localStorage.setItem(STORAGE_KEY, "true");
    }
  }, [pathname]);

  const load = useCallback(() => {
    setExpertsWorkspaceSlug(workspaceSlug);
    runtimeService
      .listTeams()
      .then((items) => {
        setTeams(sortByStoredOrder(items, workspaceSlug));
        setLoaded(true);
        return null;
      })
      .catch(() => {
        /* runtime 未接入时静默（与团队页一致），组内容保持空态 */
      });
  }, [workspaceSlug]);

  // 拖拽排序（与项目行同一机器）：runtime 无团队排序字段，顺序持久化在
  // localStorage（按工作区分键），新团队追加在末尾。
  const handleTeamReorder = useCallback(
    (sourceId: string | undefined, destinationId: string | undefined, dropAtEnd: boolean) => {
      if (!sourceId) return;
      setTeams((prev) => {
        const next = [...prev];
        const si = next.findIndex((team) => team.id === sourceId);
        if (si < 0) return prev;
        const [moved] = next.splice(si, 1);
        if (dropAtEnd) next.push(moved);
        else {
          const di = next.findIndex((team) => team.id === destinationId);
          if (di >= 0) next.splice(di, 0, moved);
          else next.push(moved);
        }
        window.localStorage.setItem(orderKey(workspaceSlug), JSON.stringify(next.map((team) => team.id)));
        return next;
      });
    },
    [workspaceSlug]
  );

  useEffect(() => {
    if (!isOpen) return;
    load();
  }, [isOpen, load]);

  const toggle = (next: boolean) => {
    setIsOpen(next);
    window.localStorage.setItem(STORAGE_KEY, String(next));
  };

  const visible = teams.slice(0, SIDEBAR_TEAM_LIMIT);
  const overflow = teams.length - visible.length;

  return (
    <Disclosure as="div" className="flex flex-col" defaultOpen={isOpen}>
      {() => (
        <>
          <div className="group flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-placeholder hover:bg-layer-transparent-hover">
            {/* 组头文字=跳团队列表页（整合自顶部工作区菜单的「团队」入口，
                2026-10-22）；展开/收起由右侧箭头承担。 */}
            <Link
              href={agentTeamsPath(workspaceSlug)}
              className="flex w-full items-center gap-1 text-left text-13 font-semibold whitespace-nowrap text-placeholder"
            >
              <span className="text-13 font-semibold">{t("agent_teams_sidebar_title")}</span>
            </Link>
            <div className="flex items-center gap-1">
              {/* 新建入口跳列表页（含配额提示与完整表单），侧边栏不重复一套创建弹层 */}
              <Tooltip tooltipHeading={t("agent_teams_create_team")} tooltipContent="">
                <IconButton
                  variant="ghost"
                  size="sm"
                  icon={PlusIcon}
                  className="hidden text-placeholder group-hover:inline-flex"
                  aria-label={t("agent_teams_create_team")}
                  onClick={() => router.push(agentTeamsPath(workspaceSlug))}
                />
              </Tooltip>
              <IconButton
                variant="ghost"
                size="sm"
                icon={ChevronRightIcon}
                onClick={() => toggle(!isOpen)}
                className="text-placeholder"
                iconClassName={cn("transition-transform", { "rotate-90": isOpen })}
                aria-label={t(isOpen ? "agent_teams_sidebar_collapse" : "agent_teams_sidebar_expand")}
              />
            </div>
          </div>
          <Transition
            as="div"
            show={isOpen}
            enter="transition duration-100 ease-out"
            enterFrom="transform scale-95 opacity-0"
            enterTo="transform scale-100 opacity-100"
            leave="transition duration-75 ease-out"
            leaveFrom="transform scale-100 opacity-100"
            leaveTo="transform scale-95 opacity-0"
          >
            <div className="mt-0.5 flex flex-col gap-0.5">
              {visible.map((team, index) => {
                const href = agentTeamDetailPath(workspaceSlug, team.id);
                const membersHref = `/${workspaceSlug}/agent-teams/${team.id}/members`;
                const processesHref = `/${workspaceSlug}/agent-teams/${team.id}/processes`;
                const statusIcon = <TeamStatusIcon status={team.status} className="size-3.5" />;
                return (
                  <SidebarDraggableRow
                    key={team.id}
                    rowId={team.id}
                    dragInstanceId="AGENT_TEAMS"
                    href={href}
                    title={team.name}
                    isRouteActive={path === href}
                    highlight={path === href}
                    isLastChild={index === visible.length - 1}
                    onReorder={handleTeamReorder}
                    leading={statusIcon}
                    dragPreview={
                      <>
                        {statusIcon}
                        <p className="truncate text-secondary">{team.name}</p>
                      </>
                    }
                    submenu={
                      <>
                        {/* 子项：两个固定分组入口——成员 / 流程（跳详情页对应区块）。 */}
                        <Link href={membersHref} className="block">
                          <SidebarNavItem isActive={path === membersHref}>
                            <div className="flex w-full items-center gap-1.5 py-[1px]">
                              <UserIcon className="size-4 flex-shrink-0" aria-hidden />
                              <span className="text-11 font-medium">{t("agent_teams_members_title")}</span>
                            </div>
                          </SidebarNavItem>
                        </Link>
                        <Link href={processesHref} className="block">
                          <SidebarNavItem isActive={path === processesHref}>
                            <div className="flex w-full items-center gap-1.5 py-[1px]">
                              <BotIcon className="size-4 flex-shrink-0" aria-hidden />
                              <span className="text-11 font-medium">{t("agent_teams_workflows_title")}</span>
                            </div>
                          </SidebarNavItem>
                        </Link>
                      </>
                    }
                  />
                );
              })}
              {loaded && overflow > 0 ? (
                <div className="px-2 py-1 text-11 text-tertiary">
                  {t("agent_teams_sidebar_more", { count: overflow })}
                </div>
              ) : null}
              {/* 「查看全部」行已移除（2026-10-22）：组头文字即团队列表页入口。 */}
            </div>
          </Transition>
        </>
      )}
    </Disclosure>
  );
}
