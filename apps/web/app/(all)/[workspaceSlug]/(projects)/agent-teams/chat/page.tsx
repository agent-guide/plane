/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — conversation page, feature-aligned with the retired
 * user app's dialogue (backend reused as-is): SSE streaming with reasoning/
 * tool trace, source citations count, live session titles, stop generation,
 * web-search toggle, copy, markdown rendering. Member deep links carry
 * ?member=<expertId>&name=<display>; free dialogue starts a blank session.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
// plane imports
import { Button } from "@plane/propel/button";
import { useTranslation } from "@plane/i18n";
import { Breadcrumbs, ContentWrapper, Header } from "@plane/ui";
// icons
import { Bot, Globe, MessageSquare, Plus, Send, Users } from "lucide-react";
// components
import { AppHeader } from "@/components/core/app-header";
import { PageHead } from "@/components/core/page-title";
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { useAgentTeamsLinks } from "@/components/agent-teams/helper";
// services
import chatService, { type ChatMessage, type ChatSession } from "@/services/agent-teams/chat.service";
import {
  appendUniqueTraceItems,
  mergeTraceText,
  normalizeMarkdownForDisplay,
  type AssistantTraceItem,
} from "@/services/agent-teams/chat-stream";
// hooks
import { useWorkspace } from "@/hooks/store/use-workspace";

/** In-flight assistant message with trace channels (old app's shape). */
type StreamingAssistant = {
  id: string;
  text: string;
  traceItems: AssistantTraceItem[];
  sourceCount: number;
};

