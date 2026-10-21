#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""开机自动连接：老配置迁移、记住上次隧道、失败退避重试。

这几条都是「重启 NAS 后隧道停在未连接」这个真实投诉的组成部分，
光看代码不容易发现，所以逐条锁住。
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import server  # noqa: E402


def make_manager(connector: dict, cloudflare: dict | None = None) -> server.ConnectorManager:
    mgr = server.ConnectorManager.__new__(server.ConnectorManager)
    if cloudflare is None:
        cloudflare = {"api_token": "t"}
    mgr.cfg = {"connector": dict(connector), "cloudflare": dict(cloudflare)}
    mgr.license_mgr = None
    mgr._stop_by_user = False
    return mgr


class AutoConnectConfigTest(unittest.TestCase):
    """load_config 的一次性迁移"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / "data").mkdir()
        self.data_dir = root / "data"
        self.config_path = self.data_dir / "workbench.json"
        patcher_data = mock.patch.object(server, "DATA_DIR", self.data_dir)
        patcher_cfg = mock.patch.object(server, "CONFIG_PATH", self.config_path)
        patcher_data.start()
        patcher_cfg.start()
        self.addCleanup(patcher_cfg.stop)
        self.addCleanup(patcher_data.stop)
        self.addCleanup(self.tmp.cleanup)

    def seed(self, stored: dict):
        self.config_path.write_text(json.dumps(stored), encoding="utf-8")

    def read_back(self) -> dict:
        return json.loads(self.config_path.read_text(encoding="utf-8"))

    def test_default_is_on(self):
        self.assertFalse(server.DEFAULT_CONFIG["connector"]["auto_connect"] is False,
                         "出厂就该自动连，否则买家重启 NAS 后隧道是停的")
        cfg = server.load_config()
        self.assertTrue(cfg["connector"]["auto_connect"])

    def test_migration_marker_not_in_default_config(self):
        # 标记一旦进了默认配置，深拷贝 + update 会让老配置看起来「已迁移过」，迁移永不发生
        self.assertNotIn("auto_connect_migrated", server.DEFAULT_CONFIG["panel"])

    def test_old_config_migrated_once(self):
        self.seed({
            "connector": {"auto_connect": False, "default_tunnel_id": ""},
            "panel": {"no_auth_run": True, "auth_mode_migrated": True},
        })
        cfg = server.load_config()
        self.assertTrue(cfg["connector"]["auto_connect"])
        self.assertTrue(self.read_back()["panel"]["auto_connect_migrated"])

    def test_user_turned_it_off_stays_off(self):
        self.seed({
            "connector": {"auto_connect": False},
            "panel": {"no_auth_run": True, "auth_mode_migrated": True},
        })
        server.load_config()          # 迁移发生在这里
        self.seed({                   # 模拟用户在设置页把自动连接关掉
            "connector": {"auto_connect": False},
            "panel": {"no_auth_run": True, "auth_mode_migrated": True,
                      "auto_connect_migrated": True},
        })
        cfg = server.load_config()
        self.assertFalse(cfg["connector"]["auto_connect"])


class RememberDefaultTunnelTest(unittest.TestCase):
    def test_records_and_persists(self):
        mgr = make_manager({"default_tunnel_id": ""})
        with mock.patch.object(server, "save_config") as save:
            mgr._remember_default_tunnel("aaaa-1111")
        self.assertEqual(mgr.cfg["connector"]["default_tunnel_id"], "aaaa-1111")
        save.assert_called_once()

    def test_unchanged_tunnel_does_not_rewrite_config(self):
        mgr = make_manager({"default_tunnel_id": "aaaa-1111"})
        with mock.patch.object(server, "save_config") as save:
            mgr._remember_default_tunnel("aaaa-1111")
            mgr._remember_default_tunnel("")
        save.assert_not_called()

    def test_save_failure_keeps_connection(self):
        mgr = make_manager({"default_tunnel_id": ""})
        with mock.patch.object(server, "save_config", side_effect=OSError("disk")):
            mgr._remember_default_tunnel("bbbb-2222")   # 不应抛出
        self.assertEqual(mgr.cfg["connector"]["default_tunnel_id"], "bbbb-2222")


class ResolveTunnelTest(unittest.TestCase):
    """开机自动连接该连哪一条：账号里往往留着几条没用的空隧道。"""

    TUNNELS = [{"id": "t-fnnas", "name": "fnnas"},
               {"id": "t-fnnn", "name": "fnnn"},
               {"id": "t-fnos", "name": "fnos"}]

    def setUp(self):
        import sqlite3
        # 共享缓存的内存库：WAL 的临时 sqlite 文件在 Windows 上删不掉（连接被进程缓存持有）
        self.conn = sqlite3.connect("file:boot_rules?mode=memory&cache=shared", uri=True)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("CREATE TABLE IF NOT EXISTS ingress_rules("
                          "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                          " tunnel_id TEXT NOT NULL, updated_at INTEGER NOT NULL)")
        self.conn.execute("DELETE FROM ingress_rules")
        self.conn.commit()
        patcher = mock.patch.object(server, "db_connect", lambda: self.conn)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.conn.close)

    def rules(self, rows):
        self.conn.executemany("INSERT INTO ingress_rules(tunnel_id, updated_at) VALUES(?, ?)", rows)
        self.conn.commit()

    def resolve(self, default_id: str):
        mgr = make_manager({"default_tunnel_id": default_id})
        client = mock.Mock()
        client.list_tunnels.return_value = self.TUNNELS
        with mock.patch.object(server, "CloudflareClient", return_value=client):
            return mgr._resolve_tunnel("")[0]

    def test_configured_default_wins(self):
        self.rules([("t-fnos", 300)])
        self.assertEqual(self.resolve("t-fnnn"), "t-fnnn")

    def test_prefers_tunnel_with_rules(self):
        self.rules([("t-fnos", 300), ("t-fnnas", 100)])
        self.assertEqual(self.resolve(""), "t-fnos")

    def test_latest_rule_wins_when_several(self):
        self.rules([("t-fnos", 100), ("t-fnnn", 300)])
        self.assertEqual(self.resolve(""), "t-fnnn")

    def test_falls_back_to_first_when_no_rules(self):
        self.assertEqual(self.resolve(""), "t-fnnas")

    def test_deleted_default_tunnel_falls_back(self):
        self.rules([("t-fnos", 300)])
        self.assertEqual(self.resolve("t-deleted"), "t-fnos")


class AutoConnectRetryTest(unittest.TestCase):
    def setUp(self):
        # 真实退避表最长 180 秒，测试里换成毫秒级
        self.patcher = mock.patch.object(server, "AUTO_CONNECT_DELAYS", (0.02, 0.02, 0.02))
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.events = []
        self.patcher_log = mock.patch.object(server, "add_connector_event",
                                             side_effect=lambda *a, **k: self.events.append(a))
        self.patcher_log.start()
        self.addCleanup(self.patcher_log.stop)
        add_log = mock.patch.object(server, "add_log")
        add_log.start()
        self.addCleanup(add_log.stop)

    def manager(self, cloudflare: dict | None = None, **connector):
        mgr = make_manager(dict({"auto_connect": True}, **connector), cloudflare)
        mgr.find_binary = lambda: "/usr/local/bin/cloudflared"  # type: ignore[assignment]
        return mgr

    def test_retries_until_network_recovers(self):
        mgr = self.manager()
        attempts = []

        def fake_start(tunnel_id="", auto=False):
            attempts.append(auto)
            if len(attempts) < 3:
                return {"ok": False, "error": "获取隧道列表失败：网络超时"}
            return {"ok": True, "pid": 42, "tunnel_id": "aaaa-1111"}

        mgr.start = fake_start  # type: ignore[assignment]
        mgr.auto_connect()
        self.assertEqual(len(attempts), 3)
        self.assertTrue(all(attempts), "自动连接必须走 auto=True，否则界面会当成手动启动")
        self.assertEqual(self.events, [], "成功不该记失败事件")

    def test_gives_up_after_last_attempt(self):
        mgr = self.manager()
        attempts = []

        def fake_start(tunnel_id="", auto=False):
            attempts.append(1)
            return {"ok": False, "error": "获取隧道令牌失败：timeout"}

        mgr.start = fake_start  # type: ignore[assignment]
        mgr.auto_connect()
        self.assertEqual(len(attempts), 3)
        self.assertEqual([e[0] for e in self.events], ["start_fail"])

    def test_stops_when_user_clicked_stop(self):
        mgr = self.manager()
        attempts = []

        def fake_start(tunnel_id="", auto=False):
            attempts.append(1)
            mgr._stop_by_user = True     # 用户在等待窗口里点了「停止」
            return {"ok": False, "error": "获取隧道列表失败：网络超时"}

        mgr.start = fake_start  # type: ignore[assignment]
        mgr.auto_connect()
        self.assertEqual(len(attempts), 1, "用户停了还继续抢着连，等于关不掉")

    def test_already_running_is_not_a_failure(self):
        mgr = self.manager()
        mgr.start = lambda tunnel_id="", auto=False: {"ok": False, "error": "连接器已在运行中"}
        mgr.auto_connect()
        self.assertEqual(self.events, [])

    def test_skipped_when_switch_off(self):
        mgr = self.manager(auto_connect=False)
        mgr.start = lambda **k: self.fail("关掉自动连接后不该启动")  # type: ignore[assignment]
        mgr.auto_connect()

    def test_skipped_without_credentials(self):
        mgr = self.manager(cloudflare={})
        mgr.start = lambda **k: self.fail("没配凭据不该尝试启动")  # type: ignore[assignment]
        mgr.auto_connect()

    def test_skipped_when_license_inactive(self):
        mgr = self.manager()
        gate = mock.Mock()
        gate.is_valid.return_value = False
        mgr.license_mgr = gate
        mgr.start = lambda **k: self.fail("未激活不该启动连接器")  # type: ignore[assignment]
        mgr.auto_connect()


class ConnectorTunnelNameTest(unittest.TestCase):
    """状态接口要能给出隧道名，前端才能不等云端列表就先解锁规则表单。"""

    def test_resolve_tunnel_remembers_name(self):
        mgr = make_manager({"default_tunnel_id": ""})
        fake = mock.Mock()
        fake.list_tunnels.return_value = [
            {"id": "a" * 32, "name": "alpha"},
            {"id": "b" * 32, "name": "beta"},
        ]
        with mock.patch.object(server, "CloudflareClient", return_value=fake):
            resolved, err = mgr._resolve_tunnel("b" * 32)
        self.assertEqual(resolved, "b" * 32)
        self.assertIsNone(err)
        self.assertEqual(mgr._resolved_tunnel_name, "beta")


if __name__ == "__main__":
    unittest.main()
