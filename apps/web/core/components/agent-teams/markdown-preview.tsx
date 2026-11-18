/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt in the repository root for details.
 *
 * Agent Teams extension — shared markdown renderer. prose (Tailwind
 * Typography) owns the whole document rhythm — headings, lists, quotes,
 * code, tables — instead of per-tag hand styles; GFM via remark-gfm for
 * tables/strikethrough. Used by the artifact preview modal, the approval
 * inbox question body, the notifications "team approvals" detail pane,
 * and the chat message bubbles.
 *
 * 溢出防护（GitHub/ChatGPT 同款）：宽表格与代码块包横向滚动容器，
 * 窄屏不撑破父容器；长词/URL 由 break-words 断行。
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@plane/utils";

export function MarkdownPreview({ content, className = "" }: { content: string; className?: string }) {
  return (
    <div
      className={cn(
        "prose prose-sm dark:prose-invert max-w-none break-words prose-headings:text-primary prose-p:text-secondary prose-strong:text-primary prose-code:text-secondary prose-th:text-primary prose-td:text-secondary",
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 表格：先压缩后滚动（GitHub/ChatGPT 同款）——w-full 优先适配
          // 容器（单元格内容换行压缩列宽），压缩后仍放不下才横向滚动
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full">{children}</table>
            </div>
          ),
          // 代码块：同样横向滚动（等宽内容不强制换行）
          pre: ({ children }) => (
            <div className="overflow-x-auto">
              <pre>{children}</pre>
            </div>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
