import os
import argparse
import subprocess
import sys
import signal
from http.server import HTTPServer, SimpleHTTPRequestHandler
from functools import partial

class CORSRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

def run_server(directory, port):
import os
import argparse
import subprocess
import sys
import signal
from http.server import HTTPServer, SimpleHTTPRequestHandler
from functools import partial
import time
import threading
import mimetypes

class CORSRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

# Global variable to track the last modification time of the theme.json
last_modified_time = 0
observers = []

def notify_observers():
    """Notify all observers that the theme.json file has changed."""
    global observers
    for observer in observers:
        try:
            observer.write(b"data: update\n\n")
            observer.flush()
        except Exception as e:
            print(f"Failed to notify observer: {e}")

def watch_theme_file(file_path):
    """Watch the theme.json file for changes and notify observers."""
    global last_modified_time
    while True:
        current_modified_time = os.path.getmtime(file_path)
        if current_modified_time != last_modified_time:
            last_modified_time = current_modified_time
            notify_observers()
        time.sleep(1)  # Check every second

class SSERequestHandler(CORSRequestHandler):
    """Request handler for SSE connections."""
    def do_GET(self):
        if self.path == '/updates':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Connection', 'keep-alive')
            self.end_headers()

            # Add this connection to the observers list
            observers.append(self)

            try:
                # Keep the connection open
                while True:
                    time.sleep(1)
            except Exception as e:
                print(f"Connection closed: {e}")
            finally:
                observers.remove(self)

        else:
            super().do_GET()

def run_server(directory, port):
    os.chdir(directory)
    handler = partial(SSERequestHandler, directory=directory)
    httpd = HTTPServer(('localhost', port), handler)

    # Start a background thread to watch the theme.json file
    theme_file_path = os.path.join(directory, 'theme.json')
    if os.path.exists(theme_file_path):
        threading.Thread(target=watch_theme_file, args=(theme_file_path,), daemon=True).start()

    print(f"Serving {directory} on port {port}...")
    httpd.serve_forever()

def start_server_as_daemon(directory, port):
    if os.fork() > 0:
        sys.exit()

    os.setsid()
    if os.fork() > 0:
        sys.exit()

    sys.stdout.flush()
    sys.stderr.flush()
    with open(os.devnull, 'w') as fnull:
        os.dup2(fnull.fileno(), sys.stdin.fileno())
        os.dup2(fnull.fileno(), sys.stdout.fileno())
        os.dup2(fnull.fileno(), sys.stderr.fileno())

    run_server(directory, port)

def check_and_kill_existing_server(port):
    # Get the process ID of the running server
    try:
        result = subprocess.run(
            ["lsof", "-t", f"-i:{port}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True
        )
        pids = result.stdout.decode().strip().split()
        for pid in pids:
            print(f"Killing existing server with PID: {pid}")
            os.kill(int(pid), signal.SIGTERM)
    except subprocess.CalledProcessError:
        # No process found on that port
        pass

def main():
    parser = argparse.ArgumentParser(description="Serve a file or directory over HTTP as a daemon with CORS.")
    parser.add_argument('path', help="Path to the file or directory to serve.")
    parser.add_argument('--port', type=int, default=8000, help="Port to run the HTTP server on (default: 8000)")
    args = parser.parse_args()

    if not os.path.exists(args.path):
        print(f"Error: {args.path} does not exist.")
        return

    directory = args.path if os.path.isdir(args.path) else os.path.dirname(args.path)

    # Check and kill existing server if running
    check_and_kill_existing_server(args.port)

    print(f"Starting HTTP server in the background for {directory} on port {args.port}...")
    
    start_server_as_daemon(directory, args.port)

if __name__ == "__main__":
    main()
