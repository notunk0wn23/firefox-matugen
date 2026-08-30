#!/usr/bin/env python3
"""Serve a matugen-generated colors file to the Matugen Firefox extension.

The extension needs two things from this server:

  GET /colors.json  ->  the current colors, as JSON
  GET /updates      ->  a Server-Sent Events stream that emits `update`
                        whenever the colors file changes on disk

Only the colors file is ever served. Nothing else in the directory is exposed.

Usage:
    ./main.py ~/.config/matugen/colors.json
    ./main.py ~/.config/matugen/colors.json --port 8080 --daemon
"""

from __future__ import annotations

import argparse
import errno
import json
import os
import queue
import signal
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_PORT = 8000
POLL_INTERVAL = 0.5
# Comment frames keep proxies and the browser from treating an idle stream as dead,
# and are how we notice a subscriber has gone away.
HEARTBEAT_INTERVAL = 15.0


class ColorsFile:
    """Tracks a single colors file and notifies subscribers when it changes."""

    def __init__(self, path: str) -> None:
        self.path = os.path.abspath(path)
        self._subscribers: set[queue.Queue[str]] = set()
        self._lock = threading.Lock()
        self._stamp = self._read_stamp()

    # --- change detection -------------------------------------------------

    def _read_stamp(self) -> tuple | None:
        """A cheap fingerprint of the file, or None when it does not exist.

        matugen writes the file by replacing it, so the inode can change without
        mtime moving. Size and inode are part of the fingerprint for that reason.
        """
        try:
            st = os.stat(self.path)
        except OSError:
            return None
        return (st.st_mtime_ns, st.st_size, st.st_ino)

    def watch_forever(self) -> None:
        while True:
            time.sleep(POLL_INTERVAL)
            stamp = self._read_stamp()
            if stamp is not None and stamp != self._stamp:
                self._stamp = stamp
                self.publish("update")

    # --- pub/sub ----------------------------------------------------------

    def subscribe(self) -> queue.Queue[str]:
        q: queue.Queue[str] = queue.Queue(maxsize=8)
        with self._lock:
            self._subscribers.add(q)
        return q

    def unsubscribe(self, q: queue.Queue[str]) -> None:
        with self._lock:
            self._subscribers.discard(q)

    def publish(self, event: str) -> None:
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            try:
                q.put_nowait(event)
            except queue.Full:
                # A subscriber that cannot keep up will still get the next event.
                pass

    @property
    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subscribers)

    # --- reading ----------------------------------------------------------

    def read_bytes(self) -> bytes:
        with open(self.path, "rb") as fh:
            return fh.read()


def make_handler(colors: ColorsFile, allow_origin: str):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "matugen-firefox"
        sys_version = ""

        # -- helpers -------------------------------------------------------

        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", allow_origin)
            self.send_header("Vary", "Origin")

        def _fail(self, status: HTTPStatus, message: str) -> None:
            body = json.dumps({"error": message}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt: str, *args) -> None:
            sys.stderr.write(
                "%s - %s\n" % (self.address_string(), fmt % args)
            )

        # -- routes --------------------------------------------------------

        def do_OPTIONS(self) -> None:
            self.send_response(HTTPStatus.NO_CONTENT)
            self._cors()
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self) -> None:
            route = self.path.split("?", 1)[0].rstrip("/") or "/"
            if route == "/updates":
                self.serve_events()
            elif route in ("/colors.json", "/"):
                self.serve_colors()
            elif route == "/health":
                self.serve_health()
            else:
                self._fail(HTTPStatus.NOT_FOUND, "not found")

        def serve_colors(self) -> None:
            try:
                payload = colors.read_bytes()
            except FileNotFoundError:
                self._fail(
                    HTTPStatus.NOT_FOUND,
                    f"{colors.path} does not exist yet - run matugen once",
                )
                return
            except OSError as exc:
                self._fail(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))
                return

            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self._cors()
            self.end_headers()
            self.wfile.write(payload)

        def serve_health(self) -> None:
            body = json.dumps(
                {
                    "colors_file": colors.path,
                    "exists": os.path.exists(colors.path),
                    "subscribers": colors.subscriber_count,
                }
            ).encode()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)

        def serve_events(self) -> None:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self._cors()
            self.end_headers()

            q = colors.subscribe()
            try:
                self._write_frame(": connected\n\n")
                while True:
                    try:
                        event = q.get(timeout=HEARTBEAT_INTERVAL)
                    except queue.Empty:
                        # Heartbeat doubles as a liveness probe: if the client is
                        # gone this raises and we clean up.
                        self._write_frame(": ping\n\n")
                        continue
                    self._write_frame(f"data: {event}\n\n")
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass
            except OSError as exc:
                if exc.errno not in (errno.EPIPE, errno.ECONNRESET):
                    raise
            finally:
                colors.unsubscribe(q)
                self.close_connection = True

        def _write_frame(self, text: str) -> None:
            self.wfile.write(text.encode())
            self.wfile.flush()

    return Handler


