import os
import argparse
from http.server import HTTPServer, SimpleHTTPRequestHandler
from functools import partial

def run_server(directory, port):
    os.chdir(directory)  # Change the current working directory to the user's path
    handler = partial(SimpleHTTPRequestHandler, directory=directory)
    httpd = HTTPServer(('localhost', port), handler)
    print(f"Serving {directory} on port {port}...")
    httpd.serve_forever()

def main():
    parser = argparse.ArgumentParser(description="Serve a file or directory over HTTP.")
    parser.add_argument('path', help="Path to the file or directory to serve.")
    parser.add_argument('--port', type=int, default=8000, help="Port to run the HTTP server on (default: 8000)")
    args = parser.parse_args()

    if not os.path.exists(args.path):
        print(f"Error: {args.path} does not exist.")
        return
    
    if os.path.isfile(args.path):
        # Get directory and file name
        directory, file_name = os.path.split(args.path)
        os.chdir(directory)
        print(f"Serving file {file_name} from {directory} on port {args.port}...")
    else:
        directory = args.path
        print(f"Serving directory {directory} on port {args.port}...")
    
    run_server(directory, args.port)

if __name__ == "__main__":
    main()
