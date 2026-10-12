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

/** Quiet section label — the content below is the protagonist. */
export function Section({
  label,
  count,
  description,
  icon,
  action,
  children,
}: {
  label: string;
  count?: number;
  description?: string;
  icon?: React.ReactNode;
  /** 区块头右侧动作位（如「新建」按钮），与标签同行右对齐。 */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="inline-flex items-center gap-1.5 text-caption-sm-medium text-secondary">
          {icon}
          {label}
        </span>
        {count !== undefined && <span className="text-caption-sm-regular text-tertiary">{count}</span>}
        {description && <span className="text-caption-sm-regular text-tertiary">— {description}</span>}
        {action ? <span className="ml-auto self-center">{action}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function RowList({ children }: { children: React.ReactNode }) {
  return <div className="overflow-hidden rounded-lg border border-subtle bg-layer-1">{children}</div>;
}

export function EmptyRow({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-subtle px-4 py-8 text-center text-body-sm-regular text-tertiary">
      {label}
    </div>
  );
}
