/** 旧 @plane/propel/icon-button 的兼容出口：包一层图标 props 适配。 */
"use client";
import { IconButton as PropelIconButton } from "@makeplane/propel/components/icon-button";
import type { LucideIcon } from "lucide-react";
import { Icon } from "@makeplane/propel/components/icon";

type OldProps = {
  icon: React.ReactNode | LucideIcon;
  [key: string]: unknown;
};

export function IconButton(props: OldProps) {
  const { icon, ...rest } = props;
  const iconNode =
    typeof icon === "function"
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <Icon icon={icon as any} />
      : icon;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <PropelIconButton icon={iconNode as any} {...(rest as any)} />;
}
