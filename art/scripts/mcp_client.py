"""通过已安装 Blender MCP 插件的本地协议执行脚本，不启动 Blender。"""

import argparse
import json
from pathlib import Path
import socket


def send(code, timeout=1200):
    with socket.create_connection(("127.0.0.1", 9876), timeout=10) as connection:
        connection.settimeout(timeout)
        command = {"type": "execute_code", "params": {"code": code}}
        connection.sendall(json.dumps(command).encode("utf-8"))
        received = bytearray()
        while True:
            chunk = connection.recv(65536)
            if not chunk:
                raise ConnectionError("Blender MCP disconnected before returning a result")
            received.extend(chunk)
            try:
                response = json.loads(received)
                break
            except json.JSONDecodeError:
                continue
        if response.get("status") != "success":
            raise RuntimeError(response.get("message", response))
        return response["result"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--script", type=Path)
    group.add_argument("--code")
    parser.add_argument("--output-log", type=Path)
    args = parser.parse_args()
    source = args.code
    if args.script:
        source = "import runpy; runpy.run_path(" + repr(str(args.script.resolve())) + ", run_name='__main__')"
    result = send(source)
    if args.output_log:
        args.output_log.parent.mkdir(parents=True, exist_ok=True)
        output = result.get("result", "")
        args.output_log.write_text(output, encoding="utf-8")
        print(json.dumps({"executed": result.get("executed"), "log":str(args.output_log),
                          "output_tail":output[-1200:]},ensure_ascii=False))
    else:
        print(json.dumps(result, ensure_ascii=False))
