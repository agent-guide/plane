# Copyright © 2026 agent-guide contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""外部系统连接域服务（连接管理设计 §2-§4，2026-11-01）。

凭据 Fernet 加密落库、API 只写不读（掩码回显）、保存即测试、删除即失效。
连接是工作区级共享实体，被流程 AI 节点按名称引用；运行时由工具服务经
resolve 内部接口取凭据（内存态用完即弃）。
"""

import json

from django.db import IntegrityError
from django.utils import timezone

from plane.db.models.workspace import Workspace
from plane.license.utils.encryption import decrypt_data, encrypt_data

from .models import ExternalConnection, WorkflowDefinition
from .services import TeamDomainError

# 面向用户的失败原因（存 status_note，非技术报错——设计稿 §3 红线 4）
REASON_CREDENTIALS = "账号或密码不正确"
REASON_UNREACHABLE = "无法连接到服务器"


def _decrypt_config(conn: ExternalConnection) -> dict:
    raw = decrypt_data(conn.config) if conn.config else ""
    return json.loads(raw) if raw else {}


def _mask(config: dict) -> dict:
    """掩码回显：地址明文（用户需要看），凭据一律 ••••。"""
    out = {k: v for k, v in config.items()
           if k in ("url", "auth_type", "test_path", "zentaosid") or k == "headers"}
    for key in ("password", "token", "username"):
        if config.get(key):
            out[key] = "••••••••"
    return out


def connection_json(conn: ExternalConnection) -> dict:
    return {
        "id": conn.id,
        "name": conn.name,
        "type": conn.type,
        "config": _mask(_decrypt_config(conn)),
        "status": conn.status,
        "statusNote": conn.status_note or "",
        "usageCount": _usage_count(conn),
        "createdBy": conn.created_by_id,
        "createdAt": conn.created_at.isoformat(),
        "updatedAt": conn.updated_at.isoformat(),
    }


def _usage_count(conn: ExternalConnection) -> int:
    """被多少流程引用（当前草稿 + 已发布版本快照都算——删除保护同口径）。"""
    name = f'"{conn.name}"'
    defs = WorkflowDefinition.objects.filter(project__workspace_id=conn.workspace_id)
    return sum(1 for d in defs
               if name in json.dumps(d.draft or {}, ensure_ascii=False)
               or d.versions.exists() and any(
                   name in json.dumps(v.definition or {}, ensure_ascii=False)
                   for v in d.versions.all()))


# ---------------------------------------------------------------- 探活（§3 红线 4）

def _test_zentao(config: dict) -> tuple[bool, str]:
    import urllib.request
    url = str(config.get("url", "")).rstrip("/")
    if not url:
        return False, REASON_UNREACHABLE
    zentaosid = str(config.get("zentaosid", ""))
    if zentaosid:
        # 会话形态：GET 任意页面，302 跳登录 = 会话失效
        req = urllib.request.Request(f"{url}/zentao/my.html",
                                     headers={"Cookie": f"zentaosid={zentaosid}"})
    else:
        return True, "已保存（账号密码形态发布时登录验证）"
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=8) as resp:
            return True, ""
    except urllib.error.HTTPError as e:
        if e.code in (301, 302):
            return False, "会话已过期——请更新会话 ID 或改用账号密码"
        if e.code in (401, 403):
            return False, REASON_CREDENTIALS
        return True, ""  # 服务器可达（2xx/404 等均算成功）
    except Exception:
        return False, REASON_UNREACHABLE


def _test_http(config: dict) -> tuple[bool, str]:
    import urllib.request
    base = str(config.get("url", "")).rstrip("/")
    test_path = str(config.get("test_path", "") or "/")
    if not base:
        return False, REASON_UNREACHABLE
    url = f"{base}{test_path if test_path.startswith('/') else '/' + test_path}"
    headers = {"Accept": "application/json"}
    auth_type = config.get("auth_type", "none")
    if auth_type == "bearer" and config.get("token"):
        headers["Authorization"] = f"Bearer {config['token']}"
    elif auth_type == "basic" and config.get("username"):
        import base64
        cred = base64.b64encode(
            f"{config['username']}:{config.get('password', '')}".encode()).decode()
        headers["Authorization"] = f"Basic {cred}"
    for k, v in (config.get("headers") or {}).items():
        headers[str(k)] = str(v)
    req = urllib.request.Request(url, headers=headers)
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=8) as resp:
            return True, ""
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            return False, REASON_CREDENTIALS
        return True, ""  # 404/405 等：服务器可达即成功（§3 判定规则）
    except Exception:
        return False, REASON_UNREACHABLE


def test_connection(conn_type: str, config: dict) -> tuple[bool, str]:
    if conn_type == "zentao":
        return _test_zentao(config)
    return _test_http(config)


# ---------------------------------------------------------------- CRUD（§4）

def _apply_test(conn: ExternalConnection) -> ExternalConnection:
    ok, note = test_connection(conn.type, _decrypt_config(conn))
    conn.status = ExternalConnection.Status.ACTIVE if ok else ExternalConnection.Status.UNREACHABLE
    conn.status_note = note
    conn.save(update_fields=["status", "status_note", "updated_at"])
    return conn


def create_connection(*, workspace_slug: str, user_id, name: str, type_: str, config: dict) -> ExternalConnection:
    if type_ not in ("zentao", "http_api"):
        raise TeamDomainError(400, "CONNECTION_TYPE_INVALID", "不支持的连接类型")
    name = (name or "").strip()
    if not name:
        raise TeamDomainError(400, "CONNECTION_NAME_REQUIRED", "请填写连接名称")
    url = str(config.get("url", "")).strip()
    if not url:
        raise TeamDomainError(400, "CONNECTION_URL_REQUIRED", "请填写系统地址")
    try:
        ws = Workspace.objects.get(slug=workspace_slug)
    except Workspace.DoesNotExist:
        raise TeamDomainError(404, "WORKSPACE_NOT_FOUND", "工作区不存在")
    if ExternalConnection.objects.filter(workspace=ws, name=name, deleted_at__isnull=True).exists():
        raise TeamDomainError(409, "CONNECTION_NAME_CONFLICT", "已有同名连接，请换一个名称")
    from django.contrib.auth import get_user_model
    conn = ExternalConnection.objects.create(
        workspace=ws,
        created_by_id=str(user_id) if user_id else None,
        name=name, type=type_, config=encrypt_data(json.dumps(config, ensure_ascii=False)),
    )
    return _apply_test(conn)


def update_connection(*, conn: ExternalConnection, name: str | None, config_patch: dict) -> ExternalConnection:
    """编辑：名称可选改；凭据字段留空=不修改（合并进已存配置）。"""
    if name is not None:
        new_name = name.strip()
        if new_name and new_name != conn.name:
            if ExternalConnection.objects.filter(
                    workspace_id=conn.workspace_id, name=new_name, deleted_at__isnull=True
            ).exclude(id=conn.id).exists():
                raise TeamDomainError(409, "CONNECTION_NAME_CONFLICT", "已有同名连接，请换一个名称")
            conn.name = new_name
    current = _decrypt_config(conn)
    merged = {**current}
    for key in ("url", "username", "password", "token", "zentaosid", "auth_type", "test_path", "headers"):
        if key in config_patch:
            value = config_patch[key]
            if value in ("", None):
                continue  # 留空=不修改（掩码回显值也被此规则挡掉）
            merged[key] = value
    conn.config = encrypt_data(json.dumps(merged, ensure_ascii=False))
    conn.save(update_fields=["name", "config", "updated_at"])
    return _apply_test(conn)


def delete_connection(*, conn: ExternalConnection) -> None:
    """软删 + 凭据即刻置空（§2 删除语义）；被流程引用则 409 带清单。"""
    refs = _referencing_workflows(conn)
    if refs:
        raise TeamDomainError(409, "CONNECTION_IN_USE",
                              f"无法删除——以下流程正在使用：{'、'.join(refs[:5])}")
    conn.config = ""
    conn.deleted_at = timezone.now()
    conn.save(update_fields=["config", "deleted_at", "updated_at"])


def _referencing_workspaces_list(conn):
    return _referencing_workflows(conn)


def _referencing_workflows(conn: ExternalConnection) -> list[str]:
    name = f'"{conn.name}"'
    refs = []
    for d in WorkflowDefinition.objects.filter(project__workspace_id=conn.workspace_id):
        if name in json.dumps(d.draft or {}, ensure_ascii=False):
            refs.append(d.name)
            continue
        for v in d.versions.all():
            if name in json.dumps(v.definition or {}, ensure_ascii=False):
                refs.append(d.name)
                break
    return refs


def resolve_connection(*, workspace_id, name: str) -> dict | None:
    """内部回调：按名称取解密凭据（运行时唯一取凭据入口，仅未删除行）。"""
    conn = ExternalConnection.objects.filter(
        workspace_id=workspace_id, name=name, deleted_at__isnull=True).first()
    if conn is None:
        return None
    return _decrypt_config(conn)
