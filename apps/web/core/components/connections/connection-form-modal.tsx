/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * 新建/编辑连接弹层（设计 §5.1）：类型卡片 → 动态表单 → 保存即测试。
 * 凭据只写不读（编辑留空=不修改）；失败不阻塞保存。
 */
"use client";

import { useState } from "react";
import { observer } from "mobx-react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { EModalPosition, EModalWidth, Input, ModalCore } from "@plane/ui";
import { connectionsService, type TConnectionType } from "@/services/agent-teams/connections.service";

type TForm = {
  name: string;
  zentaoAuthMode: "password" | "zentaosid";
  url: string;
  username: string;
  password: string;
  zentaosid: string;
  httpAuth: "none" | "basic" | "bearer";
  token: string;
  testPath: string;
};

const EMPTY: TForm = {
  name: "", zentaoAuthMode: "password", url: "",
  username: "", password: "", zentaosid: "",
  httpAuth: "none", token: "", testPath: "",
};

export const ConnectionFormModal = observer(function ConnectionFormModal({
  isOpen,
  handleClose,
  workspaceSlug,
  presetType,
}: {
  isOpen: boolean;
  handleClose: () => void;
  workspaceSlug: string;
  /** 画布内新建时预选类型（设计 §5.2） */
  presetType?: TConnectionType;
}) {
  const { t } = useTranslation();
  const [type, setType] = useState<TConnectionType | "">("");
  const [form, setForm] = useState<TForm>(EMPTY);
  const [errorKey, setErrorKey] = useState("");
  const [result, setResult] = useState<{ ok: boolean; note: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const effectiveType = (type || presetType || "") as TConnectionType | "";
  const isEdit = false; // 编辑入口后续接线（列表行 onEdit）

  const reset = () => {
    setType(""); setForm(EMPTY); setErrorKey(""); setResult(null); setAdvancedOpen(false);
  };

  const close = () => {
    handleClose();
    reset();
  };

  const buildConfig = (): Record<string, unknown> => {
    if (effectiveType === "zentao") {
      return form.zentaoAuthMode === "zentaosid"
        ? { url: form.url.trim(), zentaosid: form.zentaosid.trim() }
        : { url: form.url.trim(), username: form.username.trim(), password: form.password };
    }
    const config: Record<string, unknown> = { url: form.url.trim(), auth_type: form.httpAuth };
    if (form.httpAuth === "basic") {
      if (form.username.trim()) config.username = form.username.trim();
      if (form.password) config.password = form.password;
    }
    if (form.httpAuth === "bearer" && form.token) config.token = form.token;
    if (form.testPath.trim()) config.test_path = form.testPath.trim();
    return config;
  };

  const missing: string[] = [];
  if (!form.name.trim()) missing.push(t("connections.field_name"));
  if (!form.url.trim()) missing.push(t("connections.field_url"));
  if (effectiveType === "zentao") {
    if (form.zentaoAuthMode === "password" && !form.username.trim()) missing.push(t("connections.field_account"));
    if (form.zentaoAuthMode === "zentaosid" && !form.zentaosid.trim()) missing.push(t("connections.field_session"));
  } else if (form.httpAuth === "basic" && !isEdit && !form.username.trim()) {
    missing.push(t("connections.field_account"));
  }

  const submit = async () => {
    if (missing.length > 0) return;
    setSaving(true);
    setErrorKey("");
    try {
      const conn = await connectionsService.createConnection(workspaceSlug, {
        name: form.name.trim(),
        type: effectiveType as TConnectionType,
        config: buildConfig(),
      });
      setResult({
        ok: conn.status === "active",
        note: conn.status === "active" ? t("connections.test_ok") : conn.statusNote || t("connections.test_failed"),
      });
      // 成功：延迟自动关闭给用户看到结果（克制反馈：不弹 toast）
      if (conn.status === "active") {
        setTimeout(() => close(), 1200);
      }
    } catch (error) {
      setErrorKey((error as Error).message || "connections.save_failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalCore isOpen={isOpen} handleClose={close} position={EModalPosition.TOP} width={EModalWidth.SM}>
      <div className="flex flex-col gap-4 p-5">
        <h3 className="text-body-lg-medium m-0 text-primary">{t("connections.add")}</h3>

        {/* 类型卡片（新建时；画布预选则隐藏） */}
        {!effectiveType ? (
          <div className="grid grid-cols-2 gap-2">
            {(["zentao", "http_api"] as const).map((tp) => (
              <button
                key={tp}
                type="button"
                onClick={() => setType(tp)}
                className="flex flex-col gap-1 rounded-lg border border-subtle px-3 py-3 text-left transition-colors hover:border-accent-primary/50"
              >
                <span className="text-body-sm-medium text-primary">{t(`connections.type_${tp}`)}</span>
                <span className="text-caption-sm-regular text-tertiary">{t(`connections.type_${tp}_hint`)}</span>
              </button>
            ))}
          </div>
        ) : null}

        {effectiveType ? (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="text-caption-sm-medium text-secondary">{t("connections.field_name")}</span>
              <Input
                mode="primary" inputSize="sm" className="w-full"
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder={t("connections.name_placeholder")}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-caption-sm-medium text-secondary">{t("connections.field_url")}</span>
              <Input
                mode="primary" inputSize="sm" className="w-full"
                value={form.url}
                onChange={(e) => setForm((p) => ({ ...p, url: e.target.value }))}
                placeholder="https://…"
              />
            </label>

            {effectiveType === "zentao" ? (
              <>
                <div className="flex gap-2">
                  {(["password", "zentaosid"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setForm((p) => ({ ...p, zentaoAuthMode: mode }))}
                      className={`flex-1 rounded-md border px-3 py-1.5 text-caption-sm-medium transition-colors ${
                        form.zentaoAuthMode === mode
                          ? "border-accent-primary/50 bg-accent-subtle text-accent-primary"
                          : "border-subtle text-tertiary"
                      }`}
                    >
                      {t(`connections.zentao_${mode}`)}
                    </button>
                  ))}
                </div>
                {form.zentaoAuthMode === "password" ? (
                  <>
                    <label className="flex flex-col gap-1.5">
                      <span className="text-caption-sm-medium text-secondary">{t("connections.field_account")}</span>
                      <Input mode="primary" inputSize="sm" className="w-full" value={form.username}
                        onChange={(e) => setForm((p) => ({ ...p, username: e.target.value }))} />
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <span className="text-caption-sm-medium text-secondary">{t("connections.field_password")}</span>
                      <Input mode="primary" inputSize="sm" type="password" className="w-full" value={form.password}
                        onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))} />
                    </label>
                  </>
                ) : (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-caption-sm-medium text-secondary">{t("connections.field_session")}</span>
                    <Input mode="primary" inputSize="sm" className="w-full" value={form.zentaosid}
                      onChange={(e) => setForm((p) => ({ ...p, zentaosid: e.target.value }))} />
                    <span className="text-11 text-tertiary">{t("connections.session_hint")}</span>
                  </label>
                )}
              </>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2">
                  {(["none", "basic", "bearer"] as const).map((auth) => (
                    <button
                      key={auth}
                      type="button"
                      onClick={() => setForm((p) => ({ ...p, httpAuth: auth }))}
                      className={`rounded-md border px-2 py-1.5 text-caption-sm-medium transition-colors ${
                        form.httpAuth === auth
                          ? "border-accent-primary/50 bg-accent-subtle text-accent-primary"
                          : "border-subtle text-tertiary"
                      }`}
                    >
                      {t(`connections.http_${auth}`)}
                    </button>
                  ))}
                </div>
                {form.httpAuth === "basic" ? (
                  <>
                    <label className="flex flex-col gap-1.5">
                      <span className="text-caption-sm-medium text-secondary">{t("connections.field_account")}</span>
                      <Input mode="primary" inputSize="sm" className="w-full" value={form.username}
                        onChange={(e) => setForm((p) => ({ ...p, username: e.target.value }))} />
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <span className="text-caption-sm-medium text-secondary">{t("connections.field_password")}</span>
                      <Input mode="primary" inputSize="sm" type="password" className="w-full" value={form.password}
                        onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))} />
                    </label>
                  </>
                ) : form.httpAuth === "bearer" ? (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-caption-sm-medium text-secondary">{t("connections.field_token")}</span>
                    <Input mode="primary" inputSize="sm" type="password" className="w-full" value={form.token}
                      onChange={(e) => setForm((p) => ({ ...p, token: e.target.value }))} />
                  </label>
                ) : null}
                {/* 高级区：默认收起，不吓普通用户 */}
                <button type="button" className="self-start text-caption-sm-medium text-tertiary hover:text-secondary"
                  onClick={() => setAdvancedOpen((v) => !v)}>
                  {t("connections.advanced")} {advancedOpen ? "−" : "+"}
                </button>
                {advancedOpen ? (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-caption-sm-medium text-secondary">{t("connections.field_test_path")}</span>
                    <Input mode="primary" inputSize="sm" className="w-full" value={form.testPath}
                      onChange={(e) => setForm((p) => ({ ...p, testPath: e.target.value }))}
                      placeholder={t("connections.test_path_placeholder")} />
                  </label>
                ) : null}
              </>
            )}
          </>
        ) : null}

        {errorKey ? (
          <p className="m-0 rounded-md bg-danger-primary/5 px-3 py-2 text-body-xs-regular text-danger-primary">
            {t(errorKey) === errorKey ? errorKey : t(errorKey)}
          </p>
        ) : null}
        {/* 保存即测试结果（内联；失败不阻塞保存按钮——可先存后修） */}
        {result ? (
          <p className={`m-0 rounded-md px-3 py-2 text-body-xs-regular ${
            result.ok ? "bg-success-primary/10 text-success-primary" : "bg-danger-primary/5 text-danger-primary"
          }`}>
            {result.ok ? `✓ ${result.note}` : `${t("connections.test_failed")}：${result.note}`}
            {!result.ok ? ` · ${t("connections.test_failed_hint")}` : ""}
          </p>
        ) : null}

        {/* 缺项文字说明（不默默灰按钮） */}
        {effectiveType && missing.length > 0 ? (
          <p className="m-0 text-caption-sm-regular text-placeholder">
            {t("connections.missing_fields", { fields: missing.join("、") })}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2 border-t border-subtle pt-4">
          <Button variant="secondary" size="sm" onClick={close}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary" size="sm" loading={saving}
            disabled={effectiveType === "" || missing.length > 0}
            onClick={() => void submit()}
          >
            {t("connections.save")}
          </Button>
        </div>
      </div>
    </ModalCore>
  );
});
