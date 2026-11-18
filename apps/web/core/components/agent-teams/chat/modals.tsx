/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file in the repository root for more details.
 *
 * 贴回卡片弹层（§产物管理）。交互与视觉复用项目成熟 issue 选择器
 * （core/modals/existing-issues-list-modal）——Headless Combobox + 状态色点 +
 * IssueIdentifier 标准卡标识 + 卡名。数据 = 团队绑定项目的全部卡（含终态，
 * 评论留痕不限对象状态；执行中=贴上去会被员工自取的加成）。搜索走后端检索
 *（防抖），keyset 游标分页，滚动到底自动加载更多。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Combobox } from "@headlessui/react";
import { useTranslation } from "@plane/i18n";
import { EModalWidth, Loader, ModalCore } from "@plane/ui";
import { SearchIcon } from "@plane/propel/icons";
import { IssueIdentifier } from "@/components/issues/issue-detail/issue-identifier";

import { listTeamShareableIssues, type ShareableIssue } from "@/services/agent-teams/orchestration.service";
import useDebounce from "@/hooks/use-debounce";

export function ShareModal({
  open,
  workspaceSlug,
  teamId,
  busy,
  onClose,
  onShare,
}: {
  open: boolean;
  workspaceSlug: string;
  teamId: string | undefined;
  busy: boolean;
  onClose: () => void;
  onShare: (issueId: string, issueName: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [cards, setCards] = useState<ShareableIssue[]>([]);
  const [nextCursor, setNextCursor] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const debouncedQuery = useDebounce(query, 300);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 首页加载（打开 / query 变化时重置并拉取第一页）
  const loadFirstPage = useCallback(async () => {
    if (!teamId) return;
    setLoading(true);
    const page = await listTeamShareableIssues(workspaceSlug, teamId, debouncedQuery).catch(
      () => ({ items: [] as ShareableIssue[], nextCursor: "", hasMore: false })
    );
    setCards(page.items);
    setNextCursor(page.nextCursor);
    setHasMore(page.hasMore);
    setLoading(false);
  }, [workspaceSlug, teamId, debouncedQuery]);

  useEffect(() => {
    if (!open) return;
    void loadFirstPage();
  }, [open, loadFirstPage]);

  // 加载更多（滚动到底）
  const loadMore = useCallback(async () => {
    if (!teamId || !hasMore || loadingMore || loading) return;
    setLoadingMore(true);
    const page = await listTeamShareableIssues(workspaceSlug, teamId, debouncedQuery, nextCursor).catch(
      () => ({ items: [] as ShareableIssue[], nextCursor: "", hasMore: false })
    );
    setCards((prev) => [...prev, ...page.items]);
    setNextCursor(page.nextCursor);
    setHasMore(page.hasMore);
    setLoadingMore(false);
  }, [workspaceSlug, teamId, debouncedQuery, nextCursor, hasMore, loadingMore, loading]);

  // 滚动到底部自动加载更多
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
      void loadMore();
    }
  }, [loadMore]);

  const liveStatus = useMemo(() => new Set(["running", "waiting_human"]), []);

  return (
    <ModalCore isOpen={open} handleClose={onClose} width={EModalWidth.MD}>
      <div className="flex flex-col p-2">
        <div className="flex flex-col gap-2 px-2 pt-2 pb-3">
          <div className="text-sm font-medium">{t("agent_teams_chat_share")}</div>
          <div className="flex items-center gap-2 rounded-md border border-subtle bg-layer-1 px-2.5 py-1.5">
            <SearchIcon className="size-4 text-tertiary" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("agent_teams_chat_share_search")}
              className="w-full bg-transparent text-body-sm-regular outline-none"
            />
          </div>
        </div>

        <Combobox value={null} onChange={() => undefined} as="div">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="vertical-scrollbar scrollbar-md max-h-80 scroll-py-2 overflow-y-auto"
          >
            {loading ? (
              <Loader className="space-y-3 p-3">
                <Loader.Item height="40px" />
                <Loader.Item height="40px" />
                <Loader.Item height="40px" />
              </Loader>
            ) : cards.length === 0 ? (
              <div className="px-3 py-8 text-center text-body-sm-regular text-tertiary">
                {t("agent_teams_chat_share_empty")}
              </div>
            ) : (
              <>
                <ul className="p-2 text-13 text-primary">
                  {cards.map((card) => {
                    const live = card.controlStatus ? liveStatus.has(card.controlStatus) : false;
                    return (
                      <Combobox.Option
                        key={card.issueId}
                        as="button"
                        value={card}
                        disabled={busy}
                        onClick={() => onShare(card.issueId, card.taskName)}
                        className={({ active }) =>
                          `group my-0.5 flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left text-secondary select-none ${
                            active ? "bg-layer-1 text-primary" : ""
                          }`
                        }
                      >
                        <span
                          className="block size-1.5 flex-shrink-0 rounded-full"
                          style={{ backgroundColor: card.stateColor ?? "var(--text-color-tertiary)" }}
                        />
                        <IssueIdentifier
                          projectId={card.externalProjectId}
                          projectIdentifier={card.projectIdentifier}
                          issueSequenceId={card.sequenceId}
                          variant="secondary"
                        />
                        <span className="min-w-0 flex-1 truncate">{card.taskName}</span>
                        {live && (
                          <span className="shrink-0 rounded-full bg-accent-subtle px-2 py-0.5 text-caption-sm-regular text-accent-primary">
                            {t("agent_teams_chat_share_live")}
                          </span>
                        )}
                      </Combobox.Option>
                    );
                  })}
                </ul>
                {loadingMore && (
                  <div className="flex justify-center py-2">
                    <Loader className="space-y-0">
                      <Loader.Item height="24px" width="24px" />
                    </Loader>
                  </div>
                )}
              </>
            )}
          </div>
        </Combobox>
      </div>
    </ModalCore>
  );
}
