#!/usr/bin/env python3
"""仅在 localhost 提供音效试听页面及素材；不启动游戏或自动打开浏览器。"""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("Port must be between 0 and 65535")
    directory = Path(__file__).resolve().parents[1] / "assets/audio"
    if not (directory / "audition.html").is_file():
        parser.error(f"Audition page not found: {directory / 'audition.html'}")
    handler = partial(SimpleHTTPRequestHandler, directory=str(directory))
    # 限定 IPv4 loopback，避免把开发素材无意共享给同一网络中的其他设备。
    with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
        port = server.server_address[1]
        print(f"Audition server: http://127.0.0.1:{port}/audition.html", flush=True)
        print("Press Ctrl+C to stop. No game process is started.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("Audition server stopped.", flush=True)


if __name__ == "__main__":
    main()
