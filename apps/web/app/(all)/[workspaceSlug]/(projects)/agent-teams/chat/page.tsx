/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file in the repository root for more details.
 *
 * 数字员工会话页（P2 一期）——薄壳：路由参数、会话数据装载与选中态机、
 * 发送/确认/分享编排。UI 全部在 components/agent-teams/chat/ 组件中：
 *   sidebars（一级团队折叠 / 二级会话列表）、message-bubble（消息与流式气泡）、
 *   chat-composer（GPT 形态输入区）、modals（新建会话选人 / 贴回卡片）。
 *
 * 两级导航（微信折叠群聊同构）：?team= 二级上下文；一级不选中任何会话。
 * 深链：?member=&expert=&team=&name=（成员行「发起对话」）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useTranslation } from "@plane/i18n";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { Breadcrumbs, ContentWrapper, Header } from "@plane/ui";
import { MessageSquare, Users } from "lucide-react";

import { AppHeader } from "@/components/core/app-header";
import { PageHead } from "@/components/core/page-title";
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { useAgentTeamsLinks } from "@/components/agent-teams/helper";
import { ChatComposer, type PendingAttachment } from "@/components/agent-teams/chat/chat-composer";
import { MessageBubble, StreamingBubble } from "@/components/agent-teams/chat/message-bubble";
import { ShareModal } from "@/components/agent-teams/chat/modals";
import { ConversationSidebar, TeamSidebar } from "@/components/agent-teams/chat/sidebars";
import {
  deriveActiveSession,
  type ChatDeepLink,
  type ChatMessage,
  type ChatSession,
  type StreamingAssistant,
} from "@/components/agent-teams/chat/types";
import chatService from "@/services/agent-teams/chat.service";
import { shareMessageToCard } from "@/services/agent-teams/agent-chat.service";
import { useWorkspace } from "@/hooks/store/use-workspace";

