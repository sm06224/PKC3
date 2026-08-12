/**
 * 静的ホスティング(GitHub Pages 等)へ置ける一式を組み立てる(#88、2026-08-10)。
 *
 * user「github pages で限界を越える方法見つけたぞ! Release 資産を fetch させる」への答え。
 * ⚠ **その道は塞がっている。ただし目的は達成できる。** 実測で決着した 3 点:
 *
 *  ① **Release 資産は JS から取れない。** GitHub の release download は
 *     `Access-Control-Allow-Origin` を **1 つも返さず**、OPTIONS も 405 を返す。
 *     同じヘッダ形を別 origin で再現して実ブラウザに掛けると
 *     `TypeError: Failed to fetch`(ACAO を足した場合のみ成功)。
 *     容量(2GB まで可)ではなく **CORS** が理由なので、迂回できない。
 *  ② **圧縮すれば 100MB の壁は要らない。** `soffice.wasm` 148MB → gzip -9 で **49MB**、
 *     `soffice.data` 83MB → **26MB**。どちらも 100MB/file を切るので**同一 origin**に
 *     置ける ── CORS 問題そのものが消える。
 *     解凍は `DecompressionStream('gzip')` + `WebAssembly.instantiateStreaming` で
 *     **流しながら**やる(実測 4,041ms / 288 exports。148MB を JS heap に載せない)。
 *  ③ **COOP/COEP を付けられなくてもよい。** `coi-serviceworker` を置くと、
 *     ヘッダを 1 つも返さないサーバでも `crossOriginIsolated === true` になる(実測)。
 *
 * ⚠ **git に入れるかどうかは別の判断**である。この script は「置ける一式」を作るだけで、
 *    commit はしない ── CI で組んで Pages へ deploy すれば **履歴を汚さずに済む**
 *    (Pages の site 上限は 1GB、この一式は約 76MB)。
 *
 * 使い方:
 *   node build/office-wasm/make-pages-bundle.mjs <LO を展開したディレクトリ> [出力先]
 *   # 例: bash build/office-wasm/fetch-and-run.sh --keep  で /tmp/lo-wasm を用意してから
 *   node build/office-wasm/make-pages-bundle.mjs /tmp/lo-wasm dist-office-pages
 */
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, readdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(process.argv[2] ?? '/tmp/lo-wasm');
const OUT = resolve(process.argv[3] ?? 'dist-office-pages');

const mb = (n) => Math.round((n / 1048576) * 10) / 10;

/** 起動に要る 5 つ(`fetch-and-run.sh` と同じ一覧)。 */
const REQUIRED = ['soffice.js', 'soffice.wasm', 'soffice.data', 'soffice.data.js.metadata', 'qtloader.js'];
/** そのまま置くもの(圧縮しない小さい file)。 */
const VERBATIM = ['soffice.js', 'qtloader.js', 'soffice.data.js.metadata'];

/** 既に在って元より新しければ作り直さない(49MB の gzip は 20 秒かかる)。 */
async function gzipTo(src, dst) {
  if (existsSync(dst) && statSync(dst).mtimeMs >= statSync(src).mtimeMs) {
    return { skipped: true, bytes: statSync(dst).size };
  }
  await pipeline(createReadStream(src), createGzip({ level: 9 }), createWriteStream(dst));
  return { skipped: false, bytes: statSync(dst).size };
}

