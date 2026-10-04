"""`clipboard-probe.mjs` が使う .odt を 3 つ**丸ごと自作**する(中身は全部こちらのもの。#121)。

  text.odt   … 字だけ(`CLIPTEXT alpha beta gamma`)
  image.odt  … 先頭の段落に**画像 1 枚だけ**(文字と並べない = 先頭で `Shift+Right` すれば画像が選べる)
  table.odt  … 先頭に 2x2 の表(開いた直後の caret は 1 つ目のセルに在る)

使い方: python3 build/office-wasm/make-clipboard-fixtures.py <出力ディレクトリ>
"""
import struct
import sys
import zipfile
import zlib
from pathlib import Path

NS = (
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
    'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" '
    'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" '
    'xmlns:xlink="http://www.w3.org/1999/xlink"'
)


def png(w, h):
    """単色ではない PNG(縞)。⚠ 単色だと「画像が描かれたか」が絵で分からない。"""
    def chunk(t, d):
        c = t + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xFFFFFFFF)
    raw = bytearray()
    for y in range(h):
        raw += b'\x00'
        for x in range(w):
            raw += bytes(((x * 7) % 256, (y * 5) % 256, ((x + y) * 3) % 256))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(raw), 6)) + chunk(b'IEND', b''))


def manifest(extra=''):
    return ('<?xml version="1.0" encoding="UTF-8"?>'
            '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">'
            '<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>'
            '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>'
            + extra + '</manifest:manifest>')


def content(body):
    return ('<?xml version="1.0" encoding="UTF-8"?>'
            f'<office:document-content {NS} office:version="1.2"><office:body><office:text>'
            + body + '</office:text></office:body></office:document-content>')


def write(path, body, pics=None):
    pics = pics or {}
    extra = ''.join(
        f'<manifest:file-entry manifest:full-path="{n}" manifest:media-type="image/png"/>' for n in pics)
    with zipfile.ZipFile(path, 'w') as z:
        # ⚠ `mimetype` は先頭・無圧縮(ODF の決まり)
        z.writestr('mimetype', 'application/vnd.oasis.opendocument.text', zipfile.ZIP_STORED)
        z.writestr('META-INF/manifest.xml', manifest(extra), zipfile.ZIP_DEFLATED)
        z.writestr('content.xml', content(body), zipfile.ZIP_DEFLATED)
        for n, b in pics.items():
            z.writestr(n, b, zipfile.ZIP_STORED)


def cell(t):
    return '<table:table-cell office:value-type="string"><text:p>' + t + '</text:p></table:table-cell>'


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    write(out / 'text.odt', '<text:p>CLIPTEXT alpha beta gamma</text:p>')
    img = ('<text:p><draw:frame draw:name="img1" text:anchor-type="as-char" svg:width="6cm" svg:height="4cm">'
           '<draw:image xlink:href="Pictures/a.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>'
           '</draw:frame></text:p><text:p>after the image</text:p>')
    write(out / 'image.odt', img, {'Pictures/a.png': png(96, 64)})
    tbl = ('<table:table table:name="Table1"><table:table-column table:number-columns-repeated="2"/>'
           '<table:table-row>' + cell('CELLA1') + cell('CELLB1') + '</table:table-row>'
           '<table:table-row>' + cell('CELLA2') + cell('CELLB2') + '</table:table-row></table:table>'
           '<text:p>after the table</text:p>')
    write(out / 'table.odt', tbl)
    for p in sorted(out.glob('*.odt')):
        print(p, p.stat().st_size)


main()
