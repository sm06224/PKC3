# LibreOffice wasm をセルフホストする(#88)

`make-pages-bundle.mjs` が出した一式(既定 `dist-office-pages/`)を、好きなサーバで配るための設定集。

```bash
bash build/office-wasm/fetch-and-run.sh --keep          # 成果物とフォントを取得
node build/office-wasm/make-pages-bundle.mjs /tmp/lo-wasm dist-office-pages
```

## 🔴 どのサーバでも外してはいけない 3 点

1. **`Cross-Origin-Opener-Policy: same-origin` と `Cross-Origin-Embedder-Policy: require-corp`**
   ── SharedArrayBuffer(= LO の `-pthread`)に要る。
   **付けられないホスト**(GitHub Pages 等)では同梱の `coi-serviceworker.js` が肩代わりする
   (実測: ヘッダを 1 つも返さないサーバで `crossOriginIsolated === true`)。
   ⚠ **付けられるなら付けるほうがよい** ── service worker は初回に 1 回リロードが要るし、
   プライベートウィンドウや SW 無効環境では成立しない。
2. **`.gz` を `Content-Encoding: gzip` で返し、`Vary: Accept-Encoding` を付ける**
   ── 一式は `soffice.wasm.gz`(50.6MB)/ `soffice.data.gz`(26.4MB)を**そのまま**置いている。
   ⚠ ただし本ページは **JS 側で `DecompressionStream('gzip')` を使って解く**設計なので、
   `.gz` は「中身が gzip の普通のファイル」として素で配ってよい ──
   **`Content-Encoding: gzip` を付けてはいけない**(二重解凍になり壊れる)。
   下の設定はすべて**付けない**形にしてある。⚠ nginx の `gzip_static` を有効にすると
   勝手に付くので、この一式では**切っておく**。
3. **`application/wasm` の MIME**(生の `.wasm` も置く場合)と、`.gz` は
   `application/octet-stream` のままでよい。

## 容量の目安

| file | 生 | 配る形 |
|---|---|---|
| `soffice.wasm` | 148.9MB | `soffice.wasm.gz` **50.6MB** |
| `soffice.data` | 83.6MB | `soffice.data.gz` **26.4MB** |
| その他(js / metadata / フォント 3 本) | ─ | 約 16MB |
| **合計** | 約 247MB | **約 93MB** |

---

## nginx

```nginx
server {
    listen 8080;
    root /srv/office-wasm;          # dist-office-pages を置いた場所

    # ヘッダを付けられるので付ける(coi-serviceworker に頼らない)
    add_header Cross-Origin-Opener-Policy   same-origin always;
    add_header Cross-Origin-Embedder-Policy require-corp always;
    add_header Cross-Origin-Resource-Policy same-origin always;

    types { application/wasm wasm; }
    default_type application/octet-stream;

    # ⚠ 一式の .gz は「中身が gzip のただのファイル」。
    #    gzip_static を on にすると Content-Encoding が付いて二重解凍になる
    gzip_static off;
    gzip on;
    gzip_types text/html text/javascript application/javascript application/json;
    gzip_min_length 1024;

    location / { try_files $uri $uri/ =404; }
    # 巨大 file は sendfile で
    sendfile on;
    tcp_nopush on;
}
```

## Caddy

```caddyfile
:8080 {
	root * /srv/office-wasm
	header {
		Cross-Origin-Opener-Policy   "same-origin"
		Cross-Origin-Embedder-Policy "require-corp"
		Cross-Origin-Resource-Policy "same-origin"
	}
	# ⚠ .gz は素で配る(Content-Encoding を付けない)
	encode {
		gzip
		match {
			header Content-Type text/*
			header Content-Type application/javascript*
			header Content-Type application/json*
		}
	}
	file_server
}
```

## Apache(`.htaccess`)

```apache
Header always set Cross-Origin-Opener-Policy   "same-origin"
Header always set Cross-Origin-Embedder-Policy "require-corp"
Header always set Cross-Origin-Resource-Policy "same-origin"

AddType application/wasm .wasm
# ⚠ .gz に Content-Encoding を付けない(JS 側で解くため)
RemoveEncoding .gz

<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/javascript application/javascript application/json
</IfModule>
```

## Docker(nginx を 1 コマンドで)

```bash
docker run --rm -p 8080:8080 \
  -v "$PWD/dist-office-pages:/srv/office-wasm:ro" \
  -v "$PWD/build/office-wasm/selfhost/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx:alpine
```

## Python(依存なし・手早く見たいとき)

```bash
python3 build/office-wasm/selfhost/serve.py dist-office-pages 8080
```

## Node(このリポジトリの実装)

`serve-local.mjs` は COOP/COEP を付け、`.gz` の双子が在れば
`Content-Encoding: gzip` で返す(**生 file を配る用**の経路)。
Pages 一式(JS 側で解く形)ではなく、`/tmp/lo-wasm` の**生の成果物**を配るときに使う。

```bash
bash build/office-wasm/fetch-and-run.sh --serve     # → http://127.0.0.1:8088/
```

---

## 🚫 やろうとして**塞がっていた**道(記録)

**GitHub の Release 資産を CDN 代わりに fetch する** ── 成立しない。
容量(1 file 2GB まで)ではなく **CORS** が理由:

- release download は `Access-Control-Allow-Origin` を **1 つも返さない**(実測)
- `OPTIONS` は **405**(preflight 不可)
- 同じヘッダ形を別 origin で再現して実ブラウザに掛けると
  **`TypeError: Failed to fetch`**。ACAO を足した場合のみ成功する

⚠ `coi-serviceworker` はこれを救わない ── あれが解くのは **COOP/COEP** であって
**CORS** ではない。service worker からの `fetch` も同じ CORS 規則に従う。

🔑 代わりに **圧縮**で解いた。`gzip -9` で 100MB/file を切るので、
**同一 origin に置ける = CORS 問題そのものが消える**。