function AgentTeamsChatPage() {
  const { t } = useTranslation();
  const { currentWorkspace } = useWorkspace();
  const { agentTeamsPath } = useAgentTeamsLinks();
  const searchParams = useSearchParams();
  const memberParam = searchParams.get("member");
  const nameParam = searchParams.get("name");
  // derived values
  const pageTitle = currentWorkspace?.name ? `${currentWorkspace?.name} - ${t("agent_teams_chat_title")}` : undefined;

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [streaming, setStreaming] = useState<StreamingAssistant | null>(null);
  const [copiedId, setCopiedId] = useState("");
  const [titleHints, setTitleHints] = useState<Record<string, string>>({});
  const streamRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const list = await chatService.listSessions();
      setSessions(list);
      // Member deep link: open the existing member session or create one.
      if (memberParam) {
        const existing = list.find((s) => s.expertId === memberParam);
        if (existing) {
          setActiveId(existing.id);
        } else {
          const created = await chatService.createSession({
            title: nameParam ?? t("agent_teams_chat_new_session"),
            expertId: memberParam,
            expertName: nameParam ?? null,
          });
          setSessions((prev) => [created, ...prev]);
          setActiveId(created.id);
        }
      } else if (!activeId && list.length > 0) {
        setActiveId(list[0].id);
      }
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberParam, nameParam]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  // Load history when the active session changes.
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    void chatService.listMessages(activeId).then(setMessages);
  }, [activeId]);

  // Keep the stream pinned to the latest content.
  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [messages, streaming]);

  // Abort the in-flight stream when leaving or switching sessions.
  useEffect(() => () => abortRef.current?.abort(), [activeId]);

  const applyTrace = useCallback((item: AssistantTraceItem) => {
    setStreaming((prev) => {
      if (!prev) return prev;
      // Same merge semantics as the old app: same-kind text traces merge,
      // tool items dedupe by id/name.
      if (item.kind === "thinking") {
        const items = [...prev.traceItems];
        const last = items[items.length - 1];
        if (last && last.kind === "thinking") {
          items[items.length - 1] = { ...last, text: mergeTraceText(last.text, item.text) };
        } else {
          items.push(item);
        }
        return { ...prev, traceItems: items };
      }
      // appendUniqueTraceItems mutates its target in place (old app semantics).
      const items = [...prev.traceItems];
      appendUniqueTraceItems(items, [item]);
      return { ...prev, traceItems: items };
    });
  }, []);

  const handleSend = useCallback(async () => {
    const content = draft.trim();
    if (!content || !activeId || sending) return;
    setSending(true);
    setDraft("");
    const userMessage: ChatMessage = { id: `local_${Date.now()}_u`, role: "user", content };
    setMessages((prev) => [...prev, userMessage]);
    setStreaming({ id: `local_${Date.now()}_a`, text: "", traceItems: [], sourceCount: 0 });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await chatService.streamTurn(activeId, content, {
        signal: controller.signal,
        webSearchEnabled: webSearch,
        onToken: (token) => setStreaming((prev) => (prev ? { ...prev, text: prev.text + token } : prev)),
        onTrace: applyTrace,
        onSourceCount: (count) => setStreaming((prev) => (prev ? { ...prev, sourceCount: count } : prev)),
        onTitle: (title) => setTitleHints((prev) => ({ ...prev, [activeId]: title })),
      });
      // Fold the completed stream into history.
      setStreaming((current) => {
        if (current?.text) {
          const completed: ChatMessage = { id: current.id, role: "assistant", content: current.text };
          setMessages((prev) => [...prev, completed]);
        }
        return null;
      });
      void chatService.listSessions().then(setSessions);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setStreaming((current) => {
          const text = current?.text || t("agent_teams_chat_send_failed");
          setMessages((prev) => [
            ...prev,
            { id: current?.id ?? `local_${Date.now()}_e`, role: "assistant", content: text },
          ]);
          return null;
        });
      }
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }, [draft, activeId, sending, webSearch, applyTrace, t]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleCopy = useCallback(async (id: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedId(id);
      setTimeout(() => setCopiedId(""), 1500);
    } catch {
      // Clipboard unavailable — silently ignore (old app alerted).
    }
  }, []);

  const handleNewSession = useCallback(async () => {
    const created = await chatService.createSession({ title: t("agent_teams_chat_new_session") });
    setSessions((prev) => [created, ...prev]);
    setActiveId(created.id);
  }, [t]);

  const active = sessions.find((s) => s.id === activeId);

  const assistantBody = (text: string) => (
    <div className="text-body-sm-regular break-words [&_p]:mb-2 [&_pre]:rounded [&_pre]:bg-layer-3 [&_pre]:p-2">
      <ReactMarkdown>{normalizeMarkdownForDisplay(text)}</ReactMarkdown>
    </div>
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
                  <Breadcrumbs.Item
                    component={
                      <BreadcrumbLink
                        label="Agent Teams"
                        href={agentTeamsPath}
                        icon={<Users className="size-4 text-tertiary" />}
                      />
                    }
                  />
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
              <Header.RightItem>
                {/* Free dialogue entry (migrated 自由对话) */}
                <Button variant="secondary" size="lg" prependIcon={<Plus />} onClick={() => void handleNewSession()}>
                  {t("agent_teams_chat_new_session")}
                </Button>
              </Header.RightItem>
            </Header>
          }
        />
        <ContentWrapper>
          <div className="flex h-full w-full overflow-hidden">
            {/* session list */}
            <aside className="w-full max-w-60 shrink-0 border-r border-subtle">
              {loading ? (
                <div className="p-4 text-body-sm-regular text-tertiary">{t("agent_teams_inbox_loading")}</div>
              ) : (
                <div className="flex flex-col">
                  {sessions.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => setActiveId(session.id)}
                      className={`flex w-full flex-col gap-0.5 border-b border-subtle px-3 py-2.5 text-left ${
                        session.id === activeId ? "bg-layer-2" : "hover:bg-layer-2-hover"
                      }`}
                    >
                      <span className="flex w-full items-center gap-1.5 truncate text-body-xs-medium">
                        {session.expertName && <Bot className="size-3 shrink-0 text-accent-primary" aria-hidden />}
                        {titleHints[session.id] ?? session.title}
                      </span>
                      <span className="truncate text-caption-sm-regular text-tertiary">
                        {session.expertName ?? t("agent_teams_chat_free")}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </aside>

            {/* message stream */}
            <div className="flex h-full min-w-0 flex-grow flex-col">
              {active ? (
                <>
                  <div ref={streamRef} className="flex min-h-0 flex-grow flex-col gap-3 overflow-y-auto p-4">
                    {messages.length === 0 && !streaming && (
                      <div className="m-auto text-body-sm-regular text-tertiary">{t("agent_teams_chat_empty")}</div>
                    )}
                    {messages.map((message) =>
                      message.role === "user" ? (
                        <div
                          key={message.id}
                          className="max-w-[80%] self-end rounded-lg bg-accent-subtle px-3 py-2 text-body-sm-regular text-primary"
                        >
                          {message.content}
                        </div>
                      ) : (
                        <div
                          key={message.id}
                          className="group max-w-[85%] self-start rounded-lg border border-subtle bg-layer-2 px-3 py-2"
                        >
                          {assistantBody(message.content)}
                          <button
                            type="button"
                            onClick={() => void handleCopy(message.id, message.content)}
                            className="mt-1 text-caption-sm-regular text-tertiary opacity-0 transition-opacity group-hover:opacity-100 hover:text-secondary"
                          >
                            {copiedId === message.id ? t("agent_teams_chat_copied") : t("agent_teams_chat_copy")}
                          </button>
                        </div>
                      )
                    )}
                    {streaming && (
                      <div className="max-w-[85%] self-start rounded-lg border border-subtle bg-layer-2 px-3 py-2">
                        {/* reasoning/tool trace channel */}
                        {streaming.traceItems.length > 0 && (
                          <div className="mb-2 flex flex-col gap-1">
                            {streaming.traceItems.map((item) => (
                              <div
                                key={item.id ?? item.text.slice(0, 24)}
                                className="flex items-start gap-1.5 text-caption-sm-regular text-tertiary"
                              >
                                <span
                                  className="mt-1.5 size-1 shrink-0 rounded-full"
                                  style={{ background: "var(--text-color-tertiary)" }}
                                  aria-hidden
                                />
                                {item.text}
                              </div>
                            ))}
                          </div>
                        )}
                        {streaming.text ? (
                          assistantBody(streaming.text)
                        ) : (
                          <div className="text-caption-sm-regular text-tertiary">{t("agent_teams_chat_typing")}</div>
                        )}
                        {streaming.sourceCount > 0 && (
                          <div className="mt-1 text-caption-sm-regular text-tertiary">
                            {t("agent_teams_chat_sources", { count: streaming.sourceCount })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  {/* composer */}
                  <div className="flex flex-col gap-1.5 border-t border-subtle p-3">
                    <div className="flex items-end gap-2">
                      <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            void handleSend();
                          }
                        }}
                        placeholder={t("agent_teams_chat_input_placeholder")}
                        rows={2}
                        className="focus:border-custom-border-200 min-h-10 w-full resize-none rounded-md border border-subtle bg-layer-1 px-3 py-2 text-body-sm-regular outline-none"
                      />
                      {sending ? (
                        <Button variant="secondary" size="lg" onClick={handleStop}>
                          {t("agent_teams_chat_stop")}
                        </Button>
                      ) : (
                        <Button
                          variant="primary"
                          size="lg"
                          appendIcon={<Send />}
                          disabled={!draft.trim()}
                          onClick={() => void handleSend()}
                        >
                          {t("agent_teams_chat_send")}
                        </Button>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => setWebSearch((prev) => !prev)}
                        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-caption-sm-medium ${
                          webSearch ? "bg-accent-subtle text-accent-primary" : "text-tertiary hover:text-secondary"
                        }`}
                      >
                        <Globe className="size-3" aria-hidden />
                        {t("agent_teams_chat_web_search")}
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="m-auto text-body-sm-regular text-tertiary">{t("agent_teams_chat_no_session")}</div>
              )}
            </div>
          </div>
        </ContentWrapper>
      </div>
    </>
  );
}

export default observer(AgentTeamsChatPage);
