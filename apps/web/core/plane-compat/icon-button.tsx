/** 旧 @plane/propel/icon-button 的兼容出口：包一层图标 props 适配。 */
"use client";
import { IconButton as PropelIconButton } from "@makeplane/propel/components/icon-button";
import React from "react";
import { Icon } from "@makeplane/propel/components/icon";

type OldProps = {
  /** 元素直接用；组件（含 lucide/propel 的 forwardRef 对象）包一层 <Icon/>。 */
  icon: React.ReactNode | React.ComponentType<Record<string, unknown>>;
  [key: string]: unknown;
};

export function IconButton(props: OldProps) {
  const { icon, ...rest } = props;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const iconNode = React.isValidElement(icon) ? icon : <Icon icon={icon as any} />;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <PropelIconButton icon={iconNode as any} {...(rest as any)} />;
}
