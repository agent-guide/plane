/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// types
import type { TDisplayConfig } from "@/types";
import { IMAGE_MIME_TYPES, ATTACHMENT_MIME_TYPES } from "@plane/constants";

export const DEFAULT_DISPLAY_CONFIG: TDisplayConfig = {
  fontSize: "large-font",
  fontStyle: "sans-serif",
  lineSpacing: "regular",
  wideLayout: false,
};

export const ACCEPTED_IMAGE_MIME_TYPES = IMAGE_MIME_TYPES;

export const ACCEPTED_ATTACHMENT_MIME_TYPES = ATTACHMENT_MIME_TYPES;
