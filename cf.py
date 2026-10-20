#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 EasonShu
"""Cloudflare API v4 客户端 —— 只依赖 Python 标准库（urllib）。

封装面板用到的端点：
  凭据验证  GET  /user/tokens/verify        Token 是否有效
  账号发现  GET  /accounts                  Token 可见的账号列表
  域名列表  GET  /zones                     Zone（域名）列表
  DNS 记录  GET/POST/DELETE /zones/{zid}/dns_records
  隧道列表  GET  /accounts/{id}/cfd_tunnel
  隧道详情  GET  /accounts/{id}/cfd_tunnel/{tid}
  新建隧道  POST /accounts/{id}/cfd_tunnel
  删除隧道  DELETE /accounts/{id}/cfd_tunnel/{tid}
  隧道令牌  GET  /accounts/{id}/cfd_tunnel/{tid}/token
  Ingress   GET/PUT /accounts/{id}/cfd_tunnel/{tid}/configurations  远程托管路由规则

所有方法在 Cloudflare 返回 success=false 或 HTTP 错误时抛出 CloudflareError，
错误里保留 CF 原始 errors 数组（含 code/message），由上层原样透出给前端。
"""

import json
import urllib.error
import urllib.parse
import urllib.request

CF_API_BASE = "https://api.cloudflare.com/client/v4"
CF_TIMEOUT = 15  # 秒；NAS 出口到 CF 一般 <1s，留足余量


class CloudflareError(Exception):
    """Cloudflare API 调用失败。

    status: HTTP 状态码（网络错误为 0）
    errors: CF 返回的 errors 数组原文（可能是 [{"code":10000,"message":"..."}]）
    """

    def __init__(self, message: str, status: int = 0, errors=None):
        super().__init__(message)
        self.status = status
        self.errors = errors or []

    def to_dict(self):
        return {"message": str(self), "status": self.status, "errors": self.errors}


