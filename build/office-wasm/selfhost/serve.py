#!/usr/bin/env python3
"""LibreOffice wasm(#88)を依存なしで配る。

  python3 build/office-wasm/selfhost/serve.py dist-office-pages 8080

🔴 COOP/COEP を付ける ── SharedArrayBuffer(= LO の -pthread)に要る。
⚠ .gz には Content-Encoding を付けない。この一式は JS 側が
   DecompressionStream('gzip') で解くので、付けると二重解凍で壊れる。
"""
import functools
import http.server
import os
import sys

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else 'dist-office-pages')
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8080


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.wasm': 'application/wasm',
        '.gz': 'application/octet-stream',
        '.ttf': 'font/ttf',
    }

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        # 404 だけ出す(200 の洪水で本物のエラーを埋めない)
        if args and str(args[1]).startswith('4'):
            super().log_message(fmt, *args)


if __name__ == '__main__':
    handler = functools.partial(Handler, directory=ROOT)
    print(f'  http://127.0.0.1:{PORT}/   (root: {ROOT})')
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler).serve_forever()
