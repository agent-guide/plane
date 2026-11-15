# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""执行中补料（C8-B / steering）：短期签名 + 补充查询。

安全口径（原 G4，见 docs/v2/supplement-steering-design.md 附2）：
- 内部写接口（节点 start/finish/fail、事件上报）的共享 token **不进 prompt**
  ——把它交给模型等于把平台凭证交给不可信方；
- agent 自取补充只拿**短期签名**：HMAC(共享 token, execution_id:exp)，
  时效绑执行、过期作废、泄露不可复用到其他执行。
"""

import hashlib
import hmac
import time


def _key() -> bytes:
    import os
    return (os.environ.get("ORCHESTRATION_INTERNAL_TOKEN") or "").encode()


def sign_supplement_access(execution_id: str, *, ttl_seconds: int = 7200) -> dict:
    """生成一次节点执行的补充访问签名（worker 组 prompt 时调用）。

    ttl 默认 2h（覆盖节点总预算 30min 默认 + 重试余量）；同一次节点执行
    期间 agent 可反复用同一签名拉取（after 参数控制增量）。
    """
    exp = int(time.time()) + max(60, int(ttl_seconds))
    sig = hmac.new(_key(), f"{execution_id}:{exp}".encode(), hashlib.sha256).hexdigest()
    return {"exp": exp, "sig": sig}


def verify_supplement_access(execution_id: str, exp, sig) -> bool:
    """校验签名：常量时间比较 + 时效。任一失败即拒绝（fail-closed）。"""
    try:
        exp_int = int(str(exp))
    except (TypeError, ValueError):
        return False
    if not sig or not hmac.compare_digest(
            hmac.new(_key(), f"{execution_id}:{exp_int}".encode(), hashlib.sha256).hexdigest(),
            str(sig)):
        return False
    return time.time() <= exp_int


def supplement_entries(issue, after_dt=None) -> list[dict]:
    """节点执行期间新增的人工补充（供自取接口返回）。

    与 P1 的 _card_comment_history 同源过滤（排除 bot、HTML 剥离、附件
    解析文本），但按 after_dt 增量、结构化返回（单条独立消费，不带整段
    「仅作为数据」标注——防注入语义由消费方 prompt 纪律承担）。
    """
    from django.utils import timezone
    from .execution_context import _attachment_texts, _plain_description
    qs = issue.issue_comments.exclude(actor__is_bot=True).select_related("actor").order_by("created_at")
    if after_dt is not None:
        qs = qs.filter(created_at__gt=after_dt)
    items = []
    for c in qs:
        text = (c.comment_stripped or _plain_description(c.comment_html)).strip()
        blocks = _attachment_texts(c)
        if not text and not blocks:
            continue
        actor = c.actor
        name = (getattr(actor, "display_name", None)
                or (actor.get_full_name() if actor else "")
                or (getattr(actor, "email", None) or "?"))
        items.append({
            "author": name,
            "at": timezone.localtime(c.created_at).isoformat(),
            "text": text,
            "attachments": blocks,
        })
    return items