function AgentTeamsChatPage() {
  const { t } = useTranslation();
  const { currentWorkspace } = useWorkspace();
  const { agentTeamsPath } = useAgentTeamsLinks();
  const navigate = useNavigate();
  const { workspaceSlug: slugParam } = useParams<{ workspaceSlug: string }>();
  const workspaceSlug = slugParam ?? "";
  const [searchParams] = useSearchParams();
  const link: ChatDeepLink = {
    member: searchParams.get("member") ?? undefined,
    expert: searchParams.get("expert") ?? undefined,
    team: searchParams.get("team") ?? undefined,
    name: searchParams.get("name") ?? undefined,
  };
  const inTeamView = Boolean(link.team);

  const pageTitle = currentWorkspace?.name ? `${currentWorkspace?.name} - ${t("agent_teams_chat_title")}` : undefined;

  // ── 会话域状态 ────────────────────────────────────────────────
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<StreamingAssistant | null>(null);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [confirmBusy, setConfirmBusy] = useState("");
  const [summaryHintShownFor, setSummaryHintShownFor] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);

  // 弹层
  const [shareMessage, setShareMessage] = useState<ChatMessage | null>(null);
  const [shareBusy, setShareBusy] = useState(false);

  // 一级（团队层）不显示会话内容——选中会话仅存在于二级（两级导航不变量）
  const active = inTeamView ? sessions.find((s) => s.id === activeId) : undefined;
  const teamSessions = link.team ? sessions.filter((s) => s.teamId === link.team) : [];
  const teamName = active?.teamName ?? teamSessions[0]?.teamName;

  // ── 会话装载 + 选中态机 ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const list = await chatService.listSessions(workspaceSlug);
        if (cancelled) return;
        setSessions(list);
        const { nextActiveId, sessionToCreate } = deriveActiveSession(list, link, activeId);
        if (sessionToCreate) {
          const created = await chatService.createSession(
            workspaceSlug,
            sessionToCreate
          );
          if (cancelled) return;
          setSessions((prev) => [created, ...prev]);
          setActiveId(created.id);
        } else {
          setActiveId(nextActiveId);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // link 各字段来自 searchParams；activeId 经 deriveActiveSession 语义化读取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug, link.member, link.expert, link.team, link.name]);

  // 打开会话：拉历史 + 标记已读 + 摘要提示限时淡出
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    void chatService.listMessages(workspaceSlug, activeId).then((list) => {
      setMessages(list);
      return null;
    });
    void chatService.markRead(workspaceSlug, activeId).then(() => {
      setSessions((prev) => prev.map((s) => (s.id === activeId ? { ...s, unread: false } : s)));
      return null;
    });
    const timer = setTimeout(() => setSummaryHintShownFor(activeId), 8000);
    return () => clearTimeout(timer);
  }, [activeId, workspaceSlug]);

  // 流式输出时钉在最新内容
  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [messages, streaming]);

  // 切换/离开会话时中止在途流
  useEffect(() => () => abortRef.current?.abort(), [activeId]);

  // ── 发送（乐观插入 + 流式 + 完成收敛） ───────────────────────
  const handleSend = useCallback(
    async (text: string, attachments: PendingAttachment[], webSearch: boolean) => {
      if (!activeId || sending) return;
      const attachmentIds = attachments.map((f) => f.id);
      const now = new Date().toISOString();
      setSending(true);
      setMessages((prev) => [
        ...prev,
        {
          id: `local_${Date.now()}_u`, role: "user", kind: "text",
          content: { text },
          attachments: attachments.map((f) => ({ id: f.id, name: f.name })),
          streamingOffset: 0, createdAt: now,
        },
      ]);
      setStreaming({ id: `local_${Date.now()}_a`, text: "", sourceCount: 0 });
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await chatService.streamTurn(
          workspaceSlug,
          activeId,
          text,
          {
            signal: controller.signal,
            webSearchEnabled: webSearch,
            onToken: (token) => setStreaming((prev) => (prev ? { ...prev, text: prev.text + token } : prev)),
            onError: (normalized) => setStreaming((prev) => (prev ? { ...prev, error: normalized } : prev)),
          },
          attachmentIds
        );
        // 完成后以后端为准拉全量（确认卡/流程卡等结构化 kind）
        const list = await chatService.listMessages(workspaceSlug, activeId);
        setMessages(list);
        setStreaming(null);
        // 在场即读 + 列表预览刷新（活跃会话未读恒清）
        void chatService
          .markRead(workspaceSlug, activeId)
          .then(() => chatService.listSessions(workspaceSlug))
          .then((fresh) => {
            setSessions((prev) =>
              prev.map((s) => {
                const hit = fresh.find((n) => n.id === s.id);
                return hit ? (s.id === activeId ? { ...hit, unread: false } : hit) : s;
              })
            );
            return null;
          });
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          // 失败收敛：partial + 错误折成一条历史消息（不留悬挂空气泡）
          setStreaming((current) => {
            if (current) {
              setMessages((prev) => [
                ...prev,
                {
                  id: current.id, role: "agent", kind: "text",
                  content: {
                    text: current.text,
                    error: { code: "network", detail: t("agent_teams_chat_send_failed") },
                  },
                  attachments: [], streamingOffset: 0, createdAt: new Date().toISOString(),
                },
              ]);
            }
            return null;
          });
        }
      } finally {
        setSending(false);
        abortRef.current = null;
      }
    },
    [activeId, sending, workspaceSlug, t]
  );

  const handleStop = useCallback(() => abortRef.current?.abort(), []);

  // ── 确认卡（L1：确认创建走闸门链 / 取消） ────────────────────
  const handleConfirmCard = useCallback(
    async (messageId: string, action: "confirm" | "cancel") => {
      if (!activeId) return;
      setConfirmBusy(messageId);
      try {
        await chatService.confirmCard(workspaceSlug, activeId, messageId, action);
        setMessages(await chatService.listMessages(workspaceSlug, activeId));
      } catch (err) {
        const msg = (err as Error).message || "";
        const detail = msg.includes("PROJECT_NOT_BOUND")
          ? t("agent_teams_chat_confirm_not_bound")
          : msg.includes("PROJECT_AMBIGUOUS")
            ? t("agent_teams_chat_confirm_ambiguous")
            : msg.includes("CONFIRM_SETTLED")
              ? t("agent_teams_chat_confirm_settled")
              : t("agent_teams_chat_error");
        setToast({ type: TOAST_TYPE.ERROR, title: t("common.error"), message: detail });
      } finally {
        setConfirmBusy("");
      }
    },
    [workspaceSlug, activeId, t]
  );

  // ── 预算检查点三选（继续/转流程卡 → 预填输入；停止 → 保留 partial） ──
  const [prefill, setPrefill] = useState<{ text: string; nonce: number }>();
  const handleCheckpoint = useCallback(
    (option: "continue" | "convert" | "stop") => {
      if (option === "stop") return;
      setPrefill({
        text: option === "continue"
          ? `${t("agent_teams_chat_continue")}——`
          : t("agent_teams_chat_convert_prompt"),
        nonce: Date.now(),
      });
    },
    [t]
  );

  // ── 贴回卡片（弹层自持卡列表加载与后端检索；此处仅记录待分享消息） ──
  const openShare = useCallback((message: ChatMessage) => {
    setShareMessage(message);
  }, []);

  const handleShare = useCallback(
    async (issueId: string, issueName: string) => {
      if (!activeId || !shareMessage) return;
      setShareBusy(true);
      try {
        await shareMessageToCard(workspaceSlug, activeId, shareMessage.id, issueId);
        setToast({
          type: TOAST_TYPE.SUCCESS,
          title: t("common.success"),
          message: t("agent_teams_chat_shared", { name: issueName }),
        });
        setShareMessage(null);
        // 拉回消息：后端已落「已分享」回执（flow_card），不刷新则看不到
        setMessages(await chatService.listMessages(workspaceSlug, activeId));
      } catch {
        setToast({ type: TOAST_TYPE.ERROR, title: t("common.error"), message: t("agent_teams_chat_error") });
      } finally {
        setShareBusy(false);
      }
    },
    [workspaceSlug, activeId, shareMessage, t]
  );

  return (
    <>
      <PageHead title={pageTitle} />
      <div className="flex h-full w-full flex-col overflow-hidden">
        <AppHeader
          header={
            <Header>
              <Header.LeftItem>
                <Breadcrumbs>
                  {!inTeamView && (
                    <Breadcrumbs.Item
                      component={
                        <BreadcrumbLink
                          label={t("agent_teams_breadcrumb")}
                          href={agentTeamsPath}
                          icon={<Users className="size-4 text-tertiary" />}
                        />
                      }
                    />
                  )}
                  {inTeamView && (
                    <Breadcrumbs.Item
                      component={
                        <BreadcrumbLink
                          label={teamName ?? ""}
                          href={`/${workspaceSlug}/agent-teams/${link.team}`}
                          icon={<Users className="size-4 text-tertiary" />}
                        />
                      }
                    />
                  )}
                  <Breadcrumbs.Item
                    component={
                      <BreadcrumbLink
                        label={t("agent_teams_chat_title")}
                        icon={<MessageSquare className="size-4 text-tertiary" />}
                      />
                    }
                  />
                </Breadcrumbs>
              </Header.LeftItem>

            </Header>
          }
        />
        <ContentWrapper>
          <div className="flex h-full w-full overflow-hidden">
            {inTeamView ? (
              <ConversationSidebar
                sessions={teamSessions}
                activeId={activeId}
                loading={loading}
                onBack={() => {
                  setActiveId("");
                  navigate(`/${workspaceSlug}/agent-teams/chat`);
                }}
                onSelect={setActiveId}
              />
            ) : (
              <TeamSidebar
                sessions={sessions}
                loading={loading}
                onOpenTeam={(teamId) => navigate(`/${workspaceSlug}/agent-teams/chat?team=${teamId}`)}
              />
            )}

            {/* 消息流 + 输入区（仅二级选中会话时） */}
            <div className="flex h-full min-w-0 flex-grow flex-col">
              {active ? (
                <>
                  <div ref={streamRef} className="flex min-h-0 flex-grow flex-col gap-5 overflow-y-auto p-5">
                    {messages.length === 0 && !streaming && (
                      <div className="m-auto text-body-sm-regular text-tertiary">{t("agent_teams_chat_empty")}</div>
                    )}
                    {messages.map((message) => (
                      <MessageBubble
                        key={message.id}
                        message={message}
                        busy={confirmBusy === message.id}
                        onConfirmCard={handleConfirmCard}
                        onCheckpoint={handleCheckpoint}
                        onShare={(m) => void openShare(m)}
                        onOpenCard={(projectId, issueId) =>
                          navigate(`/${workspaceSlug}/projects/${projectId}/issues/${issueId}`)
                        }
                      />
                    ))}
                    {streaming && <StreamingBubble streaming={streaming} onCheckpoint={handleCheckpoint} />}
                  </div>
                  <ChatComposer
                    workspaceSlug={workspaceSlug}
                    disabled={!active}
                    sending={sending}
                    showSummaryHint={Boolean(active.summaryCompacted) && summaryHintShownFor !== active.id}
                    onStop={handleStop}
                    onSend={handleSend}
                    prefill={prefill}
                  />
                </>
              ) : (
                <div className="m-auto text-body-sm-regular text-tertiary">
                  {t(inTeamView ? "agent_teams_chat_no_session" : "agent_teams_chat_pick_team")}
                </div>
              )}
            </div>
          </div>
        </ContentWrapper>
      </div>

      <ShareModal
        open={Boolean(shareMessage)}
        workspaceSlug={workspaceSlug}
        teamId={active?.teamId}
        busy={shareBusy}
        onClose={() => setShareMessage(null)}
        onShare={(issueId, name) => void handleShare(issueId, name)}
      />
    </>
  );
}

export default observer(AgentTeamsChatPage);
