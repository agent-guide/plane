/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — Activity stream Agent Run summary renderer (design §12.4, §12.5-4).
 * Plane comments authored by a Bot/Service User carry `actor_detail.is_bot === true`
 * (design §5.2: agents are Bots). Those comments are the Agent Run summary channel and
 * get a distinct card instead of the plain comment bubble. The comment body is the
 * Runtime's §7.4 terminal summary HTML — a fixed `<p>`/`<ul>` shape (headline by
 * outcome, deliverable list on completion, reason line on failure) — parsed here into
 * a structured card. Anything unparsable falls back to the stripped text.
 * Deliverable rows match the runtime summary's artifacts by name+version and reuse
 * the panel's signed-download flow for "view".
 */
import { useCallback } from "react";
import { observer } from "mobx-react";
import useSWR from "swr";
// i18n
import { useTranslation } from "@plane/i18n";
// plane imports
import type { TIssueComment } from "@plane/types";
import { calculateTimeAgo, cn } from "@plane/utils";
// icons
import { Bot, ExternalLink, FileBox } from "lucide-react";
// services
import runtimeService from "@/services/agent-teams/runtime.service";

type TAgentRunSummaryCardProps = {
  comment: TIssueComment | undefined;
  ends: "top" | "bottom" | undefined;
  issueId: string;
};

type TerminalKind = "completed" | "failed" | "cancelled";

const HEADLINE_KINDS: Array<[TerminalKind, string]> = [
  ["completed", "团队执行完成"],
  ["failed", "团队执行失败"],
  ["cancelled", "团队执行已取消"],
];

const decodeEntities = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

/** Parse the Runtime §7.4 comment shape; null when the body isn't one. */
function parseRunSummary(html?: string | null) {
  if (!html) return null;
  const paragraphs = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => decodeEntities(m[1].trim()));
  const headline = paragraphs[0] ?? "";
  const kind = HEADLINE_KINDS.find(([, label]) => headline.includes(label))?.[0];
  if (!kind) return null;
  // Failure reason rides in a "原因：…" paragraph; deliverables in <li> items.
  const reason = paragraphs.find((p) => p.startsWith("原因："))?.slice("原因：".length);
  const deliverables = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => decodeEntities(m[1].trim()));
  return { kind, reason, deliverables } as const;
}

const KIND_TEXT_STYLES: Record<TerminalKind, string> = {
  completed: "text-success-primary",
  failed: "text-danger-primary",
  cancelled: "text-tertiary",
};

export const AgentRunSummaryCard = observer(function AgentRunSummaryCard({
  comment,
  ends,
  issueId,
}: TAgentRunSummaryCardProps) {
  const { t } = useTranslation();

  const openArtifact = useCallback(async (artifactId: string) => {
    try {
      const url = await runtimeService.getArtifactDownloadUrl(artifactId);
      window.open(url, "_blank", "noreferrer");
    } catch {
      // Leave silently — downloads can fail on expiry/permission; the row
      // stays and the user can retry from the panel or admin console.
    }
  }, []);

  const run = comment ? parseRunSummary(comment.comment_html) : null;

  // Deliverable "view" needs artifact ids, which the comment doesn't carry —
  // resolve them from the runtime summary (only fetched when there is
  // something to open; terminal runs make it a one-shot request).
  const { data: artifacts } = useSWR(
    run && run.deliverables.length > 0 ? (["agent-teams", "summary-artifacts", issueId] as const) : null,
    () => runtimeService.getWorkItemRuntimeSummary(issueId),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );

  if (!comment) return null;

  const agentName = comment.actor_detail?.first_name ?? comment.actor_detail?.display_name ?? "Agent";
  const findArtifact = (label: string) => {
    // Comment items read "名称（vN）" — node display name or artifact name.
    const match = label.match(/^(.*)（v(\d+)）$/);
    if (!match || !artifacts?.artifacts) return undefined;
    const [, name, version] = match;
    return artifacts.artifacts.find(
      (a) => a.name === name && String(a.version) === version
    );
  };

  return (
    <div
      id={comment.id}
      className={cn("relative flex gap-3", ends === "top" ? "pb-2" : ends === "bottom" ? "pt-2" : "py-2")}
    >
      {/* timeline connector */}
      <div className="absolute top-0 bottom-0 left-[13px] w-px bg-layer-3" aria-hidden />
      {/* avatar column — Bot marker */}
      <div className="relative z-[3] flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border border-subtle bg-layer-2 shadow-raised-100">
        <Bot width={14} height={14} className="text-secondary" aria-hidden="true" />
      </div>
      {/* body — one caption-sm header line (native activity rhythm), then a
          single quiet card: outcome, optional reason, deliverable rows. */}
      <div className="min-w-0 w-full">
        <div className="flex flex-wrap items-center gap-x-2 text-caption-sm-regular">
          <span className="inline-flex items-center gap-1 rounded bg-accent-subtle px-1.5 py-0.5 text-caption-sm-medium text-accent-primary">
            <Bot className="size-3" aria-hidden="true" />
            {t("agent_teams_summary_badge")}
          </span>
          <span className="text-secondary">{agentName}</span>
          <span className="text-tertiary">{calculateTimeAgo(comment.created_at)}</span>
        </div>
        {run ? (
          <div className="mt-1.5 flex flex-col gap-1.5 rounded-lg border border-subtle bg-layer-2 px-3 py-2.5">
            {/* outcome — colored text line, not a chip: it IS the headline */}
            <span className={`mb-0.5 text-caption-sm-medium ${KIND_TEXT_STYLES[run.kind]}`}>
              {t(`agent_teams_status_${run.kind}`)}
            </span>
            {run.reason && <p className="text-caption-sm-regular text-secondary">{run.reason}</p>}
            {run.deliverables.length > 0 && <div className="h-1.5" aria-hidden />}
            {run.deliverables.map((label) => {
              const artifact = findArtifact(label);
              return artifact ? (
                <button
                  key={label}
                  type="button"
                  title={t("agent_teams_panel_artifact_open")}
                  onClick={() => void openArtifact(artifact.id)}
                  className="group flex w-fit items-center gap-1.5 rounded px-0.5 text-left hover:bg-layer-3"
                >
                  <FileBox className="size-3.5 shrink-0 text-tertiary" aria-hidden />
                  <span className="text-caption-sm-regular text-secondary group-hover:text-primary">{label}</span>
                  <ExternalLink
                    className="size-3 shrink-0 text-tertiary opacity-0 transition-opacity group-hover:opacity-100"
                    aria-hidden
                  />
                </button>
              ) : (
                <span key={label} className="flex items-center gap-1.5 px-0.5">
                  <FileBox className="size-3.5 shrink-0 text-tertiary" aria-hidden />
                  <span className="text-caption-sm-regular text-secondary">{label}</span>
                </span>
              );
            })}
          </div>
        ) : (
          comment.comment_stripped && (
            <div className="mt-1.5 rounded-lg border border-subtle bg-layer-2 px-3 py-2.5 text-body-sm-regular whitespace-pre-wrap">
              {comment.comment_stripped}
            </div>
          )
        )}
      </div>
    </div>
  );
});