class CloudflareClient:
    """一个 Token 对应一个客户端实例；account_id 可在验证后回填。"""

    def __init__(self, api_token: str, account_id: str = ""):
        self.api_token = (api_token or "").strip()
        self.account_id = (account_id or "").strip()

    @property
    def configured(self) -> bool:
        return bool(self.api_token)

    # ------------------------------------------------------------ 底层请求

    def _request(self, method: str, path: str, payload=None):
        if not self.api_token:
            raise CloudflareError("尚未配置 API Token", 0)
        url = CF_API_BASE + path
        headers = {
            "Authorization": "Bearer " + self.api_token,
            "Content-Type": "application/json",
        }
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=CF_TIMEOUT) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raw = ""
            try:
                raw = exc.read().decode("utf-8", "replace")
            except Exception:
                pass
            try:
                body = json.loads(raw) if raw else {}
            except Exception:
                body = {}
            errors = body.get("errors") or []
            raise CloudflareError(_first_message(errors) or ("HTTP %d" % exc.code),
                                  exc.code, errors) from None
        except urllib.error.URLError as exc:
            raise CloudflareError("网络错误：%s" % (exc.reason,), 0) from None
        except CloudflareError:
            raise
        except Exception as exc:  # pragma: no cover - 兜底
            raise CloudflareError("请求失败：%s" % (exc,), 0) from None
        if not body.get("success"):
            errors = body.get("errors") or []
            raise CloudflareError(_first_message(errors) or "Cloudflare 返回失败", 0, errors)
        return body.get("result")

    # ------------------------------------------------------------ 凭据与账号

    def verify_token(self):
        """验证 Token 有效性，返回 {"status": "active", ...}。"""
        return self._request("GET", "/user/tokens/verify")

    def list_accounts(self):
        """Token 可见账号；无 Account 读取权限时可能返回空列表或抛错。"""
        result = self._request("GET", "/accounts")
        return [{"id": a.get("id", ""), "name": a.get("name", "")} for a in (result or [])]

    def list_zones(self):
        """域名列表；有 account_id 时只列该账号下的 Zone。"""
        path = "/zones?per_page=200"
        if self.account_id:
            path += "&account.id=" + self.account_id
        result = self._request("GET", path)
        return [
            {"id": z.get("id", ""), "name": z.get("name", ""), "status": z.get("status", "")}
            for z in (result or [])
        ]

    # ------------------------------------------------------------ 隧道

    def _tunnels_base(self) -> str:
        if not self.account_id:
            raise CloudflareError("缺少 Account ID：请先验证凭据自动获取，或在设置页手动填写", 0)
        return "/accounts/" + self.account_id + "/cfd_tunnel"

    def list_tunnels(self):
        """隧道列表；connections 为空即未连接（无活跃 cloudflared）。"""
        result = self._request("GET", self._tunnels_base())
        tunnels = []
        for t in result or []:
            conns = t.get("connections") or []
            tunnels.append({
                "id": t.get("id", ""),
                "name": t.get("name", ""),
                "created_at": t.get("created_at", ""),
                "deleted_at": t.get("deleted_at") or "",
                "connections": len(conns),
                "status": "active" if conns else "inactive",
            })
        return tunnels

    def get_tunnel(self, tunnel_id: str):
        return self._request("GET", self._tunnels_base() + "/" + tunnel_id)

    def create_tunnel(self, name: str):
        """创建命名隧道；config_src=cloudflare 走远程托管，
        这样 cloudflared 只需要 --token 就能启动，Ingress 由面板通过 API 下发。
        用 cloudflared（本地托管）的话隧道令牌跑不起来，规则也无处可写。"""
        name = (name or "").strip()
        if not name:
            raise CloudflareError("隧道名称不能为空", 0)
        if len(name) > 63:
            raise CloudflareError("隧道名称不能超过 63 个字符", 0)
        return self._request("POST", self._tunnels_base(), {"name": name, "config_src": "cloudflare"})

    def delete_tunnel(self, tunnel_id: str):
        """删除隧道；若仍有活跃连接，Cloudflare 会报错，需先停止连接器（M4）。"""
        return self._request("DELETE", self._tunnels_base() + "/" + tunnel_id)

    def get_tunnel_token(self, tunnel_id: str) -> str:
        """获取隧道连接令牌（eyJ...），供 cloudflared 使用；属于敏感凭据。"""
        return self._request("GET", self._tunnels_base() + "/" + tunnel_id + "/token")

    # ------------------------------------------------------------ 隧道 Ingress（远程托管）

    def get_tunnel_ingress(self, tunnel_id: str):
        """读取隧道当前 Ingress 规则。

        注意路径是 configurations（复数），写成 config 会被网关直接 404 且没有错误体。
        """
        try:
            result = self._request("GET", self._tunnels_base() + "/" + tunnel_id + "/configurations")
        except CloudflareError as exc:
            if exc.status == 404:
                return []
            raise
        config = (result or {}).get("config") or {}
        return config.get("ingress") or []

    def put_tunnel_ingress(self, tunnel_id: str, ingress):
        """整份覆盖隧道 Ingress。Cloudflare 要求最后一条是不带 hostname 的兜底规则。"""
        return self._request("PUT", self._tunnels_base() + "/" + tunnel_id + "/configurations",
                             {"config": {"ingress": ingress}})

    # ------------------------------------------------------------ DNS 记录

    def list_dns_records(self, zone_id: str, name: str = "", type: str = ""):
        """列出 Zone 下 DNS 记录；可过滤 name / type。"""
        path = "/zones/" + zone_id + "/dns_records?per_page=200"
        if name:
            path += "&name=" + urllib.parse.quote(name)
        if type:
            path += "&type=" + urllib.parse.quote(type)
        result = self._request("GET", path)
        return [
            {
                "id": r.get("id", ""),
                "type": r.get("type", ""),
                "name": r.get("name", ""),
                "content": r.get("content", ""),
                "proxied": bool(r.get("proxied")),
                "ttl": r.get("ttl", 1),
            }
            for r in (result or [])
        ]

    def create_dns_record(self, zone_id: str, name: str, content: str,
                          type: str = "CNAME", proxied: bool = True, ttl: int = 1):
        """创建 DNS 记录；返回记录 id。"""
        payload = {
            "type": type,
            "name": name,
            "content": content,
            "proxied": proxied,
            "ttl": ttl,
        }
        return self._request("POST", "/zones/" + zone_id + "/dns_records", payload)

    def update_dns_record(self, zone_id: str, record_id: str, name: str, content: str,
                          type: str = "CNAME", proxied: bool = True, ttl: int = 1):
        """原地更新 DNS 记录（不删重建，避免 DNS 解析中断）。"""
        payload = {
            "type": type,
            "name": name,
            "content": content,
            "proxied": proxied,
            "ttl": ttl,
        }
        return self._request(
            "PUT", "/zones/" + zone_id + "/dns_records/" + record_id, payload
        )

    def delete_dns_record(self, zone_id: str, record_id: str):
        return self._request("DELETE", "/zones/" + zone_id + "/dns_records/" + record_id)


def _first_message(errors) -> str:
    """把 CF errors 数组拼成一行中文可读消息。"""
    parts = []
    for e in errors or []:
        if isinstance(e, dict):
            msg = (e.get("message") or "").strip()
            code = e.get("code")
            if msg:
                parts.append(("（%s）%s" % (code, msg)) if code else msg)
        elif isinstance(e, str) and e.strip():
            parts.append(e.strip())
    return "；".join(parts)
