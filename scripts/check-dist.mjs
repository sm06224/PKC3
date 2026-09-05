#!/usr/bin/env node
/**
 * ビルド生成物の検品(P7 段①)── I/O と CLI。規則は `dist-inspect.mjs`。
 *
 *   node scripts/check-dist.mjs product   # map が 1 つでもあれば落とす + 配信量の tripwire
 *   node scripts/check-dist.mjs dev       # map が 1 つも無ければ落とす(調査手段の喪失)
 *   node scripts/check-dist.mjs product --require-manual
 *                                         # 焼きたての product(release / nightly)── manual.html の
 *                                         # 実在も要求する。⚠ 過去の zip を検品する経路には付けない
 *
 * 🔑 **2 段構え**。`tests/build-config.test.ts` は「config がそう書いてあるか」しか
 * 見ない ── plugin が map を足す・`--sourcemap` が渡る、といった経路は config を
 * 読んでも分からないので、**実物のファイル一覧と中身**をここで見る。
 *
 * ⚠ dev 側を「map が有ること」で縛るのが本体である。product 側だけを縛ると、
 * 事故で両方から map が消えたときに**誰も気づかない**(§5-2 の裁定は
 * 「product の配信量だけを捨てる。調査手段は失わない」)。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectDist, MANUAL_PAGE, PORTABLE_TEMPLATE } from './dist-inspect.mjs';

/**
 * 🔴 **旗は名指しで受け、知らない旗は使い方を出して落とす**(#648 💭)。
 * ⚠ 綴りを間違えた旗を黙って捨てると、「要求したつもり」で門が消える ── 呼び側が
 *   `--require-manaul` と打った日に、release が manual.html 無しで通る。
 */
const KNOWN_FLAGS = new Set(['--require-manual']);
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const unknownFlags = flags.filter((f) => !KNOWN_FLAGS.has(f));

/**
 * 検品する directory。既定は `dist/`。
 * ⚠ 第 2 引数で差し替えられる ── Pages は **release の成果物を展開したもの**を
 * 配るので(P7 段⑧)、`dist/` 以外を検品する必要がある。
 */
const DIST = positional[1]
  ? resolve(positional[1])
  : fileURLToPath(new URL('../dist', import.meta.url));

/**
 * 配る量の tripwire。KB。
 * ⚠ 段④ で SW の precache 対象になる量でもあるが、precache 自体はまだ無い
 * (`public/sw.js` は現状 pass-through)── いまは**配信量**の tripwire である。
 * 🔑 手違いの検出であって、サイズを守らせる規律ではない(PKC2 から継承)。
 * 通常増加で触れたら引き上げてよい ── 止めたいのは「重い dep の誤取込」
 * 「生成物の取り違え」という**桁の事故**である。
 *
 * 🔴 **2026-08-03 に 2400 → 6000 KB へ引き上げた**。mermaid(lazy 99 chunk)を
 * 入れたため。user 指示:「**配布サイズは気にしないで欲しい / 初回起動が遅くとも、
 * そこは許容 / その後の動作がメモリくったり、もっさりだと嫌なだけです**」──
 * **「重いから入れない」を判断理由にしてはならない**。測って報告すべきは
 * 配る量ではなく、継続使用の常駐メモリと操作の応答である。
 *
 * 🔴 **2026-08-22(#78)に 6000 → 6500 KB へ引き上げた**。markdown-it 15 が
 * **+17.5 KB**(5966.8 → 5984.3、同じ tree を両版でビルドして実測)で、
 * 残量が **15.7 KB** になった ── ここで放置すると**次の普通の PR が意味も無く
 * 落ちる**。上流の major 1 本ぶんの増加は「桁の事故」ではないので引き上げる
 * (user 指示 2026-08-03、不可侵)。
 * 🔑 引き上げ幅は「**mermaid / katex 級の誤取込は今も止まる**」を残す量にした ──
 * いまの実測に対して約 500 KB の余裕は、chunk 1 本の取り違え(数百 KB〜MB)を
 * 通さない。⚠ **撤廃はしない**。
 *
 * 🔴 **2026-08-28(#527)に 6500 → 7000 KB へ引き上げた**。実測 6478.4 KB で
 * 残量が **21.6 KB(0.3%)** になり、**次の普通の PR が意味も無く落ちる**手前だった
 * ── この日の増加は段組み・UML の雛形・別窓の拡大縮小といった**通常の実装**で、
 * 「桁の事故」ではない(user 指示 2026-08-28「**前から言ってるけど、予算はあくまで
 * 何かの手違いを検出するために設定してる。引き上げで問題ない**」)。
 * 🔑 余裕は再び約 500 KB ── **誤取込 1 本(数百 KB〜MB)は今も止まる**。
 *
 * 🔴 **2026-09-02(#645 段②)に 7000 → 7500 KB へ引き上げた**。マニュアルを
 * `manual.html` に焼いて配るようになり(**+334.9 KB**、実測)、残量が **116 KB(1.7%)**
 * になった ── これは「重い dep の誤取込」ではなく、user 要望(マニュアルを F5 で読み直せる /
 * 設定の配色が効く)の**通常の実装**である(user 指示 2026-08-28「予算はあくまで何かの
 * 手違いを検出するために設定してる。引き上げで問題ない」)。
 * 🔑 余裕は約 600 KB ── **誤取込 1 本(数百 KB〜MB)は今も止まる**。⚠ **撤廃はしない**。
 */
const SHIPPED_CAP_KB = 7500;

