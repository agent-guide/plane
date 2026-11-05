/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import useSWR from "swr";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { IUserStateDistribution } from "@plane/types";
import { ContentWrapper } from "@plane/ui";
// components
import { PageHead } from "@/components/core/page-title";
import { ProfileActivity } from "@/components/profile/overview/activity";
import { ProfilePriorityDistribution } from "@/components/profile/overview/priority-distribution";
import { ProfileStateDistribution } from "@/components/profile/overview/state-distribution";
import { ProfileStats } from "@/components/profile/overview/stats";
// constants
import { USER_PROFILE_DATA } from "@plane/constants";
// services
import { UserService } from "@/services/user.service";
import type { Route } from "./+types/page";
const userService = new UserService();

export default function ProfileOverviewPage({ params }: Route.ComponentProps) {
  const { workspaceSlug, userId } = params;

  const { t } = useTranslation();
  const { data: userProfile } = useSWR(USER_PROFILE_DATA(workspaceSlug, userId), () =>
    userService.getUserProfileData(workspaceSlug, userId)
  );

  // 直接透传后端按具体状态的聚合（#2）：不再按五大组折叠——等待确认/失败等
  // 细语义逐条可见，与看板列名同词
  const stateDistribution: IUserStateDistribution[] = userProfile?.state_distribution ?? [];

  return (
    <>
      <PageHead title={t("profile.page_label")} />
      <ContentWrapper className="space-y-7">
        <ProfileStats userProfile={userProfile} />
        <div className="grid grid-cols-1 items-stretch gap-5 xl:grid-cols-2">
          <ProfilePriorityDistribution userProfile={userProfile} />
          <ProfileStateDistribution stateDistribution={stateDistribution} userProfile={userProfile} />
        </div>
        <ProfileActivity />
      </ContentWrapper>
    </>
  );
}
