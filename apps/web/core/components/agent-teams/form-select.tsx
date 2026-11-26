/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE.txt file in the repository root for details.
 *
 * Agent Teams extension — shared form select: @plane/ui CustomSelect wrapper
 * （project settings 网络/时区字段同款），触发器规格与表单 Input 同档
 * （px-3 py-2 / text-13 / border-subtle-1 / bg-layer-2）。流程表单与画布
 * 属性面板共用，替换原生 select。
 */
import { CustomSelect } from "@/core/ui-compat";

export function FormSelect({
  value,
  placeholder,
  options,
  onChange,
}: {
  value: string;
  placeholder: string;
  options: Array<{ id: string; name: string }>;
  onChange: (value: string) => void;
}) {
  const selected = options.find((o) => o.id === value);
  return (
    <CustomSelect
      value={value}
      onChange={(v: string) => onChange(v)}
      label={
        selected ? (
          <span className="truncate">{selected.name}</span>
        ) : (
          <span className="text-placeholder">{placeholder}</span>
        )
      }
      buttonClassName="!border-subtle !shadow-none w-full rounded-md text-13 text-primary"
      input
    >
      {options.map((option) => (
        <CustomSelect.Option key={option.id} value={option.id}>
          <span className="truncate">{option.name}</span>
        </CustomSelect.Option>
      ))}
    </CustomSelect>
  );
}
