#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地模拟 Worker 授权服务，仅用于测试，不参与打包。"""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class MockLicenseState:
    def __init__(self):
        self.records = {}
        self.revoked_serials = set()
        self.bound_serials = {}
        self.reports = []
        self.lock = threading.Lock()

    def seed(self, code, revoked=False):
        with self.lock:
            self.records[code] = {
                "code": code,
                "bound_machine": "",
                "bound_at": None,
                "activated_at": None,
                "last_verify_at": None,
                "verify_count": 0,
                "revoked": revoked,
                "note": "mock",
            }

    def get(self, code):
        with self.lock:
            return self.records.get(code)


def make_handler(state):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def _json(self, status, payload):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            length = int(self.headers.get("Content-Length") or 0)
            try:
                return json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            except Exception:
                return {}

        def do_GET(self):
            if self.path == "/health":
                self._json(200, {"ok": True, "service": "kay-license-mock"})
            else:
                self._json(404, {"ok": False, "reason": "not_found", "error": "not found"})

        def do_POST(self):
            body = self._body()
            if self.path == "/_mock/seed":
                state.seed(body["code"], bool(body.get("revoked")))
                self._json(200, {"ok": True})
                return
            if self.path == "/_mock/mutate":
                record = state.get(body.get("code"))
                if not record:
                    self._json(404, {"ok": False, "error": "missing"})
                    return
                with state.lock:
                    if "revoked" in body:
                        record["revoked"] = bool(body["revoked"])
                    if body.get("unbind"):
                        record["bound_machine"] = ""
                        record["bound_at"] = None
                self._json(200, {"ok": True, "record": record})
                return
            if self.path == "/_mock/offline":
                with state.lock:
                    serial = int(body.get("serial") or 0)
                    if body.get("revoked"):
                        state.revoked_serials.add(serial)
                    else:
                        state.revoked_serials.discard(serial)
                    if body.get("unbind"):
                        state.bound_serials.pop(serial, None)
                self._json(200, {"ok": True})
                return
            if self.path == "/offline/report":
                serial = int(body.get("serial") or 0)
                machine = str(body.get("machine_code") or "")
                now = int(time.time())
                with state.lock:
                    state.reports.append({"serial": serial, "machine_code": machine, "at": now})
                    revoked = serial in state.revoked_serials
                    bound = state.bound_serials.get(serial, "")
                    bound_now = mismatch = False
                    if not revoked and machine:
                        if not bound:
                            state.bound_serials[serial] = machine
                            bound_now = True
                        elif bound != machine:
                            mismatch = True
                if revoked:
                    self._json(200, {"ok": True, "revoked": True, "error": "离线授权已被吊销"})
                elif mismatch:
                    self._json(200, {"ok": True, "revoked": False, "device_mismatch": True,
                                     "reported_at": now,
                                     "error": "该授权码已绑定其他设备，如需换机请联系卖家解绑"})
                else:
                    payload = {"ok": True, "revoked": False, "reported_at": now}
                    if bound_now:
                        payload["bound"] = True
                    self._json(200, payload)
                return
            if self.path in ("/activate", "/verify"):
                code = str(body.get("code") or "")
                machine = str(body.get("machine_code") or "")
                record = state.get(code)
                if not record:
                    self._json(404, {"ok": False, "reason": "not_found", "error": "卡密不存在"})
                    return
                if record["revoked"]:
                    self._json(403, {"ok": False, "reason": "revoked", "error": "卡密已被吊销"})
                    return
                now = int(time.time())
                with state.lock:
                    if self.path == "/activate":
                        if record["bound_machine"] and record["bound_machine"] != machine:
                            self._json(409, {"ok": False, "reason": "device_mismatch",
                                             "error": "已绑定其他设备"})
                            return
                        if not record["bound_machine"]:
                            record["bound_machine"] = machine
                            record["bound_at"] = now
                            record["activated_at"] = record["activated_at"] or now
                        record["last_verify_at"] = now
                        record["verify_count"] += 1
                        self._json(200, {"ok": True, "license": record})
                        return
                    if not record["bound_machine"]:
                        self._json(409, {"ok": False, "reason": "not_activated", "error": "尚未激活"})
                        return
                    if record["bound_machine"] != machine:
                        self._json(409, {"ok": False, "reason": "device_mismatch",
                                         "error": "设备不一致"})
                        return
                    record["last_verify_at"] = now
                    record["verify_count"] += 1
                    self._json(200, {"ok": True, "license": record, "verified_at": now})
                    return
            self._json(404, {"ok": False, "reason": "not_found", "error": "not found"})

    return Handler


def start_mock(port=0):
    state = MockLicenseState()
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(state))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, state, "http://127.0.0.1:%d" % server.server_address[1]
