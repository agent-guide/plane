/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — shared quiet-section primitives for the team detail
 * page (Section / RowList / EmptyRow). Extracted when the 流程 section moved
 * into its own component so both stay visually identical by construction.
 */
import type React from "react";
import { EmptyStateCompact } from "@plane/propel/empty-state";
import type { CompactAssetType } from "@plane/propel/empty-state";

/** Quiet section label — the content below is the protagonist. */
export function Section({
  label,
  count,
  description,
  action,
  children,
}: {
  label: string;
  count?: number;
  description?: string;
  /** 区块头右侧动作位（如「新建」按钮），与标签同行右对齐。 */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    // 区块头提层级（2026-10-22 重排）：15px 半粗标题（无图标，Plane 原生
    // 区块头惯例）+ 计数 chip + 13px 三级说明，与下方内容 gap-4——区块间
    // 的分隔靠标题体量与页级 40px 节奏，不给表格套卡片。
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="text-[15px] leading-6 font-semibold text-primary">{label}</span>
        {count !== undefined && (
          <span className="rounded-full bg-layer-2 px-2 py-0.5 text-[12px] leading-4 text-secondary">{count}</span>
        )}
        {description && <span className="text-[13px] leading-5 text-tertiary">{description}</span>}
        {action ? <span className="ml-auto self-center">{action}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function RowList({ children }: { children: React.ReactNode }) {
  return <div className="overflow-hidden rounded-lg border border-subtle bg-layer-1">{children}</div>;
}

/**
 * 区块内空态：直接复用 Plane 的空态组件（Propel `EmptyStateCompact` + 插图），
 * 与标签页、收件箱、首页卡片等处同一套视觉。
 *
 * 早前自绘的虚线框是草稿观感，且与「有数据时是无边框表格」不成一套——
 * 空态比数据态多出一圈框，视线一跳。空态即引导：标题说清为什么空，
 * 说明交代怎么填上，有主操作时给按钮（设计 2026-10-20 整改延续）。
 */
export function EmptyRow({
  label,
  description,
  assetKey = "work-item",
  action,
}: {
  label: string;
  /** 空态说明——为什么空 / 怎么让它有内容。 */
  description?: string;
  /** Plane 插图键（见 @plane/propel/empty-state 资产清单），按列表语义选。 */
  assetKey?: CompactAssetType;
  /** 空态主操作（可选）。 */
  action?: React.ReactNode;
}) {
  return (
    <EmptyStateCompact
      assetKey={assetKey}
      assetClassName="size-20"
      title={label}
      description={description}
      // customButton 落在 flex-col 容器里（交叉轴默认拉伸），不包 w-fit
      // 会被撑满整行——按钮宽度必须适配内容。
      customButton={action ? <span className="mx-auto flex w-fit">{action}</span> : undefined}
      rootClassName="py-10"
    />
  );
}
