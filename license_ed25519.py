#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# SPDX-License-Identifier: MIT
"""纯 Python Ed25519 验签（RFC 8032）。

面板只做验签，私钥永不进面板，因此不引入任何第三方依赖。
实现按 RFC 8032 6.2.3 的验证流程，采用仿射坐标 + 余因子验证（cofactored）。
"""

import hashlib

_Q = 2 ** 255 - 19
_L = 2 ** 252 + 27742317777372353535851937790883648493
_D = (-121665 * pow(121666, _Q - 2, _Q)) % _Q
_SQRT_M1 = pow(2, (_Q - 1) // 4, _Q)


def _inv(value: int) -> int:
    return pow(value % _Q, _Q - 2, _Q)


def _recover_x(y: int, sign: int):
    if y >= _Q:
        return None
    xx = (y * y - 1) * _inv(_D * y * y + 1) % _Q
    x = pow(xx, (_Q + 3) // 8, _Q)
    if (x * x - xx) % _Q != 0:
        x = x * _SQRT_M1 % _Q
    if (x * x - xx) % _Q != 0:
        return None
    if x % 2 != 0:
        x = _Q - x
    if x % 2 != sign:
        x = _Q - x
    if x >= _Q:
        return None
    return x


def _on_curve(point) -> bool:
    x, y = point
    return (-x * x + y * y - 1 - _D * x * x * y * y) % _Q == 0


def _decode_point(data: bytes):
    if len(data) != 32:
        raise ValueError("点编码长度必须为 32 字节")
    raw = int.from_bytes(data, "little")
    sign = (raw >> 255) & 1
    y = raw & (2 ** 255 - 1)
    x = _recover_x(y, sign)
    if x is None:
        raise ValueError("非法的点编码")
    point = (x, y)
    if not _on_curve(point):
        raise ValueError("点不在曲线上")
    return point


def _add(p, q):
    x1, y1 = p
    x2, y2 = q
    dy = _D * x1 * x2 * y1 * y2 % _Q
    den_x = (1 + dy) % _Q
    den_y = (1 - dy) % _Q
    if den_x == 0 or den_y == 0:
        raise ValueError("非法的加法输入")
    x3 = (x1 * y2 + x2 * y1) * _inv(den_x) % _Q
    y3 = (y1 * y2 + x1 * x2) * _inv(den_y) % _Q
    return (x3, y3)


def _multiply(point, scalar: int):
    result = (0, 1)
    while scalar > 0:
        if scalar & 1:
            result = _add(result, point)
        point = _add(point, point)
        scalar >>= 1
    return result


def _mul_cofactor(point):
    double = _add(point, point)
    quad = _add(double, double)
    return _add(quad, quad)


_BY = 4 * _inv(5) % _Q
_G = (_recover_x(_BY, 0), _BY)


def public_key_from_hex(text: str) -> bytes:
    raw = bytes.fromhex(str(text or "").strip())
    if len(raw) != 32:
        raise ValueError("公钥必须是 64 位十六进制")
    return raw


def verify(message: bytes, signature: bytes, public_key: bytes) -> bool:
    """校验 Ed25519 签名；任何编码/范围异常都按验签失败处理。"""
    try:
        if len(signature) != 64 or len(public_key) != 32:
            return False
        r_point = _decode_point(signature[:32])
        a_point = _decode_point(public_key)
        s = int.from_bytes(signature[32:], "little")
        if s >= _L:
            return False
        h = int.from_bytes(hashlib.sha512(signature[:32] + public_key + message).digest(), "little")
        left = _multiply(_G, s)
        right = _add(r_point, _multiply(a_point, h))
        return _mul_cofactor(left) == _mul_cofactor(right)
    except Exception:
        return False
