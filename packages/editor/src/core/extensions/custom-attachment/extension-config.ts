/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { mergeAttributes, Node } from "@tiptap/core";
// constants
import { CORE_EXTENSIONS } from "@/constants/extension";
// local imports
import { ECustomAttachmentAttributeNames, ECustomAttachmentStatus } from "./types";
import type {
  CustomAttachmentExtensionOptions,
  CustomAttachmentExtensionStorage,
  CustomAttachmentExtensionType,
  InsertAttachmentComponentProps,
  TCustomAttachmentAttributes,
} from "./types";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    [CORE_EXTENSIONS.ATTACHMENT]: {
      insertAttachmentComponent: ({ file, pos, event }: InsertAttachmentComponentProps) => ReturnType;
    };
  }
  interface Storage {
    [CORE_EXTENSIONS.ATTACHMENT]: CustomAttachmentExtensionStorage;
  }
}

export const CustomAttachmentExtensionConfig: CustomAttachmentExtensionType = Node.create<
  CustomAttachmentExtensionOptions,
  CustomAttachmentExtensionStorage
>({
  name: CORE_EXTENSIONS.ATTACHMENT,
  group: "block",
  atom: true,

  addAttributes() {
    // 显式声明 parseHTML/renderHTML：确保文件名/URL/状态在「提交评论 → 回显」
    // 的 HTML 往返中不丢失（不依赖 Tiptap 对未知属性的默认行为）。
    return {
      [ECustomAttachmentAttributeNames.ID]: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("id"),
        renderHTML: (attributes: Record<string, unknown>) => ({ id: attributes.id }),
      },
      [ECustomAttachmentAttributeNames.NAME]: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("name"),
        renderHTML: (attributes: Record<string, unknown>) => ({ name: attributes.name }),
      },
      [ECustomAttachmentAttributeNames.URL]: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("url"),
        renderHTML: (attributes: Record<string, unknown>) => ({ url: attributes.url }),
      },
      [ECustomAttachmentAttributeNames.STATUS]: {
        default: ECustomAttachmentStatus.PENDING,
        parseHTML: (element: HTMLElement) => element.getAttribute("status"),
        renderHTML: (attributes: Record<string, unknown>) => ({ status: attributes.status }),
      },
    } as Record<
      ECustomAttachmentAttributeNames,
      { default: TCustomAttachmentAttributes[ECustomAttachmentAttributeNames] }
    >;
  },

  parseHTML() {
    return [{ tag: "attachment-component" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["attachment-component", mergeAttributes(HTMLAttributes)];
  },
});
