#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""规则删除的即时响应、后台清理与读取缓存。

真实投诉是「点删除半天没反应 / 提示删除失败，刷新后其实已经删了」。
根因是删除请求串行等 3 次 Cloudflare 往返，而前端 15 秒就判定失败。
这里锁住新契约：本地落库后立刻回包，DNS 与路由清理在后台完成。
"""
import contextlib
import sqlite3
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import server  # noqa: E402

DB_URI = "file:ingress_async?mode=memory&cache=shared"


@contextlib.contextmanager
def fake_db():
    conn = sqlite3.connect(DB_URI, uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def make_handler() -> "server.PanelHandler":
    handler = server.PanelHandler.__new__(server.PanelHandler)
    handler.cfg = {
        "cloudflare": {"api_token": "test-token", "account_id": "acc"},
        "connector": {},
        "panel": {},
    }
    handler.sent = []

    def send(payload, status=200, headers=None):
        handler.sent.append((status, payload))

    def send_error(status, message, log=False):
        handler.sent.append((status, {"ok": False, "error": message}))

    handler._send_json = send
    handler._send_error_json = send_error
    return handler


class BlockingClient:
    """delete_dns_record 会卡住，用来证明删除接口不再等它。"""

    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.deleted = []
        self.puts = []

    def delete_dns_record(self, zone_id, record_id):
        self.started.set()
        self.release.wait(3)
        self.deleted.append((zone_id, record_id))

    def get_tunnel_ingress(self, tunnel_id):
        return [
            {"hostname": "del.example.com", "service": "http://127.0.0.1:8080"},
            {"hostname": "manual.example.com", "service": "http://192.168.1.9:9000"},
            {"service": "http_status:404"},
        ]

    def put_tunnel_ingress(self, tunnel_id, ingress):
        self.puts.append((tunnel_id, ingress))


class InstantClient(BlockingClient):
    def delete_dns_record(self, zone_id, record_id):
        self.deleted.append((zone_id, record_id))


class DeferredThread:
    """只记录目标函数，由测试决定何时执行，避免和时间赛跑。"""

    created = []

    def __init__(self, target=None, name=None, daemon=None, args=(), kwargs=None):
        self.target = target
        self.args = args
        self.kwargs = kwargs or {}
        DeferredThread.created.append(self)

    def start(self):
        pass

    def run(self):
        self.target(*self.args, **self.kwargs)


class IngressAsyncTest(unittest.TestCase):
    def setUp(self):
        self.keepalive = sqlite3.connect(DB_URI, uri=True)
        with fake_db() as conn:
            conn.execute("DROP TABLE IF EXISTS ingress_rules")
            conn.execute(
                "CREATE TABLE ingress_rules("
                " id INTEGER PRIMARY KEY AUTOINCREMENT,"
                " subdomain TEXT NOT NULL, zone_id TEXT NOT NULL, zone_name TEXT NOT NULL,"
                " tunnel_id TEXT NOT NULL, tunnel_name TEXT NOT NULL, service TEXT NOT NULL,"
                " cf_record_id TEXT NOT NULL DEFAULT '',"
                " created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,"
                " UNIQUE(subdomain, zone_id))"
            )
        self.addCleanup(self.keepalive.close)
        patcher_db = mock.patch.object(server, "db_connect", fake_db)
        patcher_log = mock.patch.object(server, "add_log", mock.Mock())
        patcher_db.start()
        patcher_log.start()
        self.addCleanup(patcher_log.stop)
        self.addCleanup(patcher_db.stop)
        server._cf_cache_clear()

    def add_rule(self, subdomain, tunnel_id="t1", zone_id="z1", zone_name="example.com",
                 service="http://127.0.0.1:8080", record_id="rec1"):
        with fake_db() as conn:
            cur = conn.execute(
                "INSERT INTO ingress_rules(subdomain, zone_id, zone_name, tunnel_id, tunnel_name,"
                " service, cf_record_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (subdomain, zone_id, zone_name, tunnel_id, "tunnel-" + tunnel_id,
                 service, record_id, 1, 1),
            )
        return cur.lastrowid

    def test_delete_returns_before_cloudflare_finishes(self):
        rule_id = self.add_rule("del")
        self.add_rule("keep", record_id="rec2")
        client = BlockingClient()
        handler = make_handler()

        with mock.patch.object(server, "CloudflareClient", return_value=client):
            started = time.monotonic()
            server.PanelHandler._api_ingress_delete(handler, str(rule_id))
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, 0.25, "删除接口不应等 Cloudflare 往返")
            self.assertEqual(handler.sent[0][0], 200)
            self.assertEqual(handler.sent[0][1], {"ok": True, "sync_queued": True})
            with fake_db() as conn:
                left = conn.execute("SELECT COUNT(*) AS n FROM ingress_rules").fetchone()["n"]
            self.assertEqual(left, 1, "本地规则必须立刻删掉")

            self.assertTrue(client.started.wait(2), "后台清理线程没有启动")
            client.release.set()
            deadline = time.monotonic() + 3
            while not client.puts and time.monotonic() < deadline:
                time.sleep(0.01)

        self.assertEqual(client.deleted, [("z1", "rec1")])
        self.assertEqual(len(client.puts), 1)
        tunnel_id, ingress = client.puts[0]
        self.assertEqual(tunnel_id, "t1")
        hosts = [item.get("hostname") for item in ingress]
        self.assertNotIn("del.example.com", hosts, "删掉的规则必须从路由里点名摘掉")
        self.assertIn("manual.example.com", hosts, "后台手写路由要保留")
        self.assertIn("keep.example.com", hosts)
        self.assertEqual(ingress[-1], {"service": "http_status:404"})

    def test_reused_dns_record_is_not_deleted(self):
        rule_id = self.add_rule("del")
        client = InstantClient()
        handler = make_handler()
        DeferredThread.created = []

        with mock.patch.object(server, "CloudflareClient", return_value=client), \
                mock.patch.object(server.threading, "Thread", DeferredThread):
            server.PanelHandler._api_ingress_delete(handler, str(rule_id))
            # 删除后马上重建同名规则，upsert 会复用同一条 DNS 记录
            self.add_rule("del-again", record_id="rec1")
            self.assertEqual(len(DeferredThread.created), 1)
            DeferredThread.created[0].run()

        self.assertEqual(client.deleted, [], "记录已被新规则接管，不能再删")
        logs = [str(c.args[1]) for c in server.add_log.call_args_list]
        self.assertTrue(any("跳过删除" in line for line in logs), logs)

    def test_cf_cache_does_not_cache_errors(self):
        calls = []

        def boom():
            calls.append("boom")
            raise server.CloudflareError("cf down")

        value, error = server._cf_cached("k", 60, boom)
        self.assertIsNone(value)
        self.assertIsInstance(error, server.CloudflareError)

        value, error = server._cf_cached("k", 60, lambda: calls.append("ok") or "fresh")
        self.assertEqual((value, error), ("fresh", None))
        self.assertEqual(len(calls), 2, "失败结果不应被缓存")

        server._cf_cached("k", 60, lambda: calls.append("hit") or "stale")
        self.assertEqual(len(calls), 2, "TTL 内应命中缓存")

        server._cf_cache_clear()
        server._cf_cached("k", 60, lambda: calls.append("after-clear") or "new")
        self.assertEqual(len(calls), 3)


class HangingClient:
    """每个 Cloudflare 读都慢 0.2 秒。"""

    DELAY = 0.2

    def __init__(self, names):
        self.names = names

    def list_dns_records(self, zone_id, name=""):
        time.sleep(self.DELAY)
        return [{"name": n} for n in self.names.get(zone_id, [])]

    def get_tunnel_ingress(self, tunnel_id):
        time.sleep(self.DELAY)
        return [{"hostname": h, "service": "http://127.0.0.1:8080"} for h in self.names.get(tunnel_id, [])] + \
            [{"service": "http_status:404"}]


class IngressListParallelTest(unittest.TestCase):
    def setUp(self):
        self.keepalive = sqlite3.connect(DB_URI, uri=True)
        with fake_db() as conn:
            conn.execute("DROP TABLE IF EXISTS ingress_rules")
            conn.execute(
                "CREATE TABLE ingress_rules("
                " id INTEGER PRIMARY KEY AUTOINCREMENT,"
                " subdomain TEXT NOT NULL, zone_id TEXT NOT NULL, zone_name TEXT NOT NULL,"
                " tunnel_id TEXT NOT NULL, tunnel_name TEXT NOT NULL, service TEXT NOT NULL,"
                " cf_record_id TEXT NOT NULL DEFAULT '',"
                " created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,"
                " UNIQUE(subdomain, zone_id))"
            )
            for i in range(2):
                conn.execute(
                    "INSERT INTO ingress_rules(subdomain, zone_id, zone_name, tunnel_id, tunnel_name,"
                    " service, cf_record_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                    ("r%d" % i, "z%d" % i, "example.com", "t%d" % i, "tunnel", "http://127.0.0.1:80",
                     "rec%d" % i, 1, 1),
                )
        self.addCleanup(self.keepalive.close)
        patcher_db = mock.patch.object(server, "db_connect", fake_db)
        patcher_db.start()
        self.addCleanup(patcher_db.stop)
        server._cf_cache_clear()

    def test_zone_and_tunnel_checks_run_concurrently(self):
        names = {"z0": ["r0.example.com"], "z1": ["r1.example.com"],
                 "t0": ["r0.example.com"], "t1": ["r1.example.com"]}
        handler = make_handler()
        with mock.patch.object(server, "CloudflareClient", return_value=HangingClient(names)):
            started = time.monotonic()
            server.PanelHandler._api_ingresses_list(handler)
            elapsed = time.monotonic() - started

        # 串行需要 4 × 0.2 = 0.8 秒；并发只等最慢的一次
        self.assertLess(elapsed, 0.6, "DNS / 路由检查应该并发发出")
        payload = handler.sent[0][1]
        self.assertTrue(payload["ok"])
        for ing in payload["ingresses"]:
            self.assertFalse(ing["dns_missing"])
            self.assertFalse(ing["route_missing"])


if __name__ == "__main__":
    unittest.main()
