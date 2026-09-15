/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt in the repository root for details.
 *
 * Agent Teams extension — shared markdown renderer. prose (Tailwind
 * Typography) owns the whole document rhythm — headings, lists, quotes,
 * code, tables — instead of per-tag hand styles; GFM via remark-gfm for
 * tables/strikethrough. Used by the artifact preview modal, the approval
 * inbox question body, and the notifications "team approvals" detail pane.
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@plane/utils";

export function MarkdownPreview({ content, className = "" }: { content: string; className?: string }) {
  return (
    <div
      className={cn(
        "prose prose-sm dark:prose-invert max-w-none prose-headings:text-primary prose-p:text-secondary prose-strong:text-primary prose-code:text-secondary prose-th:text-primary prose-td:text-secondary",
        className
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
