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
    return {
      [ECustomAttachmentAttributeNames.ID]: { default: null },
      [ECustomAttachmentAttributeNames.NAME]: { default: null },
      [ECustomAttachmentAttributeNames.URL]: { default: null },
      [ECustomAttachmentAttributeNames.STATUS]: { default: ECustomAttachmentStatus.PENDING },
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