/**
 * 配る量の下限。KB。⚠ **cap だけでは片側しか見ていない** ── entry chunk を
 * 0 バイトにしても「配る量が減った」だけで通っていた(レビュー 2 巡目 M-1)。
 * 取り違え・chunk 欠落は**縮む方向**にも起きる。
 * ⚠ mermaid の chunk 群(約 3.3 MB)が丸ごと消えると図が描けなくなるが、
 * **画面はソース表示に落ちるだけで壊れない**ので気づきにくい ── 床がその検出器。
 *
 * 🔴 **床は kind ごとに持つ**(P8 段㉒。実際に deploy を止めて分かった)。
 * `dev` は**いまの main を今ビルドした物**なので、現在の実測(4963.5 KB)に
 * 対する床でよい。`product` は**過去に release した成果物そのもの**を配るので、
 * 今日の dev に合わせた床を当てると、**古い release が必ず落ちる** ──
 * 実際 `v3.0.0`(1648.7 KB。この PR の前にビルドされたもの)が
 * 「下限を 1851.3 KB 下回る」で job ごと落ち、**dev の deploy まで巻き添えで
 * 止まった**(dev のビルドと検品は通っていたのに、公開の step へ到達しなかった)。
 *
 * ⚠ product 側の床は「**空 / 途中で切れた zip を弾く**」ことだけを狙う ──
 * 版が上がるたびに追随させる性質のものではない(cap と同じで、規律ではなく
 * 手違いの検出器である)。
 */
const SHIPPED_FLOOR_KB = { dev: 3500, product: 800 };

/**
 * 🔴 **「持ち歩ける 1 枚」の雛形だけの予算**(#400 段④。2026-08-29 に本番を止めて足した)。
 *
 * ⚠ これは**アプリの配る量ではない** ── 訪問者は落とさない(押したときだけ取りに行く)。
 *   だから上の cap には数えないが、**数えないことと見ないことは別**である。
 * 🔑 実測 **7051.7 KB**(2026-08-29、`VITE_PKC_KIND=product npm run build:portable`)。
 *   アプリ本体(6512.1 KB)を 1 枚へ inline するので、binary が base64 で膨らむぶん大きい。
 * ⚠ 余裕は約 1950 KB ── **誤取込 1 本(数百 KB〜MB)は止まる**。
 *   下限は「空 / 途中で切れた雛形」だけを狙う(実測の半分以下)。
 * 🔑 2026-09-04(#648 段③)にマニュアルの page を 1 枚の中へ焼き込んだ ── 実測 **7613.5 KB**
 *   (dev の kind で `npm run build:portable`。+562 KB = page 391 KB を JSON で逃がした分)。
 *   cap 9000 KB の内に収まったので動かしていない(余裕は約 1390 KB ── 誤取込 1 本は今も止まる)。
 */
const PORTABLE_CAP_KB = 9000;
const PORTABLE_FLOOR_KB = 3000;

/**
 * 🔴 **焼いたマニュアル(`manual.html`)の下限**(#645 段②)。
 * ⚠ 上限は要らない(アプリの cap の内で数える)。下限だけ ── 描画が空振りして
 *   見出し 0 本の page を配ろうとしたとき、plugin の門(見出しの本数)が**外された日**にも
 *   ここが鳴る(入力の門と出力の門は別物 ── CLAUDE.md §8)。
 * 🔑 実測 **334.9 KB**(2026-09-02)。下限はその 1/3 弱 ── 事故の桁だけを止める。
 */
const MANUAL_FLOOR_KB = 100;

/** 中身を読む対象(テキストの生成物だけ。wasm は読まない)。 */
const TEXTUAL = /\.(?:js|mjs|cjs|css|html|webmanifest|json)$/;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    // path 区切りは常に `/`(規則側は `/` 区切り前提で basename を取る)
    else out.push({ path: relative(DIST, full).split(sep).join('/'), bytes: st.size });
  }
  return out;
}

const kind = positional[0];
if ((kind !== 'product' && kind !== 'dev') || unknownFlags.length > 0) {
  if (unknownFlags.length > 0) console.error(`知らない旗: ${unknownFlags.join(' ')}`);
  console.error('usage: node scripts/check-dist.mjs <product|dev> [dir] [--require-manual]');
  process.exit(2);
}

let files;
try {
  files = walk(DIST);
} catch (e) {
  // ⚠ 原因を握り潰さない。壊れた symlink 1 本でも `statSync` は throw するので、
  // 一律「dist が無い」と言うと CI ログを読む人を確実に迷わせる
  if (e?.code === 'ENOENT' && e.path === DIST) {
    console.error(`✗ 検品対象が無い(先に build する): ${DIST}`);
  } else {
    console.error(`✗ 検品対象を走査できない: ${e?.message ?? e}`);
  }
  process.exit(1);
}

const text = new Map();
for (const f of files) {
  // ⚠ **雛形は読まない**(7 MB の 1 枚)── 規則はこの file の中身を 1 つも見ないので、
  //    読むのは丸ごと無駄である(そして inline map の走査が誤検知しうる)
  if (f.path === PORTABLE_TEMPLATE || f.path === MANUAL_PAGE) continue; // 規則は中身を 1 つも見ない
  if (!f.path.endsWith('.map') && TEXTUAL.test(f.path)) {
    text.set(f.path, readFileSync(join(DIST, f.path), 'utf-8'));
  }
}

const { lines, errors } = inspectDist({
  kind,
  capKb: SHIPPED_CAP_KB,
  floorKb: SHIPPED_FLOOR_KB[kind],
  sidecarCapKb: PORTABLE_CAP_KB,
  sidecarFloorKb: PORTABLE_FLOOR_KB,
  manualFloorKb: MANUAL_FLOOR_KB,
  // 🔴 焼きたての product だけ manual.html の実在を要求する(release.yml / nightly.yml が渡す)
  requireManual: flags.includes('--require-manual'),
  files,
  text,
});
for (const l of lines) console.log(l);
if (errors.length > 0) {
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log('  ✓ ok');
