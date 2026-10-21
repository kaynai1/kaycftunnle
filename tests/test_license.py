#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""license.py 的端到端测试：真实 HTTP 请求打到本地模拟 Worker。

离线授权码夹具见 tests/offline_fixtures.py，重新生成方式：
  node --input-type=module -e 'import {issueOfflineLicense} from "./license-worker/src/offline.mjs"; ...'
私钥用 RFC 8032 第一组测试向量的种子，仅用于测试。
"""
import json
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

import license as license_module  # noqa: E402
import license_ed25519  # noqa: E402
import offline_fixtures as offline  # noqa: E402
from license import (  # noqa: E402
    LicenseManager,
    _pack_machine,
    _unpack_machine,
    compute_machine_code,
    decode_offline_license,
    normalize_code,
    normalize_offline_code,
    verify_offline_license,
)
from mock_license_server import start_mock  # noqa: E402


def mock_post(path, payload):
    request = urllib.request.Request(
        BASE_URL + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))

SERVER = None
STATE = None
BASE_URL = ""


def setUpModule():
    global SERVER, STATE, BASE_URL
    SERVER, STATE, BASE_URL = start_mock()


def tearDownModule():
    if SERVER:
        SERVER.shutdown()
        SERVER.server_close()


class LicenseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name)
        self.locked = []
        self.mgr = LicenseManager(
            self.data_dir,
            default_server_url=BASE_URL,
            verify_interval=6 * 3600,
            grace_days=7,
            on_locked=lambda reason, message: self.locked.append((reason, message)),
        )

    def tearDown(self):
        self.mgr.stop_background()
        self.tmp.cleanup()

    def seed(self, code):
        STATE.seed(code)

    def test_initial_state_and_machine_code(self):
        status = self.mgr.status()
        self.assertFalse(status["activated"])
        self.assertFalse(status["valid"])
        self.assertEqual(status["state"], "unactivated")
        self.assertRegex(status["machine_code"], r"^NAS-[0-9A-HJKMNP-TV-Z]{4}-")
        self.assertEqual(status["machine_code"], compute_machine_code(self.data_dir))
        # 同一数据目录下机器码稳定
        self.assertEqual(status["machine_code"], self.mgr.machine_code)

    def test_machine_code_cached_across_restarts(self):
        legacy = self.data_dir / "machine_id"
        legacy.write_text("0123456789abcdef0123456789abcdef\n", encoding="utf-8")
        first = compute_machine_code(self.data_dir)
        self.assertEqual(legacy.read_text(encoding="utf-8").strip(), "0123456789abcdef0123456789abcdef")
        # 旧格式（无来源前缀）保持原机器码不变，且文件不被改写
        self.assertEqual(first, compute_machine_code(self.data_dir))
        reopened = LicenseManager(self.data_dir, default_server_url=BASE_URL)
        self.assertEqual(reopened.machine_code, first)

    def test_normalize_code(self):
        self.assertEqual(normalize_code("kay-aaaa-bbbb-cccc"), "KAY-AAAA-BBBB-CCCC")
        self.assertEqual(normalize_code("KAYAAAABBBBCCCC"), "KAY-AAAA-BBBB-CCCC")
        self.assertEqual(normalize_code("AAAA-BBBB-CCCC"), "KAY-AAAA-BBBB-CCCC")
        self.assertEqual(normalize_code("KAY-AAAA-BBBB-CCCI"), "")
        self.assertEqual(normalize_code("KAY-AAAA-BBBB-CCC"), "")

    def test_server_url_validation(self):
        self.mgr.set_server_url("http://127.0.0.1:8792/")
        self.assertEqual(self.mgr.status()["server_url"], "http://127.0.0.1:8792")
        with self.assertRaises(ValueError):
            self.mgr.set_server_url("http://example.com")
        with self.assertRaises(ValueError):
            self.mgr.set_server_url("ftp://example.com")

    def test_activate_and_verify(self):
        code = "KAY-AAAA-BBBB-CCCC"
        self.seed(code)

        bad = self.mgr.activate("KAY-XXX")
        self.assertFalse(bad["ok"])
        self.assertEqual(bad["reason"], "invalid_code")

        good = self.mgr.activate(code.lower())
        self.assertTrue(good["ok"], good)
        status = self.mgr.status()
        self.assertTrue(status["valid"])
        self.assertEqual(status["state"], "active")
        self.assertEqual(status["code"], code)
        self.assertEqual(status["code_masked"], "KAY-****-****-CCCC")
        self.assertGreater(status["last_verified_at"], 0)

        again = self.mgr.activate(code)
        self.assertFalse(again["ok"])
        self.assertEqual(again["reason"], "already_activated")

        verified = self.mgr.verify_now(force=True)
        self.assertTrue(verified["ok"], verified)
        record = STATE.get(code)
        self.assertEqual(record["bound_machine"], self.mgr.machine_code)
        self.assertGreaterEqual(record["verify_count"], 2)

    def test_second_device_rejected(self):
        code = "KAY-AAAA-BBBB-CCCD"
        self.seed(code)
        first = self.mgr.activate(code)
        self.assertTrue(first["ok"], first)

        with tempfile.TemporaryDirectory() as other_dir:
            other = LicenseManager(Path(other_dir), default_server_url=BASE_URL)
            result = other.activate(code)
            self.assertFalse(result["ok"])
            self.assertEqual(result["reason"], "device_mismatch")
            self.assertNotEqual(other.machine_code, self.mgr.machine_code)

    def test_revoked_locks_and_calls_callback(self):
        code = "KAY-AAAA-BBBB-CCCE"
        self.seed(code)
        self.assertTrue(self.mgr.activate(code)["ok"])

        STATE.records[code]["revoked"] = True
        result = self.mgr.verify_now(force=True)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "revoked")

        status = self.mgr.status()
        self.assertFalse(status["valid"])
        self.assertEqual(status["state"], "revoked")
        self.assertTrue(status["revoked"])
        self.assertEqual(self.locked, [("revoked", "卡密已被吊销")])

        # 吊销后允许输入新卡密
        new_code = "KAY-AAAA-BBBB-CCCF"
        self.seed(new_code)
        renewed = self.mgr.activate(new_code)
        self.assertTrue(renewed["ok"], renewed)
        self.assertEqual(self.mgr.status()["state"], "active")

    def test_unbind_then_reactivate(self):
        code = "KAY-AAAA-BBBB-CCCG"
        self.seed(code)
        self.assertTrue(self.mgr.activate(code)["ok"])

        with STATE.lock:
            STATE.records[code]["bound_machine"] = ""
            STATE.records[code]["bound_at"] = None

        locked = self.mgr.verify_now(force=True)
        self.assertFalse(locked["ok"])
        self.assertEqual(locked["reason"], "not_activated")
        self.assertEqual(self.mgr.status()["state"], "invalid")

        # 同一台设备可以用原卡密重新绑定
        again = self.mgr.activate(code)
        self.assertTrue(again["ok"], again)
        self.assertTrue(self.mgr.status()["valid"])

    def test_grace_and_expiry(self):
        code = "KAY-AAAA-BBBB-CCCH"
        self.seed(code)
        self.assertTrue(self.mgr.activate(code)["ok"])

        self.mgr._state["last_verified_at"] = int(time.time() - 2 * 86400)
        status = self.mgr.status()
        self.assertTrue(status["valid"])
        self.assertEqual(status["state"], "grace")
        self.assertGreater(status["grace_left_seconds"], 4 * 86400)

        self.mgr._state["last_verified_at"] = int(time.time() - 8 * 86400)
        status = self.mgr.status()
        self.assertFalse(status["valid"])
        self.assertEqual(status["state"], "expired")

    def test_network_failure_keeps_license_usable(self):
        code = "KAY-AAAA-BBBB-CCCJ"
        self.seed(code)
        self.assertTrue(self.mgr.activate(code)["ok"])

        # 授权服务临时不可达：只记录错误，不锁定，当前仍在有效期内
        self.mgr._state["server_url"] = "http://127.0.0.1:9"
        self.mgr.timeout = 2
        result = self.mgr.verify_now(force=True)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "network")
        status = self.mgr.status()
        self.assertTrue(status["valid"])
        self.assertIn("无法连接", status["last_error"])


class RedactLicenseTests(unittest.TestCase):
    """下发给浏览器的响应必须脱敏：授权地址与完整卡密都不出面板。"""

    def test_strips_server_url_and_code(self):
        from server import redact_license

        payload = redact_license({
            "ok": True,
            "server_url": "https://kay-license.example.workers.dev",
            "code": "KAY-AAAA-BBBB-CCCC",
            "code_masked": "KAY-****-****-CCCC",
            "status": {
                "server_url": "http://127.0.0.1:8793",
                "code": "KAY-AAAA-BBBB-CCCC",
            },
        })
        self.assertNotIn("server_url", payload)
        self.assertNotIn("code", payload)
        self.assertTrue(payload["server_configured"])
        self.assertEqual(payload["code_masked"], "KAY-****-****-CCCC")
        self.assertNotIn("server_url", payload["status"])
        self.assertNotIn("code", payload["status"])
        self.assertTrue(payload["status"]["server_configured"])

    def test_unconfigured_server_marks_false(self):
        from server import redact_license

        payload = redact_license({"server_url": "", "code": ""})
        self.assertFalse(payload["server_configured"])


class OfflineLicenseTests(unittest.TestCase):
    """离线授权码：本地验签、绑定校验、到期、报到吊销。夹具由 RFC 8032 测试私钥签发。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name)
        # 模拟服务的绑定台账跨用例保留，固定机器码才不会让上一个用例绑住的码把这里判成换机
        (self.data_dir / "machine_id").write_text("persisted:offline-fixture-machine-0001\n", encoding="utf-8")
        self.public_key = bytes.fromhex(offline.PUBLIC_KEY_HEX)
        self.addCleanup(self.tmp.cleanup)
        original = license_module.OFFLINE_PUBLIC_KEY
        license_module.OFFLINE_PUBLIC_KEY = offline.PUBLIC_KEY_HEX
        self.addCleanup(setattr, license_module, "OFFLINE_PUBLIC_KEY", original)
        self.locked = []
        self.mgr = LicenseManager(
            self.data_dir,
            default_server_url=BASE_URL,
            verify_interval=6 * 3600,
            on_locked=lambda reason, message: self.locked.append((reason, message)),
        )

    def test_disabled_without_public_key(self):
        license_module.OFFLINE_PUBLIC_KEY = ""
        result = self.mgr.activate_offline(offline.PERMANENT_ANY)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "offline_disabled")

    def test_activate_permanent(self):
        result = self.mgr.activate_offline(offline.PERMANENT_ANY)
        self.assertTrue(result["ok"], result)
        status = self.mgr.status()
        self.assertEqual(status["mode"], "offline")
        self.assertTrue(status["valid"])
        self.assertEqual(status["state"], "active")
        self.assertEqual(status["serial"], 900001)
        self.assertEqual(status["expires_at"], 0)
        self.assertEqual(status["code_masked"][:4], "KAYO")
        self.assertNotIn("offline_code", json.dumps(status))

    def test_expiring_license_reports_days(self):
        status = self.mgr.activate_offline(offline.EXPIRING_ANY)["status"]
        self.assertTrue(status["valid"])
        self.assertIn("剩余", status["message"])

    def test_expired_rejected(self):
        result = self.mgr.activate_offline(offline.EXPIRED_ANY)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "expired")
        self.assertFalse(self.mgr.status()["activated"])

    def test_tampered_rejected(self):
        bad = offline.PERMANENT_ANY[:-6] + "AAAAA"
        result = self.mgr.activate_offline(bad)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "bad_signature")

    def test_machine_bound_license_rejected_on_other_device(self):
        result = verify_offline_license(offline.BOUND_PERM, "NAS-0000-0000-0000",
                                        public_key=self.public_key)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "device_mismatch")
        self.assertIn("NAS-AAAA-BBBB-CCCC", result["error"])
        same = verify_offline_license(offline.BOUND_PERM, "NAS-AAAA-BBBB-CCCC",
                                      public_key=self.public_key)
        self.assertTrue(same["ok"], same)

    def test_license_json_edit_is_ignored(self):
        self.assertTrue(self.mgr.activate_offline(offline.EXPIRING_ANY)["ok"])
        stored = json.loads((self.data_dir / "license.json").read_text(encoding="utf-8"))
        stored["expires_at"] = 1  # 手改到期时间
        (self.data_dir / "license.json").write_text(json.dumps(stored), encoding="utf-8")

        reopened = LicenseManager(self.data_dir, default_server_url=BASE_URL)
        status = reopened.status()
        self.assertTrue(status["valid"], status)
        self.assertEqual(status["expires_at"], 4102444800)

    def test_offline_stays_valid_when_server_unreachable(self):
        self.assertTrue(self.mgr.activate_offline(offline.PERMANENT_ANY)["ok"])
        self.mgr._state["server_url"] = "http://127.0.0.1:9"
        self.mgr._save()
        result = self.mgr.verify_now(force=True)
        self.assertTrue(result["ok"], result)
        self.assertFalse(result["reported"])
        self.assertTrue(self.mgr.status()["valid"])
        self.assertEqual(self.locked, [])

    def test_report_lets_server_revoke(self):
        self.assertTrue(self.mgr.activate_offline(offline.PERMANENT_ANY)["ok"])
        first = self.mgr.verify_now(force=True)
        self.assertTrue(first["reported"], first)
        self.assertTrue(self.mgr.status()["valid"])

        mock_post("/_mock/offline", {"serial": 900001, "revoked": True})
        second = self.mgr.verify_now(force=True)
        self.assertFalse(second["ok"])
        self.assertEqual(second["reason"], "revoked")
        status = self.mgr.status()
        self.assertFalse(status["valid"])
        self.assertTrue(status["revoked"])
        self.assertEqual(self.locked[-1][0], "revoked")

    def test_batch_code_binds_on_first_activation(self):
        result = self.mgr.activate_offline(offline.EXPIRING_ANY)
        self.assertTrue(result["ok"], result)
        self.assertEqual(STATE.bound_serials.get(900002), self.mgr.machine_code)

    def test_same_code_on_another_device_is_locked(self):
        self.assertTrue(self.mgr.activate_offline(offline.EXPIRING_ANY)["ok"], "买家机器先激活应成功")

        other_tmp = tempfile.TemporaryDirectory()
        self.addCleanup(other_tmp.cleanup)
        other_dir = Path(other_tmp.name)
        (other_dir / "machine_id").write_text("persisted:offline-stealer-machine-0002\n", encoding="utf-8")
        other = LicenseManager(other_dir, default_server_url=BASE_URL,
                               on_locked=lambda reason, message: self.locked.append((reason, message)))

        result = other.activate_offline(offline.EXPIRING_ANY)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "device_mismatch")
        status = other.status()
        self.assertFalse(status["valid"])
        self.assertEqual(self.locked[-1][0], "device_mismatch")

        mock_post("/_mock/offline", {"serial": 900002, "unbind": True})
        self.assertTrue(other.activate_offline(offline.EXPIRING_ANY)["ok"], "解绑后新设备可以接管")

    def test_online_and_offline_are_exclusive(self):
        code = "KAY-AAAA-BBBB-CCCJ"
        STATE.seed(code)
        self.assertTrue(self.mgr.activate(code)["ok"])
        self.assertEqual(self.mgr.status()["mode"], "online")
        self.assertTrue(self.mgr.activate_offline(offline.PERMANENT_ANY)["ok"])
        self.assertEqual(self.mgr.status()["mode"], "offline")
        self.assertEqual(self.mgr._state["code"], "")


