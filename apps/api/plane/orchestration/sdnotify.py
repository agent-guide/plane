# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""systemd notify 协议（sd_notify）最小实现——零依赖（unix datagram）。

配合单元 Type=notify + WatchdogSec：常驻循环与长耗时步骤（agent turn 的
SSE 读）逐事件报平安，systemd 在任意挂死（不限于已知挂法）时强杀重启。
无 NOTIFY_SOCKET（本地/容器手工运行）时全部 no-op。
"""

from __future__ import annotations

import os
import socket


def sd_notify(message: str) -> None:
    addr = os.environ.get("NOTIFY_SOCKET")
    if not addr:
        return
    if addr.startswith("@"):
        addr = "\0" + addr[1:]
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
            sock.connect(addr)
            sock.sendall(message.encode())
    except OSError:
        pass  # socket 失联（systemd 重启中等）：静默，下轮再试
