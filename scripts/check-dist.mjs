#!/usr/bin/env node
/**
 * ビルド生成物の検品(P7 段①)── I/O と CLI。規則は `dist-inspect.mjs`。
 *
 *   node scripts/check-dist.mjs product   # map が 1 つでもあれば落とす + 配信量の tripwire
 *   node scripts/check-dist.mjs dev       # map が 1 つも無ければ落とす(調査手段の喪失)
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
import { inspectDist } from './dist-inspect.mjs';

/**
 * 検品する directory。既定は `dist/`。
 * ⚠ 第 2 引数で差し替えられる ── Pages は **release の成果物を展開したもの**を
 * 配るので(P7 段⑧)、`dist/` 以外を検品する必要がある。
 */
const DIST = process.argv[3]
  ? resolve(process.argv[3])
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
 */
const SHIPPED_CAP_KB = 6000;

/**
 * 配る量の下限。KB。⚠ **cap だけでは片側しか見ていない** ── entry chunk を
 * 0 バイトにしても「配る量が減った」だけで通っていた(レビュー 2 巡目 M-1)。
 * 取り違え・chunk 欠落は**縮む方向**にも起きる。実測 4963.5 KB に対する床。
 * ⚠ mermaid の chunk 群(約 3.3 MB)が丸ごと消えると図が描けなくなるが、
 * **画面はソース表示に落ちるだけで壊れない**ので気づきにくい ── 床がその検出器。
 */
const SHIPPED_FLOOR_KB = 3500;

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

const kind = process.argv[2];
if (kind !== 'product' && kind !== 'dev') {
  console.error('usage: node scripts/check-dist.mjs <product|dev> [dir]');
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
  if (!f.path.endsWith('.map') && TEXTUAL.test(f.path)) {
    text.set(f.path, readFileSync(join(DIST, f.path), 'utf-8'));
  }
}

const { lines, errors } = inspectDist({
  kind,
  capKb: SHIPPED_CAP_KB,
  floorKb: SHIPPED_FLOOR_KB,
  files,
  text,
});
for (const l of lines) console.log(l);
if (errors.length > 0) {
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log('  ✓ ok');
