/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — conversation service, wired to the REAL v1 chat
 * API (migrated verbatim from the retired user app; no mocks). Endpoints:
 *   GET/POST   /api/v1/chat/sessions           (list / create, expert-bound)
 *   PATCH      /api/v1/chat/sessions/{id}/archive|title|pin
 *   DELETE     /api/v1/chat/sessions/{id}
 *   GET        /api/v1/chat/sessions/{id}/messages
 *   POST       /api/v1/chat/sessions/{id}/turns (SSE stream, token deltas)
 *
 * Auth: the §12.6.7 BFF (shared experts-auth module) exchanges the Plane
 * session for a short-lived Runtime user token — no env tokens in the
 * browser. This module only keeps the SSE fetch (the one path axios
 * interceptors can't cover).
 */
import { create as axiosCreate, type AxiosInstance } from "axios";
import { expertsBaseUrl, expertsAuthHeaders, invalidateExpertsAuth } from "./experts-auth";
import {
  buildToolTraceItem,
  readErrorMessage,
  readSourceCount,
  readTextDelta,
  readToolProgress,
  readTraceText,
  parseSseMessage,
  STREAM_IDLE_TIMEOUT_MS,
} from "./chat-stream";

const BASE_URL = expertsBaseUrl();

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt?: string;
};

export type ChatSession = {
  id: string;
  title?: string | null;
  // Owning agent member (server-side expert binding from the old app).
  expertId?: string | null;
  expertName?: string | null;
  status?: string;
  updatedAt?: string;
};

// The v1 API is lenient (array | {data|records|items|...}) — normalize once.
function unwrapList<T>(payload: unknown, keys: string[]): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (Array.isArray(value)) return value as unknown as T[];
      if (value && typeof value === "object") {
        const nested = unwrapList<T>(value, keys);
        if (nested.length > 0) return nested;
      }
    }
  }
  return [];
}

function messageContent(raw: Record<string, unknown>): string {
  return (
    (raw.responseText as string) ??
    (raw.response_text as string) ??
    (raw.content as string) ??
    (raw.text as string) ??
    ""
  );
}

export class ChatService {
  private http: AxiosInstance;

  constructor() {
    // Deliberately NOT extending APIService: its 401 interceptor redirects to
    // the Plane login (redirect loop against the v1 backend). We refresh
    // silently instead.
    this.http = axiosCreate({ baseURL: BASE_URL });
  }

