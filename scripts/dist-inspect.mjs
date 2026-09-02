/**
 * 生成物の検品規則(純粋部)。I/O は `check-dist.mjs`。
 *
 * 🔴 **分離した理由**: P7 段① のレビューで、この検品の規則が 2 ラウンドとも
 * 空振りしていた。1 巡目は「entry の `.js` が在る」が `sw.js` に救われ、
 * 2 巡目は「index.html の `./` 参照」が `manifest.webmanifest` / `icon.svg` に
 * 救われた ── **救い手が変わっただけ**だった。検品する側が壊れると
 * 「通った」という事実だけが残るので、規則そのものを test で縛れる形にしてある。
 *
 * ## 参照の見方(2 巡目 M-2 の反省)
 * 「hash らしき 8 文字 + `.js`」という**形**で拾うと、`sqlite3-vfs-opfs.js` /
 * `markdown-it-footnote.js` / `sqlite3-worker1-promiser.js`(いずれも実在の名前で、
 * 出荷 bundle の**コメントや API 名の中に既にある**)を誤検知して release を
 * 偽の理由で止める。形ではなく **参照を生む構文**(`new URL(…)` / `import(…)` /
 * `from …`)の中の文字列リテラルだけを見る。
 *
 * ⚠ それでも散文は入り込む ── 実物の bundle に `` …invoked from`,`client-level… ``
 * がある。そこで **場所によって受け方を変える**:
 * - **構造化された場所**(HTML 属性 / manifest の JSON field)= `refFromValue` … 緩く
 * - **コードの中**(散文が混じる)= `refFromCode` … `./` `../` `/` 始まりか
 *   hash 付き名だけ。狭く当てる
 * 🔑 誤差の向きを分けるのが要点で、**片方の規則をもう片方に流用してはいけない**
 * (CLAUDE.md「判定を増やさない。誤差の向きを決めて、両側に使い回さない」)。
 */