async function main() {
  // ⚠ **起動に要る file の一覧は 1 か所に持つ。** ここを 4 件しか検めていなかったせいで
  //    `soffice.data.js.metadata`(データパッケージの索引)を入れ忘れ、builder は
  //    正常終了したのにブラウザで 404 → run dependency が解けず**永久に起動しなかった**。
  //    🔑 「出力できた」は「動く」ではない ── 一覧は `fetch-and-run.sh` と同じにする。
  for (const f of REQUIRED) {
    if (!existsSync(join(SRC, f))) {
      console.error(`ERROR: ${join(SRC, f)} が無い。先に:\n`
        + '  bash build/office-wasm/fetch-and-run.sh --keep');
      process.exitCode = 1;
      return;
    }
  }
  mkdirSync(OUT, { recursive: true });
  mkdirSync(join(OUT, 'fonts'), { recursive: true });

  // そのまま置くもの
  for (const f of VERBATIM) copyFileSync(join(SRC, f), join(OUT, f));
  copyFileSync(join(HERE, 'pages', 'coi-serviceworker.js'), join(OUT, 'coi-serviceworker.js'));

  // 圧縮して置くもの(100MB/file を切らせる本体)
  const rows = [];
  for (const f of ['soffice.wasm', 'soffice.data']) {
    const orig = statSync(join(SRC, f)).size;
    const r = await gzipTo(join(SRC, f), join(OUT, `${f}.gz`));
    rows.push({ file: f, origMb: mb(orig), gzMb: mb(r.bytes), ratio: Math.round((orig / r.bytes) * 100) / 100, skipped: r.skipped });
  }

  // 日本語フォント ── ⚠ LO の同梱 128 file / 51.2MiB に **CJK が 1 つも無い**。
  //    これが無いと日本語は全部豆腐になる(#88 §3.11)
  const fontSrc = join(SRC, 'inject');
  const fonts = existsSync(fontSrc)
    ? readdirSync(fontSrc).filter((f) => f.toLowerCase().endsWith('.ttf')) : [];
  for (const f of fonts) copyFileSync(join(fontSrc, f), join(OUT, 'fonts', f));

  // index.html ── フォント一覧と表示サイズだけ差し込む(本体は pages/index.html が正本)
  // 🔴 **出力側でも「起動に要るもの」を数え直す。** 入力を検めただけでは、
  //    コピーし忘れ(= 実際に踏んだ metadata 404)を止められない。
  const shipped = ['soffice.wasm.gz', 'soffice.data.gz', 'coi-serviceworker.js', ...VERBATIM];
  const missing = shipped.filter((f) => !existsSync(join(OUT, f)));
  if (missing.length) throw new Error(`出力に足りない: ${missing.join(', ')}`);
  const totalMb = shipped.reduce((a, f) => a + statSync(join(OUT, f)).size, 0)
    + fonts.reduce((a, f) => a + statSync(join(OUT, 'fonts', f)).size, 0);
  let html = readFileSync(join(HERE, 'pages', 'index.html'), 'utf-8');
  html = html.replace('<script src="coi-serviceworker.js"></script>',
    `<script>window.PKC3_FONTS = ${JSON.stringify(fonts)};</script>\n<script src="coi-serviceworker.js"></script>`);
  html = html.replace('<b id="dl">75</b>', `<b id="dl">${Math.round(mb(totalMb))}</b>`);
  // ⚠ 差し込みが空振りしていないか確かめる(置換が当たらないと「フォント 0 件」で静かに豆腐になる)
  if (!html.includes('PKC3_FONTS')) throw new Error('index.html への PKC3_FONTS 差し込みが当たらなかった');
  writeFileSync(join(OUT, 'index.html'), html);

  /**
   * 🔴 **一式の目録**(`pack.json`)。取りに来る側(PKC3 の設定画面)が読む。
   *
   * ⚠ これが無いと、**PKC3 側にフォント名を書き写す**ことになる ── 「一式とは何か」が
   * 2 か所に分かれ、片方だけ直って壊れる(`office-pack.ts` 冒頭の教訓そのもの)。
   * 🔑 **配る側が「何を配ったか」を宣言する**。取る側は目録どおりに取るだけにする。
   * ⚠ `files` は**実際に出力した物**から作る(予定を書かない)。
   */
  /**
   * 🔴 **版は「一式の中」から取る**(#125)。
   *
   * ⚠ 以前は `PKC3_LO_TAG` だけを見ていたが、2 つの理由で版にならなかった:
   *  ① office-pack の workflow が env を**取得の step にしか渡していなかった** ──
   *     組み立ては別シェルなので届かず、**常に `unknown`** だった
   *     (CLAUDE.md「step ごとに別シェル」の再発)
   *  ② 届いたとしても `lo-wasm-dev` は**使い回しのタグ**で、中身が入れ替わっても
   *     名前が変わらない ── 「どのビルドか」を答えない
   * 🔑 だから `office-wasm-build` が一式へ `build-info.json` を同梱し、**それを読む**。
   * ⚠ 古い一式には無いので、env → `unknown` の順に落とす(落ちても組み立ては続ける)。
   */
  let build = null;
  const infoPath = join(SRC, 'build-info.json');
  if (existsSync(infoPath)) {
    try {
      build = JSON.parse(readFileSync(infoPath, 'utf-8'));
    } catch (e) {
      console.warn(`  ⚠ build-info.json を読めなかった: ${String(e)}`);
    }
  }
  const version = (build && typeof build.version === 'string' && build.version)
    || process.env.PKC3_LO_TAG || 'unknown';
  console.log(`  版: ${version}${build ? '' : '  ⚠ build-info.json が無い(古い一式)'}`);

  writeFileSync(
    join(OUT, 'pack.json'),
    `${JSON.stringify(
      {
        version,
        // ⚠ 版の**出どころ**も残す ── 「どの LO commit か」を後から辿れるようにする
        build,
        builtAt: new Date().toISOString(),
        files: shipped.filter((f) => f !== 'coi-serviceworker.js'),
        fonts: fonts.map((f) => `fonts/${f}`),
        totalBytes: totalMb,
      },
      null,
      2,
    )}\n`,
  );

  // Jekyll に食わせない(_ 始まりや不明な拡張子で事故らないように)
  writeFileSync(join(OUT, '.nojekyll'), '');

  console.log('');
  console.log(`  出力: ${OUT}`);
  for (const r of rows) {
    console.log(`  ${r.file.padEnd(13)} ${String(r.origMb).padStart(6)}MB → ${String(r.gzMb).padStart(5)}MB.gz  (${r.ratio}x)${r.skipped ? '  [再利用]' : ''}`);
  }
  console.log(`  フォント: ${fonts.length ? fonts.map((f) => basename(f)).join(', ') : '**無し(日本語が豆腐になります)**'}`);
  console.log(`  合計: ${mb(totalMb)}MB  (Pages の site 上限 1GB に対して十分小さい)`);
  console.log('');
  console.log('  手元で確かめる(ヘッダを 1 つも付けないサーバで):');
  console.log(`    npx --yes http-server ${OUT} -p 8090 -c-1`);
  console.log('  ── coi-serviceworker が COOP/COEP を被せるので、それでも起動する');
  console.log('');
  if (!fonts.length) process.exitCode = 1;
}

await main();
