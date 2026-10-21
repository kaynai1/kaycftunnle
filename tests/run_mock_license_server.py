#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""启动本地模拟授权服务：python tests/run_mock_license_server.py --port 8792 [--seed CODE]"""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mock_license_server import start_mock  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8792)
    parser.add_argument("--seed", action="append", default=[], help="预置卡密，可重复")
    args = parser.parse_args()

    server, state, url = start_mock(args.port)
    for code in args.seed:
        state.seed(code)
    print("mock license server: %s" % url, flush=True)
    for code in args.seed:
        print("seeded: %s" % code, flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
