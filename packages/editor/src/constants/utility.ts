/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// plane imports
import { CORE_EXTENSIONS } from "@plane/utils";
import type { ADDITIONAL_EXTENSIONS } from "@plane/utils";
// plane editor imports
import type { ExtensionFileSetStorageKey } from "@/types/storage";

export type NodeFileMapType = Partial<
  Record<
    CORE_EXTENSIONS | ADDITIONAL_EXTENSIONS,
    {
      /** 节点存资产 id 的属性名（图片是 src，附件是 url），缺省 "src" */
      srcAttr?: string;
      /** 节点自带"已删除集合"存储的扩展（附件无此存储，可省略） */
      fileSetName?: ExtensionFileSetStorageKey;
    }
  >
>;

export const NODE_FILE_MAP: NodeFileMapType = {
  [CORE_EXTENSIONS.IMAGE]: {
    srcAttr: "src",
    fileSetName: "deletedImageSet",
  },
  [CORE_EXTENSIONS.CUSTOM_IMAGE]: {
    srcAttr: "src",
    fileSetName: "deletedImageSet",
  },
  [CORE_EXTENSIONS.ATTACHMENT]: {
    srcAttr: "url",
  },
};
