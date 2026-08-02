/**
 * 生成物の検品規則(純粋部)。I/O は `check-dist.mjs` 側。
 *
 * 🔴 **分離した理由**: P7 段① のレビューで、この検品の規則のうち **2 件が
 * 空振りしていた**(「entry の `.js` が在る」は `sw.js` に救われ、アプリ本体が
 * 消えても通った)。検品する側が壊れると、**「通った」という事実だけが残る** ──
 * いちばん危険な壊れ方をするので、規則そのものを test で縛れる形にした。
 */

/** Vite の出力名 `<base>-<hash8>.<ext>`。参照の実在検査に使う。 */
const HASHED_NAME = /-[A-Za-z0-9_-]{8}\.(?:js|wasm|css)$/;
/** 名前らしき連なり(引用符・括弧で切れる)。この単位で `HASHED_NAME` を判定する。 */
const NAME_RUN = /[A-Za-z0-9._-]+/g;
/** base64 で埋め込まれた sourcemap。`.map` の**件数には一切現れない**。 */
const INLINE_MAP = /sourceMappingURL=data:application\/json/;

/**
 * @param {{kind: 'product'|'dev', capKb: number,
 *          files: {path: string, bytes: number}[],
 *          text: Map<string, string>}} input
 * @returns {{lines: string[], errors: string[], shippedBytes: number,
 *            mapBytes: number, inlineMapFiles: string[]}}
 */
export function inspectDist({ kind, capKb, files, text }) {
  const maps = files.filter((f) => f.path.endsWith('.map'));
  const shipped = files.filter((f) => !f.path.endsWith('.map'));
  const kb = (b) => (b / 1024).toFixed(1);
  const shippedBytes = shipped.reduce((a, f) => a + f.bytes, 0);
  const mapBytes = maps.reduce((a, f) => a + f.bytes, 0);
  const inlineMapFiles = [...text].filter(([, s]) => INLINE_MAP.test(s)).map(([p]) => p);

  const lines = [
    `[${kind}] ファイル ${files.length} 件 / うち map ${maps.length} 件`,
    `  配る量: ${kb(shippedBytes)} KB   map: ${kb(mapBytes)} KB` +
      (inlineMapFiles.length > 0 ? `   inline map: ${inlineMapFiles.length} 件` : ''),
  ];
  const errors = [];

  // ── ① 生成物として成立しているか(空振り防止の土台)
  const has = (pred) => shipped.some(pred);
  if (!has((f) => f.path === 'index.html')) {
    errors.push('dist に index.html が無い ── 生成物として成立していない');
  }
  if (!has((f) => f.path === 'manifest.webmanifest')) {
    errors.push('dist に manifest.webmanifest が無い ── PWA として成立していない');
  }
  if (!has((f) => f.path.endsWith('.wasm'))) {
    errors.push('dist に sqlite の .wasm が無い ── storage が起動しない');
  }

  // ── ② **参照されているものが実在するか**。
  // 🔴 「`.js` が 1 件でもある」型の検査は `sw.js`(public の静的コピー)が常に
  // 満たすので、entry chunk が丸ごと消えても通ってしまった(レビュー H-2 で実証:
  // `rm dist/assets/index-*.js` のあと `✓ ok`)。index.html が指す先と、bundle が
  // 名指しする hash 付き生成物(worker / wasm)の**両方向**で突き合わせる。
  const names = new Set(shipped.map((f) => f.path.split('/').pop()));
  const wanted = new Map(); // 参照名 → 誰が参照しているか
  const html = text.get('index.html');
  if (html !== undefined) {
    const refs = [...html.matchAll(/(?:src|href)="\.\/([^"?#]+)/g)].map((m) => m[1]);
    // ⚠ 参照 0 件は「壊れていない」ではなく**走査が空振りしている**
    if (refs.length === 0) {
      errors.push('index.html が生成物を 1 つも参照していない ── 走査が空振りしている');
    }
    for (const r of refs) if (!shipped.some((f) => f.path === r)) wanted.set(r, 'index.html');
  }
  for (const [path, s] of text) {
    if (!path.endsWith('.js')) continue;
    for (const run of s.match(NAME_RUN) ?? []) {
      // ⚠ `foo-HASH.js.map` は run 全体が `.map` 終わりなので拾わない(意図どおり)
      if (HASHED_NAME.test(run) && !names.has(run)) wanted.set(run, path);
    }
  }
  if (wanted.size > 0) {
    errors.push(
      `参照されている生成物が dist に無い(${wanted.size} 件):\n` +
        [...wanted].map(([r, by]) => `      ${r}  ← ${by}`).join('\n'),
    );
  }

  // ── ③ 配る量の tripwire。
  // 🔑 cap は **両方の kind で見る**。配る量は kind でほぼ変わらない
  // (実測 1610.9 / 1611.1 KB)ので、PR gate の dev ビルド 1 回で効く
  // = product ビルドを PR gate に足さない(CI を長くしない・user 指示 2026-07-30)。
  // ⚠ 「同じコード」ではない ── `BUILD_KIND` の刻印が bundle に焼き込まれるので
  // entry chunk の中身と content hash は kind ごとに違う。同じなのは**量**だけ。
  const capBytes = capKb * 1024;
  const remain = capBytes - shippedBytes;
  if (remain < 0) {
    errors.push(
      `配る量が cap を ${kb(-remain)} KB 超過(cap ${capKb} KB)。` +
        (inlineMapFiles.length > 0
          ? '⚠ inline map が入っている ── cap を上げる前にそちらを消すこと'
          : '重い dep の誤取込・生成物の取り違えでなければ cap を引き上げてよい'),
    );
  } else {
    lines.push(
      `  cap 残量: ${kb(remain)} KB(${((remain / capBytes) * 100).toFixed(1)}% / cap ${capKb} KB)`,
    );
  }

  // ── ④ map の有無。⚠ **inline も map である**。
  // `--sourcemap inline` は `.map` を 1 件も出さないので、件数だけを見ると
  // 4.3MB の base64 map を出荷しながら「map 0 件」と報告する(レビュー M-2 で実証)。
  if (kind === 'product') {
    if (maps.length > 0) {
      errors.push(
        `product に map が ${maps.length} 件ある(配信量 +${kb(mapBytes)} KB):\n` +
          maps.map((f) => `      ${f.path}`).join('\n'),
      );
    }
    if (inlineMapFiles.length > 0) {
      errors.push(
        `product に inline sourcemap が ${inlineMapFiles.length} 件ある(件数に出ない):\n` +
          inlineMapFiles.map((p) => `      ${p}`).join('\n'),
      );
    }
  } else if (maps.length === 0 && inlineMapFiles.length === 0) {
    // ⚠ ここが鳴らないと「product から map を外す」変更が dev まで巻き込んでも気づけない
    errors.push('dev に map が 1 件も無い ── 本番障害の調査手段が消える');
  }

  return { lines, errors, shippedBytes, mapBytes, inlineMapFiles };
}
