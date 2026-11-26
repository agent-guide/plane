/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { pointerOutsideOfPreview } from "@atlaskit/pragmatic-drag-and-drop/element/pointer-outside-of-preview";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { attachInstruction, extractInstruction } from "@atlaskit/pragmatic-drag-and-drop-hitbox/tree-item";
import { observer } from "mobx-react";
import { useParams, useRouter } from "next/navigation";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import scrollIntoView from "smooth-scroll-into-view-if-needed";
import {
  ArchiveOutline,
  ChevronRightOutline,
  DragDropOutline,
  LinkOutline,
  LogOutOutline,
  MoreHorizontalOutline,
  SettingsOutline,
  ShareAltOutline,
} from "@makeplane/propel/icons";
// plane imports
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useOutsideClickDetector } from "@plane/hooks";
import { useTranslation } from "@plane/i18n";
import { Logo } from "@plane/blocks/emoji-icon-picker";
import { IconButton } from "@makeplane/propel/components/icon-button";
import { Icon } from "@makeplane/propel/components/icon";
import { Tooltip } from "@makeplane/propel/components/tooltip";
import { ControlLink } from "@plane/blocks/layout";
import { ListItem, ListItemLabel, ListItemLink } from "@makeplane/propel/elements/list";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@makeplane/propel/components/menu";
import { DropIndicator } from "@plane/blocks/common";
import { cn } from "@plane/utils";
// components
import { LeaveProjectModal } from "@/components/project/leave-project-modal";
import { PublishProjectModal } from "@/components/project/publish-project/modal";
// hooks
import { useAppTheme } from "@/hooks/store/use-app-theme";
import { useCommandPalette } from "@/hooks/store/use-command-palette";
import { useProject } from "@/hooks/store/use-project";
import { useUserPermissions } from "@/hooks/store/user";
import { useProjectNavigationPreferences } from "@/hooks/use-navigation-preferences";
import { GitBranch } from "lucide-react";
// local imports
import { ProjectNavigation } from "./project-navigation";

type Props = {
  projectId: string;
  handleCopyText: () => void;
  handleOnProjectDrop?: (
    sourceId: string | undefined,
    destinationId: string | undefined,
    shouldDropAtEnd: boolean
  ) => void;
  projectListType: "JOINED" | "FAVORITES";
  disableDrag?: boolean;
  disableDrop?: boolean;
  isLastChild: boolean;
  renderInExtendedSidebar?: boolean;
};

/** 项目流程库入口（Agent Teams extension，2026-10-29 方案 A）：与「工作项」
 * 对称的子菜单项，直达项目流程库；文案复用既有 agent_teams_workflows_title。 */
const PROJECT_WORKFLOW_NAV_ITEM = (workspaceSlug: string, projectId: string) => [
  {
    i18n_key: "agent_teams_workflows_title",
    key: "workflows",
    name: "Workflows",
    href: `/${workspaceSlug}/projects/${projectId}/workflows`,
    icon: GitBranch,
    access: [EUserPermissions.ADMIN, EUserPermissions.MEMBER, EUserPermissions.GUEST],
    shouldRender: true,
    sortOrder: 1.5,
  },
];