/** Vite の出力名 `<base>-<hash8>.<ext>`。空振りガードと孤立検出に使う。 */
const HASHED_NAME = /-[A-Za-z0-9_-]{8}\.(?:js|mjs|cjs|wasm|css)$/;
/** 参照を生む構文の中の文字列リテラル。 */
const REF_CONSTRUCT = /(?:new URL\(|import\(|from\s*)(["'`])([^"'`\n]+)\1/g;
/** index.html の `src` / `href`。引用符はどちらでも受ける。 */
const HTML_REF = /(?:src|href)\s*=\s*("|')([^"']+)\1/g;
/** base64 で埋め込まれた sourcemap。`.map` の**件数には一切現れない**。 */
const INLINE_MAP = /sourceMappingURL=data:application\/json/;
/** 中身を走査する script(`.mjs` / `.cjs` を落とすと inline map が素通りする)。 */
const SCRIPT = /\.(?:js|mjs|cjs)$/;

/**
 * **構造化された場所**(HTML 属性 / manifest の JSON field)の参照文字列 →
 * dist 内の相対 path。ここは散文が混じらないので、外部 URL と拡張子だけ見る。
 */
function refFromValue(raw) {
  if (typeof raw !== 'string' || raw.includes(':') || raw.startsWith('//')) return null;
  const clean = raw.split(/[?#]/)[0];
  return /\.[A-Za-z0-9]+$/.test(clean) ? clean : null;
}

/**
 * **コードの中**の参照文字列 → dist 内の相対 path。
 *
 * 🔴 こちらは **狭く当てる**(誤差の向きを決める)。広いと **release が偽の理由で
 * 止まる** ── 出荷 bundle には `` …invoked from`,`client-level… `` のように、
 * 散文の "from" の直後に文字列が来る箇所が実在する(2 巡目 M-2)。受けるのは
 * ① `./` `../` `/` で始まる path ② hash 付きの生成物名(Vite の worker 参照は
 * 前置き無しの裸名で出る)の 2 形だけ。散文はどちらにも該当しない。
 */
function refFromCode(raw) {
  const clean = refFromValue(raw);
  if (clean === null) return null;
  return /^\.{0,2}\//.test(clean) || HASHED_NAME.test(clean) ? clean : null;
}

/** 参照元 file からの相対解決(`./` `../` `/` を畳む)。 */
function resolveFrom(referrer, ref) {
  const base = ref.startsWith('/') ? [] : referrer.split('/').slice(0, -1);
  const out = [];
  for (const p of [...base, ...ref.split('/')]) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

/**
 * @param {{kind: 'product'|'dev', capKb: number, floorKb: number,
 *          sidecarCapKb?: number, sidecarFloorKb?: number,
 *          files: {path: string, bytes: number}[],
 *          text: Map<string, string>}} input
 * @returns {{lines: string[], errors: string[]}}
 */
/**
 * 「持ち歩ける 1 枚」の雛形の**名前**(#400 段④)。⚠ 綴りは 3 か所で一致していなければ
 * ならない ── `release.yml` / `pages.yml` が置く名前と、ここ。
 * 🔑 だから **export して `tests/workflow-steps.test.ts` 側から引ける**ようにする
 *   (片方だけ改名すると、また黙って検品対象に混ざる)。
 */
export const PORTABLE_TEMPLATE = 'portable-template.html';

/**
 * 焼いたマニュアル(#645 段②)。`build/manual-page-plugin.ts` が `generateBundle` で emit する。
 * ⚠ アプリの一部(オフラインでも読む)── precache に**載る**し、配る量にも**数える**
 *   (雛形とは逆)。綴りは `features/help/manual-page.ts` の `MANUAL_PAGE_FILE` と同じ
 *   (`tests/dist-inspect.test.ts` が突き合わせる)。
 */
export const MANUAL_PAGE = 'manual.html';

export function inspectDist({
  kind,
  capKb,
  floorKb,
  sidecarCapKb,
  sidecarFloorKb,
  manualFloorKb,
  files,
  text,
}) {
  const maps = files.filter((f) => f.path.endsWith('.map'));
  /**
   * 🔴 **配るが、アプリの一部ではない物**(#400 段④。2026-08-29 に本番を止めて分かった)。
   *
   * `portable-template.html` は「持ち歩ける 1 枚」の雛形で、**押したときだけ**
   * 取りに行く。だから ①SW の precache に載せてはいけない(install のたびに
   * 7 MB 増える)②アプリの「配る量」に数えてはいけない(訪問者は落とさない)。
   *
   * ⚠ **これを知らずに 2 つとも数えていた** ── `release.yml` は自分の検品の**後**に
   *   この file を足し、`pages.yml` は**その zip を展開して検品する**ので、
   *   v3.2.0 の本番配布が「precache に載っていない生成物がある」+
   *   「cap を 6563.8 KB 超過」で落ちた(実測 run 33256868235)。
   * ⚠ **v3.1.0 の `release.yml` にはこの step が無い**(144 行 / `portable` 0 件)──
   *   つまり**この経路は今日まで一度も通っていなかった**(§2)。
   *
   * 🔑 だから「検品の後に足す」という**順番**に頼るのをやめ、**規則の側**が
   *   別立てだと知る。⚠ 名前は**丸ごと一致**で見る(#225 の教訓 ── 尻だけ留めると
   *   前に伸びた名前に当たる)。
   * ⚠ `dev` 側の `_site/dev/portable-template.html` は**ここへ書かない** ──
   *   `check-dist.mjs dev` は `dist/` を見るので、そこにこの file は**存在しえない**
   *   (成り立たない条件を書かない。§1)。
   */
  const sidecar = files.filter((f) => f.path === PORTABLE_TEMPLATE);
  const shipped = files.filter((f) => !f.path.endsWith('.map') && f.path !== PORTABLE_TEMPLATE);
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
  const paths = new Set(shipped.map((f) => f.path));

  // ── ① 生成物として成立しているか(空振り防止の土台)
  if (!paths.has('index.html')) {
    errors.push('dist に index.html が無い ── 生成物として成立していない');
  }
  if (!paths.has('manifest.webmanifest')) {
    errors.push('dist に manifest.webmanifest が無い ── PWA として成立していない');
  }
  if (!paths.has('sw.js')) {
    // entry が `register('./sw.js')` する ── 文字列参照なので構文走査には出ない
    errors.push('dist に sw.js が無い ── PWA の登録先が消えている(オフラインで動かない)');
  }
  if (!shipped.some((f) => f.path.endsWith('.wasm'))) {
    errors.push('dist に sqlite の .wasm が無い ── storage が起動しない');
  }
  // 🔴 **縮む方向の事故**も止める。cap は上限しか見ないので、entry chunk を
  // 0 バイトにしても「配る量が減った」だけで通っていた(2 巡目 M-1 で実証)
  const empty = shipped.filter((f) => f.bytes === 0);
  if (empty.length > 0) {
    errors.push(`空のファイルが出荷されている:\n${empty.map((f) => `      ${f.path}`).join('\n')}`);
  }

  // ── ② **参照されているものが実在するか**(前方)と、
  //      **誰からも参照されていない生成物が無いか**(後方)。
  const wanted = new Map(); // 参照先 → 参照元
  const referenced = new Set();
  const note = (referrer, raw, from) => {
    const ref = from(raw);
    if (ref === null) return;
    const target = resolveFrom(referrer, ref);
    if (paths.has(target)) referenced.add(target);
    else wanted.set(target, referrer);
  };

  const html = text.get('index.html');
  if (html !== undefined) {
    const refs = [...html.matchAll(HTML_REF)].map((m) => m[2]);
    for (const r of refs) note('index.html', r, refFromValue);
    // 🔴 空振りガードは **hash 付き生成物への参照**で見る。「参照が 1 件でもある」に
    // すると、Vite が書き換えない `public/` の静的参照(`./manifest.webmanifest` /
    // `./icon.svg`)だけで満たされてしまい、`base` を `/` にした瞬間に
    // entry chunk が走査から消えても鳴らなくなる(2 巡目 H-1 で実証)
    if (!refs.some((r) => HASHED_NAME.test(refFromValue(r) ?? ''))) {
      errors.push(
        'index.html が hash 付き生成物を 1 つも参照していない ── 走査が空振りしている',
      );
    }
  }
  for (const [path, s] of text) {
    if (!SCRIPT.test(path)) continue;
    for (const m of s.matchAll(REF_CONSTRUCT)) note(path, m[2], refFromCode);
  }
  if (wanted.size > 0) {
    errors.push(
      `参照されている生成物が dist に無い(${wanted.size} 件):\n` +
        [...wanted].map(([r, by]) => `      ${r}  ← ${by}`).join('\n'),
    );
  }
  const orphans = shipped.filter((f) => HASHED_NAME.test(f.path) && !referenced.has(f.path));
  if (orphans.length > 0) {
    // hash 付きの生成物は必ず誰かが名指しする。孤立 = 参照の付け替え漏れか、走査漏れ
    errors.push(
      `誰からも参照されていない hash 付き生成物がある(${orphans.length} 件):\n` +
        orphans.map((f) => `      ${f.path}`).join('\n'),
    );
  }

  // ── ③ SW の precache 一覧が**生成物と一致するか**(P7 段④、設計 doc §3)
  // 🔴 手書きの一覧は必ず腐る(hash 付き名はビルドのたびに変わる)ので生成している。
  // ⚠ 生成器が空を吐いても**それ自体は誰も気づかない** ── ここで突き合わせる
  const swText = text.get('sw.js');
  if (swText !== undefined) {
    // ⚠ `[^\]]*` だと名前に `]` を含む生成物で**マッチしなくなり**、
    // 「生成器が壊れている」という**嘘の診断**を出す(review L-6)。行末まで取る
    const m = /const PRECACHE = (\[.*\]);/.exec(swText);
    if (!m) {
      errors.push('sw.js に precache 一覧が無い ── 生成器が壊れている');
    } else {
      let listed = [];
      try {
        listed = JSON.parse(m[1]);
      } catch (e) {
        errors.push(`sw.js の precache 一覧が読めない: ${e.message}`);
      }
      const want = shipped.map((f) => f.path).filter((p) => p !== 'sw.js');
      const have = new Set(listed.map((u) => u.replace(/^\.\//, '')));
      /**
       * 🔴 **両方向を見る**(#225 の教訓)。上の `want` から外しただけだと
       *   「載っていない」しか守れない ── **載せてしまった**ときに鳴らない。
       * ⚠ 載せると install のたびに 7 MB 落ちる(しかも二重に持つ)。
       */
      if (have.has(PORTABLE_TEMPLATE)) {
        errors.push(
          `precache に ${PORTABLE_TEMPLATE} が載っている ── ` +
            'これは押したときだけ取りに行く雛形で、install で落とす物ではない',
        );
      }
      const missing = want.filter((p) => !have.has(p));
      const extra = [...have].filter((p) => !want.includes(p));
      if (listed.length === 0) {
        errors.push('sw.js の precache 一覧が空 ── オフラインで何も出ない');
      }
      if (missing.length > 0) {
        errors.push(`precache に載っていない生成物がある:\n${missing.map((p) => `      ${p}`).join('\n')}`);
      }
      if (extra.length > 0) {
        errors.push(`precache が実在しないものを指している:\n${extra.map((p) => `      ${p}`).join('\n')}`);
      }
    }
  }

  // ── ④ manifest が指す先まで見る(PWA は install 時にここを読む)
  const manifestText = text.get('manifest.webmanifest');
  if (manifestText !== undefined) {
    let manifest = null;
    try {
      manifest = JSON.parse(manifestText);
    } catch (e) {
      errors.push(`manifest.webmanifest が JSON として読めない: ${e.message}`);
    }
    for (const icon of manifest?.icons ?? []) {
      const target = resolveFrom('manifest.webmanifest', refFromValue(icon.src) ?? '');
      if (target !== '' && !paths.has(target)) {
        wanted.set(target, 'manifest.webmanifest');
        errors.push(`manifest が指す icon が無い: ${icon.src}`);
      }
    }
  }

  // ── ⑤ 配る量。**上限と下限の両方**を見る。
  // 🔑 cap は両方の kind で見る。配る量は kind でほぼ変わらない(実測 1610.9 /
  // 1611.1 KB)ので、PR gate の dev ビルド 1 回で効く = product ビルドを
  // PR gate に足さない(CI を長くしない・user 指示 2026-07-30)。
  // 🔑 手違いの検出であって、サイズを守らせる規律ではない ── 通常増減で触れたら
  // 動かしてよい。止めたいのは誤取込・取り違えという**桁の事故**である。
  /**
   * 🔴 **別立てにしたぶん、別立ての門を置く**(2026-08-29)。
   *
   * ⚠ アプリの cap から外した瞬間、この file は**どんな大きさでも通る**ようになる ──
   *   0 バイトでも、誤って 100 MB でも。それは tripwire を 1 つ**撤廃した**のと同じである
   *   (CLAUDE.md「予算は手違いの検出。⚠ 撤廃はしない」)。
   * 🔑 実測 **7051.7 KB**(2026-08-29、`VITE_PKC_KIND=product npm run build:portable`)──
   *   アプリ本体を 1 枚へ inline するので、binary が base64 で膨らむぶん本体より大きい。
   * ⚠ 予算が**渡っていない**ときは黙って通さない ── optional にすると、
   *   呼び側が渡し忘れた日に**門ごと消える**(§7「待ちの口は optional にしない」)。
   */
  if (sidecar.length > 0) {
    const bytes = sidecar.reduce((a, f) => a + f.bytes, 0);
    lines.push(`  別立て: ${PORTABLE_TEMPLATE} ${kb(bytes)} KB(precache しない / cap の外)`);
    if (sidecarCapKb === undefined || sidecarFloorKb === undefined) {
      errors.push(
        `${PORTABLE_TEMPLATE} が在るのに、その予算が渡っていない ── ` +
          '呼び側が `sidecarCapKb` / `sidecarFloorKb` を渡していない(門が消えている)',
      );
    } else if (bytes > sidecarCapKb * 1024) {
      errors.push(
        `${PORTABLE_TEMPLATE} が cap を ${kb(bytes - sidecarCapKb * 1024)} KB 超過` +
          `(cap ${sidecarCapKb} KB)。取り違えでなければ引き上げてよい`,
      );
    } else if (bytes < sidecarFloorKb * 1024) {
      errors.push(
        `${PORTABLE_TEMPLATE} が下限を ${kb(sidecarFloorKb * 1024 - bytes)} KB 下回る` +
          `(下限 ${sidecarFloorKb} KB)── 空 / 途中で切れた雛形を配ろうとしている`,
      );
    }
  }

  // ── ⑥ 焼いたマニュアル(#645 段②)── **届いたか**を出力の側で見る
  /**
   * 🔴 plugin の下限(見出しの本数)は**入力の側**の門である ── emit が落ちても、
   *   plugin の順が変わって precache から漏れても、そこは鳴らない。
   *   「直した所」ではなく「直した結果が届いたか」に tripwire を置く(CLAUDE.md §8)。
   * ⚠ `dev` だけ**在ること**を要求する ── `product` は**過去に release した zip**も
   *   検品する(Pages の `/`)ので、段②より前の版(v3.2.0)に在るはずが無い。
   *   在るときの下限は両方で見る(空 / 途中で切れた page を配らない)。
   * ⚠ 予算が渡っていなければ黙って通さない(雛形と同じ作法)。
   */
  const manual = files.find((f) => f.path === MANUAL_PAGE);
  if (manualFloorKb === undefined) {
    errors.push(`${MANUAL_PAGE} の予算が渡っていない ── 呼び側が \`manualFloorKb\` を渡していない(門が消えている)`);
  } else if (manual === undefined) {
    if (kind === 'dev') {
      errors.push(
        `dist に ${MANUAL_PAGE} が無い ── マニュアルの窓が SPA fallback で PKC をもう 1 枚開く` +
          '(plugin が emit していないか、順番が変わった)',
      );
    }
  } else {
    lines.push(`  マニュアル: ${MANUAL_PAGE} ${kb(manual.bytes)} KB(precache に載る / cap の内)`);
    if (manual.bytes < manualFloorKb * 1024) {
      errors.push(
        `${MANUAL_PAGE} が下限を ${kb(manualFloorKb * 1024 - manual.bytes)} KB 下回る` +
          `(下限 ${manualFloorKb} KB)── 描画が空振りした page を配ろうとしている`,
      );
    }
  }

  const capBytes = capKb * 1024;
  const floorBytes = floorKb * 1024;
  const remain = capBytes - shippedBytes;
  if (remain < 0) {
    errors.push(
      `配る量が cap を ${kb(-remain)} KB 超過(cap ${capKb} KB)。` +
        (inlineMapFiles.length > 0
          ? '⚠ inline map が入っている ── cap を上げる前にそちらを消すこと'
          : '重い dep の誤取込・生成物の取り違えでなければ cap を引き上げてよい'),
    );
  } else if (shippedBytes < floorBytes) {
    errors.push(
      `配る量が下限を ${kb(floorBytes - shippedBytes)} KB 下回る(下限 ${floorKb} KB)。` +
        '生成物の取り違え・chunk の欠落を疑う',
    );
  } else {
    lines.push(
      `  cap 残量: ${kb(remain)} KB(${((remain / capBytes) * 100).toFixed(1)}% / cap ${capKb} KB)`,
    );
  }

  // ── ⑥ map の有無。⚠ **inline も map である**。
  // `--sourcemap inline` は `.map` を 1 件も出さないので、件数だけを見ると
  // 4.3MB の base64 map を出荷しながら「map 0 件」と報告する(1 巡目 M-2 で実証)。
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

  return { lines, errors };
}
