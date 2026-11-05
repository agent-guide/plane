/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React from "react";
// components
import { PageHead } from "@/components/core/page-title";
import { ProfileIssuesPage } from "@/components/profile/profile-issues";
import { ProfileApprovalsView } from "../approvals";
import type { Route } from "./+types/page";

const ProfilePageHeader = {
  assigned: "Profile - Assigned",
  created: "Profile - Created",
  subscribed: "Profile - Subscribed",
};

function isValidProfileViewId(viewId: string): viewId is keyof typeof ProfilePageHeader {
  return viewId in ProfilePageHeader;
}

function ProfileIssuesTypePage({ params }: Route.ComponentProps) {
  const { profileViewId } = params;

  // Agent Teams extension：待确认（团队审批）——split view 页
  if (profileViewId === "approvals") {
    return <ProfileApprovalsView />;
  }

  if (!isValidProfileViewId(profileViewId)) return null;

  const header = ProfilePageHeader[profileViewId];

  return (
    <>
      <PageHead title={header} />
      <ProfileIssuesPage type={profileViewId} />
    </>
  );
}

export default ProfileIssuesTypePage;