  /** Request with one silent re-exchange + retry on 401 (§12.6.7 BFF). */
  private async request<T>(fn: (headers: Record<string, string>) => Promise<T>): Promise<T> {
    try {
      return await fn(await expertsAuthHeaders());
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 401) {
        invalidateExpertsAuth();
        return await fn(await expertsAuthHeaders());
      }
      throw error;
    }
  }

  async listSessions(status: "active" | "archived" = "active"): Promise<ChatSession[]> {
    const payload = await this.request((headers) =>
      this.http.get<unknown>("/api/v1/chat/sessions", { params: { status }, headers }).then((r) => r.data)
    );
    return unwrapList<ChatSession>(payload, ["data", "records", "items", "sessions"]).map((session) => {
      const normalized = Object.assign({}, session);
      normalized.id = String(session.id ?? (session as { sessionId?: unknown }).sessionId ?? "");
      return normalized;
    });
  }

  async createSession(input: {
    title?: string;
    expertId?: string | null;
    expertName?: string | null;
  }): Promise<ChatSession> {
    const payload = await this.request((headers) =>
      this.http
        .post<unknown>(
          "/api/v1/chat/sessions",
          {
            title: input.title,
            // Server-side expert binding enables capability-aware sessions.
            ...(input.expertId ? { expertId: input.expertId, expertName: input.expertName ?? undefined } : {}),
          },
          { headers }
        )
        .then((r) => r.data)
    );
    const session = ((payload as { data?: ChatSession })?.data ?? payload) as ChatSession;
    return { ...session, id: String(session.id) };
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request((headers) =>
      this.http.delete(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}`, { headers })
    );
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    await this.request((headers) =>
      this.http.patch(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/archive`, { archived }, { headers })
    );
  }

  async listMessages(sessionId: string): Promise<ChatMessage[]> {
    const payload = await this.request((headers) =>
      this.http
        .get<unknown>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/messages`, { headers })
        .then((r) => r.data)
    );
    const turns = unwrapList<Record<string, unknown>>(payload, ["data", "records", "items", "messages"]);
    // History rows are TURN records carrying a request/response pair —
    // expand each into a user message followed by an assistant message.
    const messages: ChatMessage[] = [];
    for (const [index, raw] of turns.entries()) {
      const id = String(raw.id ?? raw.messageId ?? index);
      const createdAt = (raw.createdAt as string) ?? (raw.created_at as string);
      const request = (raw.requestText as string) ?? (raw.request_text as string) ?? "";
      const response = messageContent(raw);
      if (request) messages.push({ id: `${id}_u`, role: "user", content: request, createdAt });
      if (response) messages.push({ id: `${id}_a`, role: "assistant", content: response, createdAt });
    }
    return messages;
  }

  /**
   * Submit a turn and stream the assistant answer — the old app's
   * streamChatTurn, verbatim semantics: same endpoint, same SSE event
   * vocabulary (tokens, reasoning/tool trace, sources, live title), plus
   * idle-timeout abort. Resolves when the stream completes.
   */
  async streamTurn(
    sessionId: string,
    question: string,
    callbacks: {
      onToken: (text: string) => void;
      onTrace?: (item: import("./chat-stream").AssistantTraceItem) => void;
      onSourceCount?: (count: number) => void;
      onTitle?: (title: string) => void;
      onActive?: () => void;
      webSearchEnabled?: boolean;
      attachmentFileIds?: string[];
      signal?: AbortSignal;
    }
  ): Promise<void> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    callbacks.signal?.addEventListener("abort", onAbort);

    try {
      const postTurn = async () =>
        fetch(`${BASE_URL}/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns`, {
          method: "POST",
          headers: {
            Accept: "text/event-stream",
            "Content-Type": "application/json",
            ...(await expertsAuthHeaders()),
          },
          body: JSON.stringify({
            question,
            ...(callbacks.webSearchEnabled ? { webSearchEnabled: true } : {}),
            ...(callbacks.attachmentFileIds?.length ? { attachmentFileIds: callbacks.attachmentFileIds } : {}),
          }),
          signal: controller.signal,
        });

      let response = await postTurn();
      if (response.status === 401) {
        // Silent re-exchange + one retry — same lifecycle as the old app.
        invalidateExpertsAuth();
        response = await postTurn();
      }
      if (!response.ok || !response.body) {
        throw Object.assign(new Error(`chat turn failed: ${response.status}`), { status: response.status });
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // SSE chunks must be consumed in order — sequential awaits are the point.
      /* eslint-disable no-await-in-loop */
      while (true) {
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        const readResult = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            idleTimer = setTimeout(() => {
              controller.abort();
              reject(new Error("stream idle timeout"));
            }, STREAM_IDLE_TIMEOUT_MS);
          }),
        ]);
        if (idleTimer) clearTimeout(idleTimer);

        const { done, value } = readResult;
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const raw = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 2);
          if (raw) {
            const { event, data } = parseSseMessage(raw);
            let payload: Record<string, unknown> | null = null;
            try {
              payload = data ? (JSON.parse(data) as Record<string, unknown>) : null;
            } catch {
              payload = null;
            }

            const isActive =
              event === "message_delta" ||
              event === "token" ||
              event === "delta" ||
              event === "reasoning_delta" ||
              event === "session_usage_update";
            if (isActive) callbacks.onActive?.();

            if (event === "token" || event === "message_delta" || event === "delta") {
              const token = readTextDelta(payload);
              if (token) callbacks.onToken(token);
            }
            if (event === "reasoning_delta" || event === "reasoning" || event === "thinking" || event === "thought") {
              const text = readTraceText(payload);
              if (text) callbacks.onTrace?.({ kind: "thinking", text });
            }
            if (event === "tool_call_update") {
              const item = readToolProgress(payload);
              if (item) callbacks.onTrace?.(item);
            }
            if (event === "tool_call" || event === "tool_result") {
              callbacks.onTrace?.(buildToolTraceItem(payload, event === "tool_result"));
            }
            if (event === "retrieval" || event === "citation" || event === "sources") {
              const count = readSourceCount(payload);
              if (typeof count === "number") callbacks.onSourceCount?.(count);
            }
            if (event === "session_title_updated") {
              const title = typeof payload?.title === "string" ? payload.title.trim() : "";
              if (title) callbacks.onTitle?.(title);
            }
            if (event === "error" || event === "turn_failed") {
              throw new Error(readErrorMessage(payload) || "generation failed");
            }
            if (event === "stop" || event === "cancelled" || event === "turn_completed") {
              return;
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
      /* eslint-enable no-await-in-loop */
    } finally {
      callbacks.signal?.removeEventListener("abort", onAbort);
    }
  }
}

const chatService = new ChatService();

export default chatService;
