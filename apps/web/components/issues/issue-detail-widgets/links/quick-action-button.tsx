/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { cloneElement, useState } from "react";
import { observer } from "mobx-react";
import { AddOutline } from "@makeplane/propel/icons";
import { Icon } from "@makeplane/propel/components/icon";
import { IconButton } from "@makeplane/propel/components/icon-button";
import { Tooltip } from "@makeplane/propel/components/tooltip";
import { useTranslation } from "@plane/i18n";
// plane imports
import type { TIssueLink, TIssueServiceType } from "@plane/types";
// hooks
import { IssueLinkCreateUpdateModal } from "@/components/issues/issue-detail/links/create-update-link-modal";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";

type Props = {
  /** Rendered as the button itself; receives the click handler and `disabled`. */
  customButton?: React.ReactElement<React.ComponentPropsWithoutRef<"button">>;
  /** Hover label for `customButton`. */
  tooltip?: string;
  disabled?: boolean;
  issueServiceType: TIssueServiceType;
  /** 软依赖：新建态无 issueId，链接先暂存、建卡后由调用方落库 */
  onDeferredLink?: (data: Partial<TIssueLink>) => void;
};

export const IssueLinksActionButton = observer(function IssueLinksActionButton(props: Props) {
  const { t } = useTranslation();
  const { customButton, tooltip, disabled = false, issueServiceType, onDeferredLink } = props;
  // store hooks
  const { toggleIssueLinkModal } = useIssueDetail(issueServiceType);
  // 新建态本地弹层状态（复用同一 Link 弹层交互）
  const [deferredModalOpen, setDeferredModalOpen] = useState(false);

  // handlers
  const handleOnClick = (e: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
    e.preventDefault();
    e.stopPropagation();
    if (onDeferredLink) setDeferredModalOpen(true);
    else toggleIssueLinkModal(true);
  };

  const modal = onDeferredLink ? (
    <IssueLinkCreateUpdateModal
      isModalOpen={deferredModalOpen}
      handleOnClose={() => setDeferredModalOpen(false)}
      issueServiceType={issueServiceType}
      linkOperations={{
        create: async (data: Partial<TIssueLink>) => onDeferredLink(data),
        update: async () => {},
        remove: async () => {},
      }}
    />
  ) : null;

  if (customButton) {
    const button = cloneElement(customButton, { onClick: handleOnClick, disabled });
    return (
      <>
        {tooltip ? <Tooltip label={tooltip}>{button}</Tooltip> : button}
        {modal}
      </>
    );
  }

  return (
    <>
      <IconButton
        type="button"
        variant="ghost"
        size="sm"
        aria-label={t("common.add_link")}
        onClick={handleOnClick}
        disabled={disabled}
        icon={<Icon icon={AddOutline} />}
      />
      {modal}
    </>
  );
});