def daemonize(log_path: str | None) -> None:
    """Detach from the terminal, keeping stderr on a log file when asked."""
    if os.fork() > 0:
        os._exit(0)
    os.setsid()
    if os.fork() > 0:
        os._exit(0)

    sys.stdout.flush()
    sys.stderr.flush()

    target = open(log_path, "a") if log_path else open(os.devnull, "w")
    with open(os.devnull, "r") as devnull_in:
        os.dup2(devnull_in.fileno(), sys.stdin.fileno())
    os.dup2(target.fileno(), sys.stdout.fileno())
    os.dup2(target.fileno(), sys.stderr.fileno())


def write_pidfile(path: str) -> None:
    with open(path, "w") as fh:
        fh.write(f"{os.getpid()}\n")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Serve a matugen colors file to the Matugen Firefox extension."
    )
    parser.add_argument(
        "path",
        help="Path to the matugen-generated colors JSON file.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"Port to listen on (default: {DEFAULT_PORT}).",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Address to bind (default: 127.0.0.1 - loopback only).",
    )
    parser.add_argument(
        "--allow-origin",
        default="*",
        help=(
            "Value for Access-Control-Allow-Origin. Set this to your extension's "
            "moz-extension://<uuid> origin to stop other pages reading your colors."
        ),
    )
    parser.add_argument(
        "--daemon",
        action="store_true",
        help="Detach and run in the background.",
    )
    parser.add_argument(
        "--log-file",
        help="With --daemon, append output here instead of discarding it.",
    )
    parser.add_argument("--pidfile", help="Write the server PID to this file.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    if os.path.isdir(args.path):
        print(
            f"Error: {args.path} is a directory. Pass the colors JSON file itself.",
            file=sys.stderr,
        )
        return 2

    colors = ColorsFile(args.path)
    if not os.path.exists(colors.path):
        # Not fatal: matugen may not have run yet. The watcher picks it up later.
        print(
            f"Warning: {colors.path} does not exist yet; "
            "serving 404 until matugen creates it.",
            file=sys.stderr,
        )

    handler = make_handler(colors, args.allow_origin)
    try:
        httpd = ThreadingHTTPServer((args.host, args.port), handler)
    except OSError as exc:
        if exc.errno == errno.EADDRINUSE:
            print(
                f"Error: port {args.port} is already in use. "
                "Stop the other server or pick a different --port.",
                file=sys.stderr,
            )
            return 1
        raise
    httpd.daemon_threads = True

    if args.daemon:
        httpd.server_close()
        daemonize(args.log_file)
        httpd = ThreadingHTTPServer((args.host, args.port), handler)
        httpd.daemon_threads = True

    if args.pidfile:
        write_pidfile(args.pidfile)

    def shutdown(signum, _frame):
        print(f"Received signal {signum}, shutting down.", file=sys.stderr)
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    threading.Thread(target=colors.watch_forever, daemon=True).start()

    print(
        f"Serving {colors.path} on http://{args.host}:{args.port} "
        "(/colors.json, /updates, /health)",
        file=sys.stderr,
    )
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
        if args.pidfile:
            try:
                os.unlink(args.pidfile)
            except OSError:
                pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
