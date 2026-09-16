/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — in-page artifact preview (design §12.6): clicking a
 * deliverable opens a modal that renders markdown (GFM tables included, via
 * remark-gfm) instead of dropping the raw file into a new tab. Textual content
 * renders in-page with copy/download actions; other types fall back to a
 * download prompt; expiry/transport failures offer an in-modal retry.
 *
 * Two hard-won details:
 *  - rendered via createPortal: the panel/card live inside pragmatic-drag-and-drop
 *    draggables, which would turn in-modal text selection into a card drag;
 *  - closes ONLY via the header × — headlessui v2 counts "pointerdown inside,
 *    pointerup outside" as an outside click, which is what a text-selection
 *    drag past the modal edge looks like.
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
// i18n
import { useTranslation } from "@plane/i18n";
// plane imports
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { Button } from "@plane/propel/button";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
// icons
import { Check, Copy, Download, FileBox, RefreshCw, X } from "lucide-react";
// components
import { MarkdownPreview } from "@/components/agent-teams/markdown-preview";
// services
import runtimeService, { type RuntimeArtifact } from "@/services/agent-teams/runtime.service";

type TAgentArtifactPreviewModalProps = {
  artifact: RuntimeArtifact | null;
  onClose: () => void;
};

const isMarkdown = (artifact: RuntimeArtifact) =>
  (artifact.mimeType ?? "").includes("markdown") || artifact.name.toLowerCase().endsWith(".md");

export const AgentArtifactPreviewModal = function AgentArtifactPreviewModal({
  artifact,
  onClose,
}: TAgentArtifactPreviewModalProps) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async (target: RuntimeArtifact) => {
    setUrl(null);
    setContent(null);
    setError(false);
    setLoading(true);
    try {
      const downloadUrl = await runtimeService.getArtifactDownloadUrl(target.id);
      setUrl(downloadUrl);
      if (isMarkdown(target)) {
        const response = await fetch(downloadUrl);
        if (!response.ok) throw new Error(String(response.status));
        setContent(await response.text());
      }
    } catch {
      // Signed URLs can expire and fetches can fail mid-flight — surface a
      // retryable error instead of silently opening nothing.
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (artifact) void load(artifact);
  }, [artifact, load]);

  const handleCopy = async () => {
    if (content == null) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setToast({ type: TOAST_TYPE.WARNING, title: t("agent_teams_artifact_preview_failed") });
    }
  };

  // data-prevent-outside-click wraps the WHOLE portal tree (backdrop
  // included): the work-item peek listens for outside clicks at document
  // level, and portaled modal clicks — anywhere over it — would otherwise
  // read as "outside the peek" and close it (taking the modal down).
  return createPortal(
    // The work-item peek listens for outside clicks at document level and
    // portaled modal clicks read as "outside the peek" — close it and take
    // the modal down. data-prevent-outside-click is Plane's sanctioned
    // escape hatch; stopping mousedown/click propagation covers any other
    // document-level detector that doesn't honor the attribute.
    <div
      data-prevent-outside-click
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
    <ModalCore isOpen={!!artifact} handleClose={() => {}} position={EModalPosition.CENTER} width={EModalWidth.XXL}>
      {artifact && (
        <div className="flex flex-col gap-3 p-5">
          {/* header — node-name + version is the artifact's user-facing identity */}
          <div className="flex items-center gap-2">
            <div className="flex size-8 flex-shrink-0 items-center justify-center rounded-lg border border-subtle bg-layer-2">
              <FileBox className="size-4 text-secondary" aria-hidden />
            </div>
            <div className="min-w-0 flex-grow">
              <p className="truncate text-body-sm-medium text-primary">
                {artifact.name} · v{artifact.version}
              </p>
            </div>
            {content != null && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleCopy()}
                className={cn("gap-1.5", copied && "text-success-primary")}
              >
                {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
                {copied ? t("agent_teams_artifact_copied") : t("agent_teams_artifact_copy")}
              </Button>
            )}
            {url && (
              <Button
                variant="primary"
                size="sm"
                className="gap-1.5"
                onClick={() => window.open(url, "_blank", "noreferrer")}
              >
                <Download className="size-3.5" aria-hidden />
                {t("agent_teams_artifact_download")}
              </Button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="close"
              className="grid size-7 flex-shrink-0 place-items-center rounded text-tertiary hover:bg-layer-3 hover:text-primary"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>

          {/* body — markdown rendered in-page; other types offer download only */}
          {error ? (
            <div className="flex flex-col items-center gap-2 py-10">
              <p className="text-body-sm-regular text-tertiary">{t("agent_teams_artifact_preview_failed")}</p>
              <Button variant="secondary" size="sm" onClick={() => void load(artifact)}>
                <RefreshCw className="size-3.5" aria-hidden />
                {t("agent_teams_artifact_retry")}
              </Button>
            </div>
          ) : content != null ? (
            <div className="max-h-[65vh] overflow-y-auto rounded-lg border border-subtle bg-layer-1 px-6 py-4">
              <MarkdownPreview content={content} />
            </div>
          ) : !loading && url ? (
            <div className="flex flex-col items-center gap-2 py-10">
              <p className="text-body-sm-regular text-tertiary">{t("agent_teams_artifact_unsupported")}</p>
            </div>
          ) : (
            <div className="space-y-2 py-10">
              <div className="mx-auto h-4 w-1/2 animate-pulse rounded bg-layer-3" />
              <div className="mx-auto h-4 w-1/3 animate-pulse rounded bg-layer-3" />
            </div>
          )}
        </div>
      )}
    </ModalCore>
    </div>,
    document.body
  );
};
