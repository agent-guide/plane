/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { useState } from "react";
import { observer } from "mobx-react";
import { PlusIcon } from "@plane/propel/icons";
// plane imports
import type { TIssueLink, TIssueServiceType } from "@plane/types";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { IssueLinkCreateUpdateModal } from "@/components/issues/issue-detail/links/create-update-link-modal";

type Props = {
  customButton?: React.ReactNode;
  disabled?: boolean;
  issueServiceType: TIssueServiceType;
  /** 软依赖：新建态无 issueId，链接先暂存、建卡后由调用方落库 */
  onDeferredLink?: (data: Partial<TIssueLink>) => void;
};

export const IssueLinksActionButton = observer(function IssueLinksActionButton(props: Props) {
  const { customButton, disabled = false, issueServiceType, onDeferredLink } = props;
  // store hooks
  const { toggleIssueLinkModal } = useIssueDetail(issueServiceType);
  // 新建态本地弹层状态（复用同一 Link 弹层交互）
  const [deferredModalOpen, setDeferredModalOpen] = useState(false);

  const handleOnClick = (e: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
    e.preventDefault();
    e.stopPropagation();
    if (onDeferredLink) setDeferredModalOpen(true);
    else toggleIssueLinkModal(true);
  };

  return (
    <>
      <button type="button" onClick={handleOnClick} disabled={disabled}>
        {customButton ? customButton : <PlusIcon className="h-4 w-4" />}
      </button>
      {onDeferredLink && (
        <IssueLinkCreateUpdateModal
          isModalOpen={deferredModalOpen}
          handleOnClose={() => setDeferredModalOpen(false)}
          issueServiceType={issueServiceType}
          linkOperations={{
            create: async (data) => onDeferredLink(data),
            update: async () => {},
            remove: async () => {},
          }}
        />
      )}
    </>
  );
});
