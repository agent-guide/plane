/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";

import { useTranslation } from "@plane/i18n";
import { CopyOutline, DeleteOutline, EditOutline, LinkOutline, MoreHorizontalOutline } from "@makeplane/propel/icons";
import { setToast } from "@plane/blocks/toast";
import { Tooltip } from "@makeplane/propel/components/tooltip";
import type { TIssueServiceType } from "@plane/types";
import { EIssueServiceType } from "@plane/types";
// ui
import { Icon } from "@makeplane/propel/components/icon";
import { IconButton } from "@makeplane/propel/components/icon-button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@makeplane/propel/components/menu";
import { calculateTimeAgo, copyTextToClipboard } from "@plane/utils";
// helpers
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { usePlatformOS } from "@/hooks/use-platform-os";
import type { TLinkOperationsModal } from "./create-update-link-modal";

/** The link's favicon from its metadata, falling back to the link glyph when it's missing or fails to load. */
function LinkFavicon(props: { faviconUrl: string | undefined }) {
  const { faviconUrl } = props;
  const [failedUrl, setFailedUrl] = useState<string | undefined>(undefined);

  if (!faviconUrl || failedUrl === faviconUrl)
    return <LinkOutline aria-hidden className="size-4 flex-shrink-0 text-secondary group-hover:text-primary" />;

  return <img src={faviconUrl} alt="" className="size-4 flex-shrink-0" onError={() => setFailedUrl(faviconUrl)} />;
}

type TIssueLinkItem = {
  linkId?: string;
  /** 外部数据模式（新建态草稿）：直接给链接数据，配合 onRemove */
  link?: { id: string; url: string; title?: string };
  onRemove?: (id: string) => void;
  linkOperations: TLinkOperationsModal;
  isNotAllowed: boolean;
  issueServiceType?: TIssueServiceType;
};

export const IssueLinkItem = observer(function IssueLinkItem(props: TIssueLinkItem) {
  // props
  const { linkId, link: externalLink, onRemove, linkOperations, isNotAllowed, issueServiceType = EIssueServiceType.ISSUES } = props;
  // hooks
  const { t } = useTranslation();
  const {
    toggleIssueLinkModal: toggleIssueLinkModalStore,
    setIssueLinkData,
    link: { getLinkById },
  } = useIssueDetail(issueServiceType);
  const { isMobile } = usePlatformOS();

  const storeLink = linkId ? getLinkById(linkId) : undefined;
  const linkDetail = storeLink ?? (externalLink ? {
    id: externalLink.id,
    url: externalLink.url,
    title: externalLink.title ?? "",
    metadata: {},
    created_at: new Date().toISOString(),
  } : undefined);
  if (!linkDetail) return <></>;

  // const Icon = getIconForLink(linkDetail.url);
  const faviconUrl: string | undefined = linkDetail.metadata?.favicon;
  const linkTitle: string | undefined = linkDetail.metadata?.title;

  const toggleIssueLinkModal = (modalToggle: boolean) => {
    toggleIssueLinkModalStore(modalToggle);
    // 仅在 store 模式（无 externalLink）触发，此时 linkDetail 必为 TIssueLink
    setIssueLinkData(linkDetail as TIssueLink);
  };
  return (
    <>
      <div
        key={linkId}
        className="group 3xl:col-span-2 col-span-12 flex h-10 flex-shrink-0 items-center justify-between gap-3 rounded-lg border-[0.5px] border-subtle bg-surface-2 px-3 hover:bg-layer-1 lg:col-span-6 xl:col-span-4 2xl:col-span-3"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <LinkFavicon faviconUrl={faviconUrl} />
          <Tooltip label={linkDetail.url} layout="stacked" disabled={isMobile}>
            <a
              href={linkDetail.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-0 flex-1 cursor-pointer items-center text-body-xs-regular"
            >
              <span className="w-0 flex-1 truncate">
                {linkDetail.title && linkDetail.title !== "" ? linkDetail.title : linkDetail.url}
                {linkTitle && linkTitle !== "" && (
                  <span className="text-caption-sm-regular text-placeholder"> {linkTitle}</span>
                )}
              </span>
            </a>
          </Tooltip>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          <p className="group-hover-text-secondary p-1 align-bottom text-caption-sm-regular leading-5 text-placeholder">
            {calculateTimeAgo(linkDetail.created_at)}
          </p>
          <IconButton
            variant="ghost"
            size="sm"
            aria-label={t("common.actions.copy_link")}
            icon={<Icon icon={CopyOutline} />}
            onClick={() => {
              void copyTextToClipboard(linkDetail.url);
              setToast({
                type: "success",
                title: t("common.link_copied"),
                message: t("common.link_copied_to_clipboard"),
              });
            }}
          />
          <Menu>
            {/* Icon-only trigger, so it needs an explicit accessible name. */}
            <MenuTrigger
              render={
                <IconButton
                  variant="ghost"
                  size="sm"
                  disabled={isNotAllowed}
                  aria-label={t("aria_labels.common.more_actions")}
                  icon={<Icon icon={MoreHorizontalOutline} />}
                />
              }
            />
            <MenuContent side="bottom" align="end">
              <MenuItem
                icon={<Icon icon={EditOutline} />}
                label={t("common.actions.edit")}
                onClick={() => {
                  toggleIssueLinkModal(true);
                }}
              />
              <MenuItem
                icon={<Icon icon={DeleteOutline} />}
                label={t("common.actions.delete")}
                onClick={() => {
                  void linkOperations.remove(linkDetail.id);
                }}
              />
            </MenuContent>
          </Menu>
        </div>
      </div>
    </>
  );
});
