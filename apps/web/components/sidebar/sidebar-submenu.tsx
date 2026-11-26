/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * 侧栏二级菜单容器（项目组/团队组共用）：统一的缩进 + 左侧 1px 竖线
 * （Plane 项目组原生样式）——原来团队子菜单是裸 pl-3 缩进、项目子菜单
 * 自带竖线，两处视觉不一致；抽成组件后样式同源。
 */
import type React from "react";

export function SidebarSubmenu({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative mt-1 mb-1.5 flex flex-col gap-0.5 pl-6">
      <div className="absolute top-0 bottom-1 left-[15px] w-[1px] bg-layer-3" aria-hidden />
      {children}
    </div>
  );
}
