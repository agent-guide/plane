/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — Approval Inbox (design §12.6.4; implementation §9).
 * Lists waiting human decisions across both HITL scopes (workflow human node
 * attempts and agent human requests) as a read-only projection; answering
 * routes to the scope-specific Runtime command endpoint — never a shared
 * state machine (implementation §2.6). Buttons submit Runtime Commands and
 * must not mutate Plane state directly.
 */
import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { Button } from "@plane/propel/button";
import { EModalPosition, EModalWidth, ModalCore, Breadcrumbs, ContentWrapper, Header, TextArea } from "@plane/ui";
import { useTranslation } from "@plane/i18n";
// icons
import { Bot, ChevronRight, Inbox, Users, Workflow } from "lucide-react";
// components
import { AppHeader } from "@/components/core/app-header";
import { PageHead } from "@/components/core/page-title";
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { agentTeamsPath } from "@/components/agent-teams/helper";
// services
import runtimeService, {
  getCurrentRuntimeIdentityId,
  type HumanInboxDetail,
  type HumanInboxItem,
} from "@/services/agent-teams/runtime.service";
// hooks
import { useWorkspace } from "@/hooks/store/use-workspace";

function AgentTeamsInboxPage() {
  const { t } = useTranslation();
  const { currentWorkspace } = useWorkspace();
  // derived values
  const pageTitle = currentWorkspace?.name ? `${currentWorkspace?.name} - ${t("agent_teams_inbox_title")}` : undefined;

  const [items, setItems] = useState<HumanInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  // Error stored as a key and translated at render time — the i18n `t` is
  // not referentially stable, so keeping it out of effect deps avoids a
  // refetch loop (and the loading flicker it caused).
  const [errorKey, setErrorKey] = useState<"load" | "answer" | "">("");
  const [detail, setDetail] = useState<HumanInboxDetail | null>(null);
  // Decoupled from `detail`: closing only collapses the dialog — content
  // stays mounted through the 200ms exit transition instead of flashing an
  // empty white panel (other ModalCore consumers keep children mounted too).
  const [modalOpen, setModalOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [answering, setAnswering] = useState("");
  const [assignedToMeOnly, setAssignedToMeOnly] = useState(false);
  const [textAnswer, setTextAnswer] = useState("");

  const loadInbox = useCallback(async () => {
    setLoading(true);
    setErrorKey("");
    try {
      setItems(await runtimeService.listHumanInbox());
    } catch {
      setErrorKey("load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadInbox();
  }, [loadInbox]);

  const openDetail = useCallback(async (item: HumanInboxItem) => {
    // Optimistic open — render what the list projection already knows, so
    // the dialog is never a blank/loading shell and stays closable while
    // the detail fetch is in flight.
    setDetailLoading(true);
    setModalOpen(true);
    setTextAnswer("");
    setDetail({
      scope: item.scope,
      requestId: item.requestId,
      taskBindingId: item.taskBindingId,
      assignedIdentityId: item.assignedIdentityId ?? null,
      title: item.title ?? null,
      status: item.status,
      kind: null,
    });
    try {
      setDetail(await runtimeService.getHumanInboxDetail(item));
    } catch {
      setErrorKey("load");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const handleAnswer = useCallback(
    async (value: string) => {
      if (!detail) return;
      if (detail.kind === "text" && !value.trim()) return;
      setAnswering(detail.kind === "text" ? "text" : value);
      try {
        const payload = detail.kind === "text" ? { text: value.trim() } : { value };
        await runtimeService.answerHumanInboxItem(
          { scope: detail.scope, requestId: detail.requestId } as HumanInboxItem,
          payload
        );
        setModalOpen(false);
        await loadInbox();
      } catch {
        setErrorKey("answer");
      } finally {
        setAnswering("");
      }
    },
    [detail, loadInbox]
  );

  const error =
    errorKey === "load"
      ? t("agent_teams_inbox_load_failed")
      : errorKey === "answer"
        ? t("agent_teams_inbox_answer_failed")
        : "";

  // Context keys are raw Runtime JSON field names — map the known ones to
  // translated labels and humanize the rest instead of showing camelCase.
  const contextLabel = (key: string) => {
    const i18nKey = `agent_teams_inbox_ctx_${key}`;
    const translated = t(i18nKey);
    if (translated !== i18nKey) return translated;
    return key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  };

  // Delivery enum values are contract codes — translate for display.
  const deliveryLabel = (status: string) => {
    const i18nKey = `agent_teams_inbox_delivery_${status}`;
    const translated = t(i18nKey);
    return translated !== i18nKey ? translated : status;
  };

  const scopeBadge = (item: HumanInboxItem) => (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-caption-sm-medium ${
        item.scope === "workflow" ? "bg-accent-subtle text-accent-primary" : "bg-danger-subtle text-danger-primary"
      }`}
    >
      {item.scope === "workflow" ? <Workflow className="size-3" aria-hidden /> : <Bot className="size-3" aria-hidden />}
      {item.scope === "workflow" ? t("agent_teams_inbox_scope_workflow") : t("agent_teams_inbox_scope_agent")}
    </span>
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
                        href={agentTeamsPath(currentWorkspace?.slug ?? "")}
                        icon={<Users className="size-4 text-tertiary" />}
                      />
                    }
                  />
                  <Breadcrumbs.Item
                    component={
                      <BreadcrumbLink
                        label={t("agent_teams_inbox_title")}
                        icon={<Inbox className="size-4 text-tertiary" />}
                      />
                    }
                  />
                </Breadcrumbs>
              </Header.LeftItem>
              <Header.RightItem>
                {/* Filter by assignedIdentityId — the inbox is shared, this
                    narrows it to decisions awaiting the current user. */}
                <Button
                  variant={assignedToMeOnly ? "primary" : "secondary"}
                  size="lg"
                  onClick={() => setAssignedToMeOnly((prev) => !prev)}
                >
                  {t("agent_teams_inbox_assigned_to_me")}
                </Button>
              </Header.RightItem>
            </Header>
          }
        />
        <ContentWrapper>
          <div className="flex h-full w-full flex-col gap-4 p-4">
            <p className="max-w-2xl text-body-xs-regular text-tertiary">{t("agent_teams_inbox_subtitle")}</p>
            {error && <div className="text-body-sm-regular text-danger-primary">{error}</div>}

            <div className="overflow-hidden rounded-lg border border-subtle bg-layer-1">
              {loading ? (
                <div className="p-10 text-center text-body-sm-regular text-tertiary">
                  {t("agent_teams_inbox_loading")}
                </div>
              ) : items.length === 0 ? (
                <div className="flex flex-col items-center gap-2 p-10 text-center">
                  <Inbox className="size-6 text-tertiary" aria-hidden />
                  <div className="text-body-sm-regular text-tertiary">{t("agent_teams_inbox_empty")}</div>
                </div>
              ) : (
                <ul>
                  {(assignedToMeOnly
                    ? items.filter((item) => item.assignedIdentityId === getCurrentRuntimeIdentityId())
                    : items
                  ).map((item, index) => (
                    <li key={`${item.scope}:${item.requestId}`} className={index > 0 ? "border-t border-subtle" : ""}>
                      <button
                        type="button"
                        onClick={() => void openDetail(item)}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-layer-2-hover"
                      >
                        <div className="flex min-w-0 flex-grow flex-col gap-1">
                          <div className="flex items-center gap-2">
                            {scopeBadge(item)}
                            <span className="truncate text-body-sm-medium">{item.title ?? item.requestId}</span>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-caption-sm-regular text-tertiary">
                              {t("agent_teams_inbox_task_ref", { id: item.taskBindingId })}
                            </span>
                            {item.scope === "agent" && item.deliveryStatus && (
                              <span className="text-caption-sm-regular text-tertiary">
                                {t("agent_teams_inbox_delivery", { status: deliveryLabel(item.deliveryStatus) })}
                              </span>
                            )}
                          </div>
                        </div>
                        <ChevronRight className="size-4 flex-shrink-0 text-tertiary" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </ContentWrapper>
      </div>

      <ModalCore
        isOpen={modalOpen && detail !== null}
        handleClose={() => setModalOpen(false)}
        position={EModalPosition.CENTER}
        width={EModalWidth.SM}
      >
        <div className="flex w-full flex-col px-6 pt-6 pb-5">
          {detail ? (
            <>
              {/* header — item name is context, not the focus */}
              <div className="flex items-center gap-2">
                {scopeBadge({ scope: detail.scope } as HumanInboxItem)}
                <span className="truncate text-body-sm-medium text-secondary">{detail.title}</span>
              </div>
              {detailLoading ? (
                // question/context/options arrive with the detail fetch —
                // skeleton until then
                <div className="mt-4 flex flex-col gap-2">
                  <div className="h-4 w-3/4 animate-pulse rounded bg-layer-3" />
                  <div className="h-4 w-1/2 animate-pulse rounded bg-layer-3" />
                </div>
              ) : (
                <>
                  {/* decision question — the focus of this dialog */}
                  <p className="mt-3 text-body-sm-regular text-primary">{detail.question}</p>
                  {/* context meta — soft panel, comfortably spaced */}
                  {(detail.context || detail.deliveryStatus) && (
                    <div className="mt-4 flex flex-col gap-y-1.5 rounded-md bg-layer-2 px-3.5 py-3">
                      {detail.context &&
                        Object.entries(detail.context).map(([key, value]) => (
                          <div key={key} className="flex justify-between gap-4 text-caption-sm-regular text-tertiary">
                            <span>{contextLabel(key)}</span>
                            <span className="text-secondary">{String(value)}</span>
                          </div>
                        ))}
                      {detail.scope === "agent" && detail.deliveryStatus && (
                        <div className="flex justify-between gap-4 text-caption-sm-regular text-tertiary">
                          <span>{contextLabel("delivery")}</span>
                          <span className="text-secondary">{deliveryLabel(detail.deliveryStatus)}</span>
                        </div>
                      )}
                    </div>
                  )}
                  {/* actions — anchored by a divider; shape follows the
                      request kind: fixed choices vs free-text answer. */}
                  <div className="mt-5 border-t border-subtle pt-4">
                    {detail.kind === "text" || detail.kind === "form" ? (
                      <div className="flex flex-col gap-2">
                        <TextArea
                          id="inbox-text-answer"
                          name="inbox-text-answer"
                          placeholder={t("agent_teams_inbox_answer_placeholder")}
                          value={textAnswer}
                          onChange={(e) => setTextAnswer(e.target.value)}
                          className="min-h-20 w-full resize-none text-13"
                        />
                        <div className="flex justify-end">
                          <Button
                            variant="primary"
                            size="lg"
                            loading={answering === "text"}
                            disabled={!textAnswer.trim() || (answering !== "" && answering !== "text")}
                            onClick={() => void handleAnswer(textAnswer)}
                          >
                            {t("agent_teams_inbox_submit")}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex justify-end gap-2">
                        {detail.options?.map((option) => (
                          <Button
                            key={option.value}
                            variant={
                              option.value === "reject"
                                ? "error-fill"
                                : option.value === "approve"
                                  ? "primary"
                                  : "secondary"
                            }
                            size="lg"
                            loading={answering === option.value}
                            disabled={answering !== "" && answering !== option.value}
                            onClick={() => void handleAnswer(option.value)}
                          >
                            {option.label}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          ) : null}
        </div>
      </ModalCore>
    </>
  );
}

export default observer(AgentTeamsInboxPage);
