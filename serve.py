"""Serve Tack locally with caching disabled, so edits show up on refresh.

Usage: python3 serve.py [port]   (default 5178)
"""
import functools
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5178
    print(f"Tack running at http://localhost:{port}")
    root = os.path.dirname(os.path.abspath(__file__))  # serve this folder, wherever it is run from
    handler = functools.partial(NoCacheHandler, directory=root)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
