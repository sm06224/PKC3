#!/usr/bin/env node
/**
 * ビルド生成物の検品(P7 段①)。
 *
 *   node scripts/check-dist.mjs product   # map が 1 つでもあれば落とす + 配信量の tripwire
 *   node scripts/check-dist.mjs dev       # map が 1 つも無ければ落とす(調査手段の喪失)
 *
 * 🔑 **2 段構え**。`tests/build-config.test.ts` は「config がそう書いてあるか」しか
 * 見ない ── plugin が map を足す・`--sourcemap` が渡る、といった経路は config を
 * 読んでも分からないので、**実物のファイル一覧**をここで見る。
 *
 * ⚠ dev 側を「map が有ること」で縛るのが本体である。product 側だけを縛ると、
 * 事故で両方から map が消えたときに**誰も気づかない**(§5-2 の裁定は
 * 「product の配信量だけを捨てる。調査手段は失わない」)。
 *
 * 🔑 size cap は**手違いの検出**であって、サイズを守らせる規律ではない
 * (PKC2 から継承)。通常増加で触れたら引き上げてよい ── 止めたいのは
 * 「重い dep の誤取込」「生成物の取り違え」という**桁の事故**である。
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

/** product で配る量(= SW が precache する量)の tripwire。KB。 */
const PRECACHE_CAP_KB = 2400;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push({ path: relative(DIST, full), bytes: st.size });
  }
  return out;
}

const kind = process.argv[2];
if (kind !== 'product' && kind !== 'dev') {
  console.error('usage: node scripts/check-dist.mjs <product|dev>');
  process.exit(2);
}

let files;
try {
  files = walk(DIST);
} catch {
  console.error(`✗ dist/ が無い(先に build する): ${DIST}`);
  process.exit(1);
}

const maps = files.filter((f) => f.path.endsWith('.map'));
const shipped = files.filter((f) => !f.path.endsWith('.map'));
const kb = (b) => (b / 1024).toFixed(1);
const shippedBytes = shipped.reduce((a, f) => a + f.bytes, 0);
const mapBytes = maps.reduce((a, f) => a + f.bytes, 0);

console.log(`[${kind}] ファイル ${files.length} 件 / うち map ${maps.length} 件`);
console.log(`  配る量: ${kb(shippedBytes)} KB   map: ${kb(mapBytes)} KB`);

const errors = [];

// 🔴 **数える前に「数えているものが本物か」を見る**。変異試験で判明 ──
// `walk` が sub dir へ降りなくなると `assets/` を丸ごと見落とし、
// 配る量 1.7 KB・map 0 件で **product の検査が全部通ってしまう**
// (dev 側だけが「map が無い」で鳴った)。空振りした検査は、
// 通ったという事実だけを残すのでいちばん危険な壊れ方をする。
const REQUIRED = [
  { what: 'index.html', ok: (f) => f.path === 'index.html' },
  { what: 'manifest.webmanifest', ok: (f) => f.path === 'manifest.webmanifest' },
  { what: 'sqlite の .wasm', ok: (f) => f.path.endsWith('.wasm') },
  { what: 'entry の .js', ok: (f) => f.path.endsWith('.js') },
];
for (const r of REQUIRED) {
  if (!shipped.some(r.ok)) errors.push(`dist に ${r.what} が無い ── 生成物として成立していない`);
}

// 🔑 cap は **両方の kind で見る**。配る量は kind でほぼ変わらない
// (差は `//# sourceMappingURL=` の行だけ ── 実測 1610.9 KB / 1611.1 KB)ので、
// PR gate の dev ビルド 1 回で tripwire が効く。product ビルドを PR gate に
// 足さない = CI を長くしない(user 指示 2026-07-30)。
const capBytes = PRECACHE_CAP_KB * 1024;
const remain = capBytes - shippedBytes;
if (remain < 0) {
  errors.push(
    `配る量が cap を ${kb(-remain)} KB 超過(cap ${PRECACHE_CAP_KB} KB)。` +
      `重い dep の誤取込・生成物の取り違えでなければ cap を引き上げてよい`,
  );
} else {
  console.log(
    `  cap 残量: ${kb(remain)} KB(${((remain / capBytes) * 100).toFixed(1)}% / cap ${PRECACHE_CAP_KB} KB)`,
  );
}

if (kind === 'product') {
  if (maps.length > 0) {
    errors.push(
      `product に map が ${maps.length} 件ある(配信量 +${kb(mapBytes)} KB):\n` +
        maps.map((f) => `      ${f.path}`).join('\n'),
    );
  }
} else if (maps.length === 0) {
  // ⚠ ここが鳴らないと「product から map を外す」変更が dev まで巻き込んでも気づけない
  errors.push('dev に map が 1 件も無い ── 本番障害の調査手段が消える');
}

if (errors.length > 0) {
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log('  ✓ ok');
