/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { Settings, Share2, LogOut, MoreHorizontal } from "lucide-react";
// plane imports
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useOutsideClickDetector } from "@plane/hooks";
import { useTranslation } from "@plane/i18n";
import { Logo } from "@plane/propel/emoji-icon-picker";
import { LinkIcon, ArchiveIcon } from "@plane/propel/icons";
import { IconButton } from "@plane/propel/icon-button";
import { CustomMenu } from "@plane/ui";
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
// local imports
import { ProjectNavigation } from "./project-navigation";
import { SidebarDraggableRow } from "@/components/sidebar/sidebar-draggable-row";

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

export const SidebarProjectsListItem = observer(function SidebarProjectsListItem(props: Props) {
  const { projectId, handleCopyText, disableDrag, disableDrop, isLastChild, handleOnProjectDrop } = props;
  // store hooks
  const { t } = useTranslation();
  const { getPartialProjectById } = useProject();
  const { allowPermissions } = useUserPermissions();
  const { getIsProjectListOpen, toggleProjectListOpen } = useCommandPalette();
  const { preferences: projectPreferences } = useProjectNavigationPreferences();
  const { isExtendedProjectSidebarOpened, toggleExtendedProjectSidebar, toggleAnySidebarDropdown, toggleSidebar } =
    useAppTheme();

  // states
  const [leaveProjectModalOpen, setLeaveProjectModal] = useState(false);
  const [publishModalOpen, setPublishModal] = useState(false);
  const [isMenuActive, setIsMenuActive] = useState(false);
  // store 里未初始化的项目为 undefined，统一收敛为布尔值
  const isProjectListOpen = !!getIsProjectListOpen(projectId);
  // refs
  const actionSectionRef = useRef<HTMLButtonElement | null>(null);
  // router
  const { workspaceSlug, projectId: URLProjectId } = useParams();
  const router = useRouter();
  const pathname = usePathname();
  // 归一化尾斜杠：compat 的 useRouter/Link 会给所有导航补尾斜杠，
  // 而 href 构建为无尾斜杠，直接 === 会恒 false（与团队侧栏同一处理）。
  const path = pathname.replace(/\/+$/, "");
  // derived values
  const project = getPartialProjectById(projectId);

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
    if (isMenuActive) toggleAnySidebarDropdown(true);
    else toggleAnySidebarDropdown(false);
  }, [isMenuActive, toggleAnySidebarDropdown]);

  useOutsideClickDetector(actionSectionRef, () => setIsMenuActive(false));

  if (!project) return null;

  const isAccordionMode = projectPreferences.navigationMode === "ACCORDION";
  // 项目名点击 = 打开项目概览页（与团队名点击打开团队详情一致）；
  // 展开/收起只由行尾箭头负责，两种导航模式下行为统一。
  const overviewUrl = `/${workspaceSlug}/projects/${project.id}/overview`;

  const handleProjectClick = () => {
    if (window.innerWidth < 768) toggleSidebar();
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
      {/* 行机器（拖拽/指示线/展开/路由联动）复用 SidebarDraggableRow；项目域
          差异（菜单/弹层/导航模式）以 props 注入。 */}
      <SidebarDraggableRow
        rowId={projectId}
        dragInstanceId="PROJECTS"
        href={overviewUrl}
        title={project.name}
        leading={
          <div className="grid size-4 flex-shrink-0 place-items-center">
            <Logo logo={project.logo_props} size={16} />
          </div>
        }
        dragPreview={
          <>
            <div className="grid size-4 flex-shrink-0 place-items-center">
              <Logo logo={project.logo_props} />
            </div>
            <p className="truncate text-secondary">{project.name}</p>
          </>
        }
        isRouteActive={URLProjectId === project?.id}
        highlight={shouldHighlightProject}
        isLastChild={isLastChild}
        disableDrag={disableDrag}
        disableDrop={disableDrop}
        onReorder={handleOnProjectDrop}
        onNavigate={handleProjectClick}
        collapsible={isAccordionMode}
        open={isAccordionMode ? isProjectListOpen : undefined}
        onOpenChange={isAccordionMode ? setIsProjectListOpen : undefined}
        submenu={<ProjectNavigation workspaceSlug={workspaceSlug.toString()} projectId={projectId.toString()} />}
        actions={
          <CustomMenu
            customButton={
              <IconButton
                ref={actionSectionRef}
                variant="ghost"
                size="sm"
                icon={MoreHorizontal}
                onClick={() => setIsMenuActive(!isMenuActive)}
                className="text-placeholder"
              />
            }
            className={cn(
              "pointer-events-none flex-shrink-0 opacity-0 group-hover/draggable-row:pointer-events-auto group-hover/draggable-row:opacity-100",
              {
                "pointer-events-auto opacity-100": isMenuActive,
              }
            )}
            customButtonClassName="grid place-items-center"
            placement="bottom-start"
            ariaLabel={t("aria_labels.projects_sidebar.toggle_quick_actions_menu")}
            useCaptureForOutsideClick
            closeOnSelect
            onMenuClose={() => setIsMenuActive(false)}
          >
            {/* publish project settings */}
            {isAdmin && (
              <CustomMenu.MenuItem onClick={() => setPublishModal(true)}>
                <div className="relative flex flex-shrink-0 items-center justify-start gap-2">
                  <div className="flex h-4 w-4 cursor-pointer items-center justify-center rounded-sm text-secondary transition-all duration-300 hover:bg-layer-1">
                    <Share2 className="h-3.5 w-3.5 stroke-[1.5]" />
                  </div>
                  <div>{t("publish_project")}</div>
                </div>
              </CustomMenu.MenuItem>
            )}
            <CustomMenu.MenuItem onClick={handleCopyText}>
              <span className="flex items-center justify-start gap-2">
                <LinkIcon className="h-3.5 w-3.5 stroke-[1.5]" />
                <span>{t("copy_link")}</span>
              </span>
            </CustomMenu.MenuItem>
            {isAuthorized && (
              <CustomMenu.MenuItem
                onClick={() => {
                  router.push(`/${workspaceSlug}/projects/${project?.id}/archives/issues`);
                }}
              >
                <div className="flex cursor-pointer items-center justify-start gap-2">
                  <ArchiveIcon className="h-3.5 w-3.5 stroke-[1.5]" />
                  <span>{t("archives")}</span>
                </div>
              </CustomMenu.MenuItem>
            )}
            <CustomMenu.MenuItem
              onClick={() => {
                router.push(`/${workspaceSlug}/settings/projects/${project?.id}`);
              }}
            >
              <div className="flex cursor-pointer items-center justify-start gap-2">
                <Settings className="h-3.5 w-3.5 stroke-[1.5]" />
                <span>{t("settings")}</span>
              </div>
            </CustomMenu.MenuItem>
            {/* leave project */}
            {!isAuthorized && (
              <CustomMenu.MenuItem onClick={handleLeaveProject}>
                <div className="flex items-center justify-start gap-2">
                  <LogOut className="h-3.5 w-3.5 stroke-[1.5]" />
                  <span>{t("leave_project")}</span>
                </div>
              </CustomMenu.MenuItem>
            )}
          </CustomMenu>
        }
      />
    </>
  );
});
