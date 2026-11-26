/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * 侧栏可拖拽行（自 Plane 项目行机器抽取，项目组/团队组共用）：
 * - 拖拽排序：draggable + dropTargetForElements（按 dragInstanceId 隔离域），
 *   自定义拖拽预览、上下指示线、末位 below 指示；
 * - 路由联动：行命中当前路由时自动展开子菜单并滚动定位；
 * - 手风琴子菜单：尾部箭头开关 + Transition（复用 SidebarSubmenu 容器）。
 * 域差异（菜单/弹层/标识）由调用方以 props 注入。
 */
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { pointerOutsideOfPreview } from "@atlaskit/pragmatic-drag-and-drop/element/pointer-outside-of-preview";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { attachInstruction, extractInstruction } from "@atlaskit/pragmatic-drag-and-drop-hitbox/tree-item";
import { Transition } from "@headlessui/react";
import { createRoot } from "react-dom/client";
import scrollIntoView from "smooth-scroll-into-view-if-needed";
import { ChevronRightIcon } from "@plane/propel/icons";
import { IconButton } from "@plane/propel/icon-button";
import { useTranslation } from "@plane/i18n";
import { DragHandle, DropIndicator } from "@plane/ui";
import { cn } from "@plane/utils";
// components
import { SidebarSubmenu } from "@/components/sidebar/sidebar-submenu";
import { highlightIssueOnDrop } from "@/components/issues/issue-layouts/utils";

export type TSidebarRowReorder = (
  sourceId: string | undefined,
  destinationId: string | undefined,
  dropAtEnd: boolean
) => void;

