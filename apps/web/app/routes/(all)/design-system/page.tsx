/**
 * Copyright © 2026 agent-guide contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * 设计系统标本页（dev 验收面）——按设计系统展示页标准搭建：
 * 主 CTA 领衔、变体矩阵、状态列、真实组合场景。逐项验收唯一入口。
 */
import { Button } from "@/core/ui-compat/button";
import { Input, TextArea } from "@/core/ui-compat";

const variants = ["primary", "secondary", "tertiary", "ghost", "error-fill", "error-outline", "link"] as const;
const sizes = ["sm", "base", "lg", "xl"] as const;
const variantName: Record<string, string> = {
  primary: "主操作 · 黑", secondary: "次操作 · 白", tertiary: "三级 · 灰底",
  ghost: "幽灵", "error-fill": "危险 · 红底", "error-outline": "危险 · 红描", link: "链接",
};

export default function DesignSystemPage() {
  return (
    <div className="h-full overflow-y-auto bg-canvas" data-theme="light">
      <div className="mx-auto max-w-[1080px] px-10 py-14">
        {/* ── 页头 ── */}
        <header className="mb-12 border-b border-subtle pb-8">
          <p className="text-caption-sm-regular uppercase tracking-[0.08em] text-tertiary">Design System</p>
          <h1 className="mt-2 text-title-h2 text-primary">组件标本 · 逐项验收面</h1>
          <p className="mt-3 max-w-[560px] text-body-sm-regular leading-relaxed text-secondary">
            品类标准方向，Linear / Height 工艺底线。验收动线：hover 看提亮、按住看凹陷、Tab 看焦点环、
            点进输入框看光环。对着具体行说「过 / 不过」。
          </p>
        </header>

        {/* ── 1. 主 CTA 舞台 ── */}
        <section className="mb-12">
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-title-h4 text-primary">主操作按钮</h2>
            <span className="text-caption-sm-regular text-tertiary">页面级 CTA 用 lg / xl</span>
          </div>
          <div className="rounded-lg border border-subtle bg-surface-1 p-8">
            <div className="flex flex-wrap items-center gap-4">
              <Button variant="primary" size="xl">创建工作卡</Button>
              <Button variant="primary" size="lg">确认通过</Button>
              <Button variant="primary" size="xl" disabled>已提交</Button>
              <Button variant="primary" size="lg" loading>处理中</Button>
            </div>
            <p className="mt-6 text-caption-sm-regular text-tertiary">
              黑 CTA · 顶部微高光 · 底部 1px 影 · hover 提亮 · active 凹陷
            </p>
          </div>
        </section>

        {/* ── 2. 变体 × 尺寸矩阵 ── */}
        <section className="mb-12">
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-title-h4 text-primary">变体 × 尺寸矩阵</h2>
            <span className="text-caption-sm-regular text-tertiary">左→右 sm base lg xl</span>
          </div>
          <div className="overflow-hidden rounded-lg border border-subtle bg-surface-1">
            {variants.map((v, i) => (
              <div
                key={v}
                className={`flex items-center gap-6 px-6 py-4 ${i !== variants.length - 1 ? "border-b border-subtle" : ""}`}
              >
                <div className="w-[110px] flex-shrink-0">
                  <div className="text-body-sm-medium text-secondary">{variantName[v]}</div>
                  <div className="font-mono text-caption-sm-regular text-placeholder">{v}</div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {sizes.map((sz) => (
                    <Button key={sz} variant={v} size={sz}>按钮</Button>
                  ))}
                </div>
                <div className="ml-auto flex items-center gap-3">
                  <Button variant={v} size="base" disabled>禁用</Button>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── 3. 输入件 ── */}
        <section className="mb-12">
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-title-h4 text-primary">输入件</h2>
            <span className="text-caption-sm-regular text-tertiary">第一个已聚焦 · 错误行看红环</span>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-6 rounded-lg border border-subtle bg-surface-1 p-8">
            {[
              { label: "聚焦态", ph: "报关单号…", extra: { autoFocus: true } },
              { label: "默认态", ph: "收货人名称" },
              { label: "禁用态", ph: "锁定字段", extra: { disabled: true } },
              { label: "错误态", ph: "监管证件号缺前缀", extra: { hasError: true } },
            ].map((f) => (
              <div key={f.label}>
                <label className="mb-2 block text-caption-sm-medium text-secondary">
                  {f.label}
                  <Input mode="primary" inputSize="sm" placeholder={f.ph} className="mt-2 w-full" {...f.extra} />
                </label>
              </div>
            ))}
            <div className="col-span-2">
              <label className="mb-2 block text-caption-sm-medium text-secondary">
                多行（补料说明）
                <TextArea mode="primary" textAreaSize="sm" placeholder="补充口径、异常说明…" className="mt-2 w-full" rows={3} />
              </label>
            </div>
          </div>
        </section>

        {/* ── 4. 组合实况 ── */}
        <section className="mb-12">
          <h2 className="mb-4 text-title-h4 text-primary">组合实况</h2>
          <div className="rounded-lg border border-subtle bg-surface-1 p-8">
            <div className="flex flex-col gap-3 rounded-lg border border-subtle bg-surface-1 p-5">
              <p className="text-body-sm-medium text-primary">键盘数量口径确认（150 / 200 / 600）</p>
              <p className="text-caption-sm-regular text-tertiary">与报关行对齐最终数量，需书面确认回传</p>
              <div className="mt-1 flex items-center gap-3">
                <Button variant="primary" size="lg">通过</Button>
                <Button variant="secondary" size="lg">驳回</Button>
                <Button variant="ghost" size="lg">稍后处理</Button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
