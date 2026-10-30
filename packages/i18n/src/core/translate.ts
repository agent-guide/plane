/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { i18nInstance } from "./instance";

/**
 * Imperative translation for non-React contexts (stores, services, guards).
 * Returns the key when the instance is not initialized or the key is missing —
 * same fallback semantics as the `t` from useTranslation.
 */
export function translate(key: string, params?: Record<string, unknown>): string {
  const value = i18nInstance.t(key, params);
  return typeof value === "string" ? value : key;
}