export function SidebarDraggableRow({
  rowId,
  dragInstanceId,
  href,
  title,
  leading,
  dragPreview,
  submenu,
  actions,
  isRouteActive = false,
  highlight = false,
  isLastChild,
  disableDrag,
  disableDrop,
  onReorder,
  onNavigate,
  /** 受控展开（项目行走 store 持久化；不传则组件内部自管）。 */
  open,
  onOpenChange,
  /** 是否渲染尾部展开箭头与子菜单（项目行仅在手风琴模式启用）。 */
  collapsible = true,
}: {
  /** 行实体 id（拖拽 data.id / 展开键）。 */
  rowId: string;
  /** 拖拽域 id：同域内才可互相拖放（PROJECTS / AGENT_TEAMS）。 */
  dragInstanceId: string;
  /** 名称链接目标。 */
  href: string;
  title: string;
  /** 名称前前置元素（Logo / 状态点）。 */
  leading?: React.ReactNode;
  /** 自定义拖拽预览内容（默认 title 文本）。 */
  dragPreview?: React.ReactNode;
  /** 子菜单（展开时渲染于 SidebarSubmenu 容器内）。 */
  submenu?: React.ReactNode;
  /** 行尾动作区（更多菜单等）。 */
  actions?: React.ReactNode;
  /** 当前路由是否命中该行（命中→自动展开 + 滚动定位）。 */
  isRouteActive?: boolean;
  /** 行高亮（调用方按导航模式决定，默认 false）。 */
  highlight?: boolean;
  isLastChild: boolean;
  disableDrag?: boolean;
  disableDrop?: boolean;
  onReorder?: TSidebarRowReorder;
  /** 名称点击回调（移动端收侧栏等，导航仍由 Link 承担）。 */
  onNavigate?: () => void;
  open?: boolean;
  onOpenChange?: (value: boolean) => void;
  collapsible?: boolean;
}) {
  const { t } = useTranslation();
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const setOpen = (value: boolean) => {
    setInternalOpen(value);
    onOpenChange?.(value);
  };

  const [isDragging, setIsDragging] = useState(false);
  const [instruction, setInstruction] = useState<"DRAG_OVER" | "DRAG_BELOW" | undefined>(undefined);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const dragHandleRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const element = rowRef.current;
    const dragHandleElement = dragHandleRef.current;
    if (!element) return;

    return combine(
      draggable({
        element,
        canDrag: () => !disableDrag,
        dragHandle: dragHandleElement ?? undefined,
        getInitialData: () => ({ id: rowId, dragInstanceId }),
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
        onGenerateDragPreview: ({ nativeSetDragImage }) =>
          setCustomNativeDragPreview({
            getOffset: pointerOutsideOfPreview({ x: "0px", y: "0px" }),
            render: ({ container }) => {
              const root = createRoot(container);
              root.render(
                <div className="flex items-center rounded-sm bg-surface-1 p-1 pr-2 text-13">
                  {dragPreview ?? <p className="truncate text-secondary">{title}</p>}
                </div>
              );
              return () => root.unmount();
            },
            nativeSetDragImage,
          }),
      }),
      dropTargetForElements({
        element,
        canDrop: ({ source }) =>
          !disableDrop && source?.data?.id !== rowId && source?.data?.dragInstanceId === dragInstanceId,
        // oxlint-disable-next-line no-shadow
        getData: ({ input, element: dropElement }) =>
          attachInstruction(
            { id: rowId },
            {
              input,
              element: dropElement,
              currentLevel: 0,
              indentPerLevel: 0,
              mode: isLastChild ? "last-in-group" : "standard",
            }
          ),
        onDrag: ({ self }) => {
          const extracted = extractInstruction(self?.data)?.type;
          setInstruction(
            extracted ? (extracted === "reorder-below" && isLastChild ? "DRAG_BELOW" : "DRAG_OVER") : undefined
          );
        },
        onDragLeave: () => setInstruction(undefined),
        onDrop: ({ self, source }) => {
          setInstruction(undefined);
          const extracted = extractInstruction(self?.data)?.type;
          const current = extracted
            ? extracted === "reorder-below" && isLastChild
              ? "DRAG_BELOW"
              : "DRAG_OVER"
            : undefined;
          if (!current) return;
          const sourceId = source?.data?.id as string | undefined;
          const destinationId = self?.data?.id as string | undefined;
          onReorder?.(sourceId, destinationId ?? rowId, current === "DRAG_BELOW");
          highlightIssueOnDrop(`sidebar-row-${rowId}-${dragInstanceId}`);
        },
      })
    );
    // oxlint-disable-next-line eslint-plugin-react-hooks/exhaustive-deps
  }, [rowId, dragInstanceId, isLastChild, onReorder, disableDrag, disableDrop, title, dragPreview]);

  // 路由命中 → 自动展开 + 滚动定位（项目行原生行为）。
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (isRouteActive) {
      if (collapsible) setOpen(true);
      if (rowRef.current) {
        timeoutId = setTimeout(() => {
          if (rowRef.current)
            scrollIntoView(rowRef.current, { behavior: "smooth", block: "center", scrollMode: "if-needed" });
        }, 200);
      }
    }
    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRouteActive, collapsible]);

  return (
    <div
      id={`sidebar-row-${rowId}-${dragInstanceId}`}
      className={cn("relative", { "bg-layer-1 opacity-60": isDragging })}
      ref={rowRef}
    >
      <DropIndicator classNames="absolute top-0" isVisible={instruction === "DRAG_OVER"} />
      <div
        className={cn(
          "group/draggable-row relative flex w-full items-center rounded-md px-2 py-1.5 text-primary hover:bg-layer-transparent-hover",
          { "bg-layer-transparent-active": highlight }
        )}
      >
        {!disableDrag && (
          <button
            type="button"
            className="absolute top-1/2 -left-3 hidden -translate-y-1/2 cursor-grab items-center justify-center rounded-sm text-placeholder group-hover/draggable-row:flex"
            ref={dragHandleRef}
            aria-label="drag to reorder"
          >
            <DragHandle className="bg-transparent" />
          </button>
        )}
        <Link
          href={href}
          onClick={onNavigate}
          className="flex w-full flex-grow items-center gap-1.5 truncate py-[1px] text-left select-none"
        >
          {leading}
          <p className="truncate text-13 font-medium text-secondary">{title}</p>
        </Link>
        <div className="flex items-center gap-1">
          {actions}
          {collapsible && (
            <IconButton
              variant="ghost"
              size="sm"
              icon={ChevronRightIcon}
              onClick={() => setOpen(!isOpen)}
              className="text-placeholder"
              iconClassName={cn("transition-transform", { "rotate-90": isOpen })}
              aria-label={t(isOpen ? "agent_teams_sidebar_collapse" : "agent_teams_sidebar_expand")}
            />
          )}
        </div>
      </div>
      {collapsible && (
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
          {isOpen && <SidebarSubmenu>{submenu}</SidebarSubmenu>}
        </Transition>
      )}
      {isLastChild && <DropIndicator isVisible={instruction === "DRAG_BELOW"} />}
    </div>
  );
}
