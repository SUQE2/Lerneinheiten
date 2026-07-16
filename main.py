"""Kleiner lokaler Webserver fuer den Lernzeit-Tracker."""

from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import os


PORT = 8000


if __name__ == "__main__":
    os.chdir(Path(__file__).parent)
    print(f"Lernzeit läuft auf http://localhost:{PORT}")
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), SimpleHTTPRequestHandler).serve_forever()
    except KeyboardInterrupt:
        print("\nServer beendet.")
