/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

// ui
import { useTranslation } from "@plane/i18n";
import { UserCirclePropertyIcon, CreateIcon, LayerStackIcon } from "@plane/propel/icons";
import { ClipboardCheck } from "lucide-react";
import type { IUserProfileData } from "@plane/types";
import { usePendingApprovals } from "@/services/agent-teams/runtime-swr";
import { Loader, Card, ECardSpacing, ECardDirection } from "@plane/ui";
// types

type Props = {
  userProfile: IUserProfileData | undefined;
};

export function ProfileStats({ userProfile }: Props) {
  const { workspaceSlug, userId } = useParams();

  const { t } = useTranslation();
  // 待确认：需要我处理的团队审批数（与 created/assigned/subscribed 同构的
  // 第四张统计卡；有待办时数字主题色高亮，点击跳「待确认」tab）
  const { count: pendingCount } = usePendingApprovals(workspaceSlug?.toString());

  const overviewCards = [
    {
      icon: CreateIcon,
      route: "created",
      i18n_title: "profile.stats.created",
      value: userProfile?.created_issues ?? "...",
    },
    {
      icon: UserCirclePropertyIcon,
      route: "assigned",
      i18n_title: "profile.stats.assigned",
      value: userProfile?.assigned_issues ?? "...",
    },
    {
      icon: LayerStackIcon,
      route: "subscribed",
      i18n_title: "profile.stats.subscribed",
      value: userProfile?.subscribed_issues ?? "...",
    },
    {
      icon: ClipboardCheck,
      route: "approvals",
      i18n_title: "profile.stats.approvals",
      value: pendingCount ?? "...",
      highlight: (pendingCount ?? 0) > 0,
    },
  ];

  return (
    <div className="space-y-2">
      <h3 className="text-16 font-medium">{t("profile.stats.overview")}</h3>
      {userProfile ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          {overviewCards.map((card) => (
            <Link key={card.route} href={`/${workspaceSlug}/profile/${userId}/${card.route}`}>
              <Card direction={ECardDirection.ROW} spacing={ECardSpacing.SM} className="h-full">
                <div className="grid h-11 w-11 place-items-center rounded-sm bg-surface-2">
                  <card.icon className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <p className="text-13 text-placeholder">{t(card.i18n_title)}</p>
                  {card.highlight ? (
                    <span className="inline-flex w-fit items-center rounded-full bg-accent-primary px-2 py-0.5 text-14 font-semibold text-on-color">
                      {card.value}
                    </span>
                  ) : (
                    <p className="text-18 font-semibold">{card.value}</p>
                  )}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <Loader className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Loader.Item height="80px" />
          <Loader.Item height="80px" />
          <Loader.Item height="80px" />
        </Loader>
      )}
    </div>
  );
}