export const SidebarProjectsListItem = observer(function SidebarProjectsListItem(props: Props) {
  const { projectId, handleCopyText, disableDrag, disableDrop, isLastChild, handleOnProjectDrop } = props;
  // store hooks
  const { t } = useTranslation();
  const { getPartialProjectById } = useProject();
  const { allowPermissions } = useUserPermissions();
  const { getIsProjectListOpen, toggleProjectListOpen } = useCommandPalette();
  const { preferences: projectPreferences } = useProjectNavigationPreferences();
  const { toggleSidebar, isExtendedProjectSidebarOpened, toggleExtendedProjectSidebar, toggleAnySidebarDropdown } =
    useAppTheme();

  // states
  const [leaveProjectModalOpen, setLeaveProjectModal] = useState(false);
  const [publishModalOpen, setPublishModal] = useState(false);
  const [isMenuActive, setIsMenuActive] = useState(false);
  // store 里未初始化的项目为 undefined，统一收敛为布尔值
  const isProjectListOpen = !!getIsProjectListOpen(projectId);
  // refs
  const projectRef = useRef<HTMLDivElement | null>(null);
  const dragHandleRef = useRef<HTMLButtonElement | null>(null);
  // router
  const { workspaceSlug, projectId: URLProjectId } = useParams();
  const router = useRouter();
  const pathname = usePathname();
  // 归一化尾斜杠：compat 的 useRouter/Link 会给所有导航补尾斜杠，
  // 而 href 构建为无尾斜杠，直接 === 会恒 false（与团队侧栏同一处理）。
  const path = pathname.replace(/\/+$/, "");
  // derived values
  const project = getPartialProjectById(projectId);
  const previewProjectRef = useRef(project);

  useLayoutEffect(() => {
    previewProjectRef.current = project;
  }, [project, project?.name, project?.logo_props]);

  // toggle project list open
  const setIsProjectListOpen = useCallback(
    (value: boolean) => toggleProjectListOpen(projectId, value),
    [projectId, toggleProjectListOpen]
  );
  // auth
  const isAdmin = allowPermissions(
    [EUserPermissions.ADMIN],
    EUserPermissionsLevel.PROJECT,
    workspaceSlug.toString(),
    project?.id
  );
  const isAuthorized = allowPermissions(
    [EUserPermissions.ADMIN, EUserPermissions.MEMBER],
    EUserPermissionsLevel.PROJECT,
    workspaceSlug.toString(),
    project?.id
  );

  const handleLeaveProject = () => {
    setLeaveProjectModal(true);
  };

  useEffect(() => {
  useOutsideClickDetector(projectRef, () => projectRef?.current?.classList?.remove(HIGHLIGHT_CLASS));

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (URLProjectId === project?.id) {
      setIsProjectListOpen(true);
      // Scroll to active project
      if (projectRef.current) {
        timeoutId = setTimeout(() => {
          if (projectRef.current) {
            scrollIntoView(projectRef.current, {
              behavior: "smooth",
              block: "center",
              scrollMode: "if-needed",
            });
          }
        }, 200);
      }
    }

    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [URLProjectId, project?.id, setIsProjectListOpen]);

  if (!project) return null;

  const isAccordionMode = projectPreferences.navigationMode === "ACCORDION";
  // 项目名点击 = 打开项目概览页（与团队名点击打开团队详情一致）；
  // 展开/收起只由行尾箭头负责，两种导航模式下行为统一。
  const overviewUrl = `/${workspaceSlug}/projects/${project.id}/overview`;

  const handleItemClick = () => {
    if (projectPreferences.navigationMode === "ACCORDION") {
      setIsProjectListOpen(!isProjectListOpen);
    } else {
      router.push(defaultTabUrl);
      // the sidebar overlays the page on mobile, so collapse it once a project is opened
      if (window.innerWidth < 768) toggleSidebar(true);
    }
    // close the extended sidebar if it is open
    if (isExtendedProjectSidebarOpened) toggleExtendedProjectSidebar(false);
  };

  // 手风琴模式下子项各自高亮，仅概览页（无子项）时高亮项目行；
  // 标签页模式下停留在该项目任意页面都高亮。
  const shouldHighlightProject =
    URLProjectId === project?.id && (projectPreferences.navigationMode !== "ACCORDION" || path === overviewUrl);

  return (
    <>
      <PublishProjectModal isOpen={publishModalOpen} projectId={projectId} onClose={() => setPublishModal(false)} />
      <LeaveProjectModal project={project} isOpen={leaveProjectModalOpen} onClose={() => setLeaveProjectModal(false)} />
      <div key={`${project.id}_${URLProjectId}`}>
        <div
          id={`sidebar-${projectId}-${projectListType}`}
          className={cn("relative", {
            "bg-layer-1 opacity-60": isDragging,
          })}
          ref={projectRef}
        >
          <DropIndicator classNames="absolute top-0" isVisible={instruction === "DRAG_OVER"} />
          <ListItem
            density="comfortable"
            render={
              <div
                id={project.id}
                className={cn("group/project-item", {
                  "bg-layer-transparent-hover": isMenuActive,
                })}
              />
            }
          >
            {!disableDrag && (
              <Tooltip
                label={project.sort_order === null ? t("join_the_project_to_rearrange") : t("drag_to_rearrange")}
                align="end"
                disabled={isDragging || isMobile}
              >
                <IconButton
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label={t("drag_to_rearrange")}
                  showTooltip={false}
                  ref={dragHandleRef}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  render={(buttonProps) => (
                    <button
                      {...buttonProps}
                      className={cn(
                        buttonProps.className,
                        "absolute top-1/2 -left-3 hidden -translate-y-1/2 cursor-grab group-focus-within/project-item:flex group-hover/project-item:flex",
                        {
                          "cursor-not-allowed opacity-60": project.sort_order === null,
                          "cursor-grabbing": isDragging,
                          flex: isMenuActive || renderInExtendedSidebar,
                        }
                      )}
                    />
                  )}
                  icon={<Icon icon={DragDropOutline} tint="placeholder" />}
                />
              </Tooltip>
            )}
            <>
              <ListItemLink
                render={(linkProps) => (
                  <ControlLink {...linkProps} href={defaultTabUrl} draggable={false} onClick={handleItemClick}>
                    {linkProps.children}
                  </ControlLink>
                )}
                aria-current={shouldHighlightProject ? "page" : undefined}
                aria-expanded={isAccordionMode ? isProjectListOpen : undefined}
              >
                <Logo logo={project.logo_props} size={16} />
                <ListItemLabel>{project.name}</ListItemLabel>
              </ListItemLink>
              <div className="flex items-center gap-1">
                <div
                  className={cn(
                    "pointer-events-none flex-shrink-0 opacity-0 group-focus-within/project-item:pointer-events-auto group-focus-within/project-item:opacity-100 group-hover/project-item:pointer-events-auto group-hover/project-item:opacity-100",
                    {
                      "pointer-events-auto opacity-100": isMenuActive,
                    }
                  )}
                >
                  <Menu onOpenChange={setIsMenuActive}>
                    <MenuTrigger
                      render={
                        <IconButton
                          variant="ghost"
                          size="xs"
                          icon={<Icon icon={MoreHorizontalOutline} />}
                          aria-label={t("aria_labels.projects_sidebar.toggle_quick_actions_menu")}
                          render={<button type="button" className="text-placeholder" />}
                        />
                      }
                    />
                    <MenuContent side="bottom" align="start">
                      {/* TODO: Removed is_favorite logic due to the optimization in projects API */}
                      {/* publish project settings */}
                      {isAdmin && (
                        <MenuItem
                          icon={<Icon icon={ShareAltOutline} />}
                          label={t("publish_project")}
                          onClick={() => setPublishModal(true)}
                        />
                      )}
                      <MenuItem icon={<Icon icon={LinkOutline} />} label={t("copy_link")} onClick={handleCopyText} />
                      {isAuthorized && (
                        <MenuItem
                          icon={<Icon icon={ArchiveOutline} />}
                          label={t("archives")}
                          onClick={() => {
                            router.push(`/${workspaceSlug}/projects/${project?.id}/archives/issues`);
                          }}
                        />
                      )}
                      <MenuItem
                        icon={<Icon icon={SettingsOutline} />}
                        label={t("settings")}
                        onClick={() => {
                          router.push(`/${workspaceSlug}/settings/projects/${project?.id}`);
                        }}
                      />
                      {/* leave project */}
                      {!isAuthorized && (
                        <MenuItem
                          icon={<Icon icon={LogOutOutline} />}
                          label={t("leave_project")}
                          onClick={handleLeaveProject}
                        />
                      )}
                    </MenuContent>
                  </Menu>
                </div>
                {isAccordionMode && (
                  <span
                    className={cn(
                      "hidden text-placeholder group-focus-within/project-item:inline-flex group-hover/project-item:inline-flex",
                      {
                        "inline-flex": isMenuActive,
                      }
                    )}
                  >
                    <IconButton
                      variant="ghost"
                      size="xs"
                      icon={
                        <ChevronRightOutline
                          className={cn("size-3.5 transition-transform", {
                            "rotate-90": isProjectListOpen,
                          })}
                        />
                      }
                      onClick={() => setIsProjectListOpen(!isProjectListOpen)}
                      aria-expanded={isProjectListOpen}
                      aria-label={t(
                        isProjectListOpen
                          ? "aria_labels.projects_sidebar.close_project_menu"
                          : "aria_labels.projects_sidebar.open_project_menu"
                      )}
                    />
                  </span>
                )}
              </div>
            </>
          </ListItem>
          {isAccordionMode && isProjectListOpen && (
            <div className="relative mt-1 mb-1.5 flex flex-col gap-px pl-6">
              <div className="absolute top-0 bottom-1 left-[15px] w-[1px] bg-layer-3" />
              <ProjectNavigation
                workspaceSlug={workspaceSlug.toString()}
                projectId={projectId.toString()}
                additionalNavigationItems={PROJECT_WORKFLOW_NAV_ITEM}
              />
            </div>
          )}
          {isLastChild && <DropIndicator isVisible={instruction === "DRAG_BELOW"} />}
        </div>
      </div>
    </>
  );
});