class OfflineFormatTests(unittest.TestCase):
    def test_ed25519_matches_rfc8032_vectors(self):
        vectors = (
            ("", "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb882159"
                 "0a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
        )
        public_key = bytes.fromhex(offline.PUBLIC_KEY_HEX)
        for message, signature in vectors:
            self.assertTrue(license_ed25519.verify(message.encode(), bytes.fromhex(signature),
                                                   public_key))
        self.assertFalse(license_ed25519.verify(b"x", bytes.fromhex(vectors[0][1]), public_key))

    def test_machine_code_roundtrip(self):
        for code in ("NAS-AAAA-BBBB-CCCC", "NAS-EH2E-3MH9-4T9D", "NAS-0000-0000-0000"):
            self.assertEqual(_unpack_machine(_pack_machine(code)), code)
            self.assertEqual(_unpack_machine(_pack_machine(code.replace("-", ""))), code)

    def test_fixture_codes_decode(self):
        for text in (offline.PERMANENT_ANY, offline.EXPIRING_ANY, offline.EXPIRED_ANY,
                     offline.BOUND_PERM):
            parsed = decode_offline_license(text)
            self.assertIsNotNone(parsed, text[:20])
            self.assertEqual(len(parsed["payload"]), 22)
            self.assertEqual(len(parsed["signature"]), 64)
            self.assertEqual(normalize_offline_code(text), text)
        self.assertIsNone(decode_offline_code_guard(offline.PERMANENT_ANY[:-5]))
        self.assertEqual(normalize_offline_code("KAY-AAAA-BBBB-CCCC"), "")
        self.assertEqual(normalize_offline_code("KAYO-not-a-real-license"), "")


def decode_offline_code_guard(text):
    parsed = decode_offline_license(text)
    if not parsed:
        return None
    return parsed if license_ed25519.verify(parsed["payload"], parsed["signature"],
                                            bytes.fromhex(offline.PUBLIC_KEY_HEX)) else None


if __name__ == "__main__":
    unittest.main(verbosity=2)
