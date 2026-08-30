#!/usr/bin/env python3
"""End-to-end checks for the colors server.

Runs the real server on an ephemeral port and exercises every route, including
the SSE stream, so a regression in the watcher or the routing shows up here.

    python3 server/test_main.py
"""

from __future__ import annotations

import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from main import ColorsFile, make_handler  # noqa: E402

SAMPLE = {
    "background": "#1c1b1f",
    "on_background": "#e6e1e5",
    "primary": "#d0bcff",
}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ServerTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        self.colors_path = os.path.join(self.tmpdir.name, "colors.json")
        self.write_colors(SAMPLE)

        self.colors = ColorsFile(self.colors_path)
        self.port = free_port()
        self.httpd = ThreadingHTTPServer(
            ("127.0.0.1", self.port), make_handler(self.colors, "*")
        )
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.stop_server)
        threading.Thread(target=self.colors.watch_forever, daemon=True).start()

    def stop_server(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    def write_colors(self, payload: dict) -> None:
        # Write-then-rename, the way matugen replaces the file.
        tmp = self.colors_path + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(payload, fh)
        os.replace(tmp, self.colors_path)

    def url(self, path: str) -> str:
        return f"http://127.0.0.1:{self.port}{path}"

    # --- routes -----------------------------------------------------------

    def test_serves_colors_with_cors(self) -> None:
        with urllib.request.urlopen(self.url("/colors.json"), timeout=5) as r:
            self.assertEqual(r.status, 200)
            self.assertEqual(r.headers["Access-Control-Allow-Origin"], "*")
            self.assertEqual(json.load(r), SAMPLE)

    def test_root_is_an_alias_for_colors(self) -> None:
        with urllib.request.urlopen(self.url("/"), timeout=5) as r:
            self.assertEqual(json.load(r), SAMPLE)

    def test_health_reports_state(self) -> None:
        with urllib.request.urlopen(self.url("/health"), timeout=5) as r:
            body = json.load(r)
        self.assertTrue(body["exists"])
        self.assertEqual(body["colors_file"], os.path.abspath(self.colors_path))

    def test_unknown_route_is_404_json(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(self.url("/../../etc/passwd"), timeout=5)
        self.assertEqual(ctx.exception.code, 404)

    def test_missing_file_is_404_not_a_crash(self) -> None:
        os.unlink(self.colors_path)
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(self.url("/colors.json"), timeout=5)
        self.assertEqual(ctx.exception.code, 404)
        self.assertIn("does not exist", json.load(ctx.exception)["error"])

    # --- SSE --------------------------------------------------------------

    def test_stream_pushes_update_when_file_changes(self) -> None:
        request = urllib.request.Request(self.url("/updates"))
        stream = urllib.request.urlopen(request, timeout=10)
        self.addCleanup(stream.close)

        self.assertEqual(stream.headers["Content-Type"], "text/event-stream")
        self.assertEqual(stream.readline(), b": connected\n")

        # Wait for the watcher thread to register before touching the file.
        deadline = time.time() + 5
        while self.colors.subscriber_count == 0 and time.time() < deadline:
            time.sleep(0.05)
        self.assertEqual(self.colors.subscriber_count, 1)

        changed = dict(SAMPLE, primary="#ffb4ab")
        self.write_colors(changed)

        frames = []
        deadline = time.time() + 10
        while time.time() < deadline:
            line = stream.readline()
            if not line:
                break
            if line.startswith(b"data:"):
                frames.append(line.strip())
                break
        self.assertEqual(frames, [b"data: update"])

        with urllib.request.urlopen(self.url("/colors.json"), timeout=5) as r:
            self.assertEqual(json.load(r), changed)

    def test_subscriber_is_released_on_disconnect(self) -> None:
        stream = urllib.request.urlopen(self.url("/updates"), timeout=10)
        self.assertEqual(stream.readline(), b": connected\n")
        deadline = time.time() + 5
        while self.colors.subscriber_count == 0 and time.time() < deadline:
            time.sleep(0.05)
        self.assertEqual(self.colors.subscriber_count, 1)

        stream.close()

        # The first write to a half-closed socket usually succeeds locally; the
        # peer's RST only surfaces on a later write. In the server that later
        # write is the heartbeat, so keep nudging until cleanup happens.
        deadline = time.time() + 10
        while self.colors.subscriber_count and time.time() < deadline:
            self.colors.publish("update")
            time.sleep(0.1)
        self.assertEqual(self.colors.subscriber_count, 0)


class ColorsFileTestCase(unittest.TestCase):
    def test_stamp_is_none_when_missing(self) -> None:
        colors = ColorsFile("/nonexistent/colors.json")
        self.assertIsNone(colors._read_stamp())

    def test_publish_tolerates_a_full_subscriber(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "colors.json")
            with open(path, "w") as fh:
                json.dump(SAMPLE, fh)
            colors = ColorsFile(path)
            q = colors.subscribe()
            for _ in range(50):
                colors.publish("update")  # queue maxsize is 8
            self.assertFalse(q.empty())


if __name__ == "__main__":
    unittest.main(verbosity=2)
