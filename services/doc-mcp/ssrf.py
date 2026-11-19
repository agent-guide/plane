# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""SSRF 防护（parse_document 的 url 输入用）：与 services/url-mcp 的
url_reader 同口径——IP 直连先查、域名 DNS 解析后逐地址拒私网。
用标准库 ipaddress 判定（is_private/is_loopback/is_link_local/reserved）。
"""
from __future__ import annotations

import ipaddress
import socket


def _reject(ip_text: str) -> str | None:
    try:
        addr = ipaddress.ip_address(ip_text.split("%")[0])
    except ValueError:
        return f"无法解析地址 {ip_text}"
    if (addr.is_private or addr.is_loopback or addr.is_link_local
            or addr.is_reserved or addr.is_unspecified):
        return f"目标地址 {ip_text} 属于内网/保留地址，出于安全策略拒绝访问"
    # IPv4-mapped IPv6（::ffff:10.0.0.1）按内嵌 IPv4 再判一次
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        return _reject(str(addr.ipv4_mapped))
    return None


def assert_public_host(hostname: str) -> None:
    """校验主机名（或 IP 直连）不指向私网，违者抛 ValueError。"""
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        raise ValueError(f"无法解析主机 {hostname}") from None
    if not infos:
        raise ValueError(f"无法解析主机 {hostname}")
    for info in infos:
        ip_text = info[4][0]
        reason = _reject(ip_text)
        if reason:
            raise ValueError(reason)
