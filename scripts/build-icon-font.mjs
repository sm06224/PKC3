#!/usr/bin/env node
/**
 * 🔴 **図案の書体を焼く**(#1054 段①、2026-09-25 ── 書体を Material Symbols から
 * **Phosphor Duotone** へ入れ替えた。裁定は #1046 コメント 5833269607 /
 * 5833340597、issue #1054)。
 *
 * `src/features/icon/symbols.ts` に並ぶ絵**だけ**を含む Phosphor Duotone の
 * 部分集合を、**外の網へ行かずに**(devDependency `@phosphor-icons/web` を
 * `node_modules` から読む)`src/styles/fonts/pkc-symbols.woff2` へ焼く。
 *
 * ```
 * npm run icons:font
 * ```
 *
 * ⚠ **絵を足したら必ず回す。** 回さないと、足した絵だけ**豆腐(□)**になる。
 * 門は `tests/features/icon-symbols.test.ts`。
 *
 * ## 🔴 いまは完全にオフライン(2026-09-25 に変わった)
 *
 * ⚠ 直す前(Material Symbols)は `fonts.googleapis.com` / `fonts.gstatic.com` へ
 * 毎回取りに行っていた。⚠ **いまは 1 バイトも外へ出ない** ── 書体そのものを
 * devDependency として同梱し(`node_modules/@phosphor-icons/web`)、そこから
 * `fontTools`(`pyftsubset` 相当を Python API で叩く `scripts/subset-duotone.py`)
 * で部分集合にする。**決定的**(同じ入力なら同じ bytes。`TTFont(..., recalcTimestamp:
 * false)` を要る ── `Options.recalc_timestamp` だけでは `head.modified` が
 * 焼き直すたびにずれた。実測して分かった罠なので、この 2 つは両方要る)。
 *
 * ## 🔴 Duotone は 1 絵につき符号位置が 2 つ、しかも**付け替える**
 *
 * Phosphor Duotone は「下地(underlay、薄い色)」+「線(line、濃い色)」の
 * 2 枚重ねで 1 つの絵になる(`::before` + `::after`、`margin-left: -1em` で
 * 重ねる ── Phosphor 自身の `style.css` と同じ技法)。
 * ⚠ **符号位置は Phosphor のものをそのまま使わない** ── この表(`symbols.ts`)の
 * **並び順**から `0xE000` を起点に 2 個ずつ、こちら側の私用領域(PUA)へ
 * **付け替える**(remap)。⚠ こうする理由は 2 つ:
 *   ① 複数の PKC 名が**同じ Phosphor の絵**を指しても(`tests/features/
 *      icon-symbols.test.ts` の「別の図案が同じ符号位置を指していない」を壊さず)
 *      それぞれ**別の符号位置**を持てる
 *   ② 上流(Phosphor)が将来符号位置を動かしても、**こちら側の値は変わらない**
 *      (符号位置そのものを内部表現にしない)
 *
 * ## `--check`(#849 の設計を継承)── **検めるだけ。焼かない・書かない**
 *
 * ```
 * node scripts/build-icon-font.mjs --check
 * ```
 *
 * `symbols.ts` の `icon`(Phosphor 側の名前)が、**いま `node_modules` に
 * 入っている** `@phosphor-icons/web` の duotone 一式に実在するかを見る。
 * ⚠ **これも外の網へ行かない**(ローカルの style.css を読むだけ)。
 *
 * | exit code | 意味 |
 * |---|---|
 * | 0 | 一致(緑) |
 * | 1 | `symbols.ts` に在る名前が、Phosphor の duotone 一式に無い(赤) |
 * | 2 | **`@phosphor-icons/web` が読めない**(測れなかった。赤ではない ──
 * |   | 呼び出し側が warning に変えて exit 0 にする) |
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SYMBOLS = 'src/features/icon/symbols.ts';
const OUT = 'src/styles/fonts/pkc-symbols.woff2';
/** ⚠ 焼いた中身の目録(test が読む ── woff2 は圧縮されていて読めない)。 */
const LIST = 'src/styles/fonts/pkc-symbols.codepoints';
/** ⚠ 絵を出す規則。**字は器に入れない**ので、`::before` / `::after` の `content` がここに要る。 */
const CSS_OUT = 'src/styles/icons.generated.css';
const PHOSPHOR_CSS = 'node_modules/@phosphor-icons/web/src/duotone/style.css';
const PHOSPHOR_WOFF2 = 'node_modules/@phosphor-icons/web/src/duotone/Phosphor-Duotone.woff2';
const SUBSET_HELPER = 'scripts/subset-duotone.py';

/** PUA の起点。1 絵につき 2 個(下地・線)使う。 */
const PUA_BASE = 0xe000;
const PUA_MAX = 0xf8ff;

/**
 * ⚠ **表は `symbols.ts` から読む**(script に 2 つ目の一覧を持たない ── §7)。
 * 🔑 綴りは `key: { icon: 'name', tone: 'tone' }` で固定してあるので、そこだけを拾う。
 */
export function tableOf() {
  const src = readFileSync(SYMBOLS, 'utf8');
  const rows = [
    ...src.matchAll(/^\s*'?([a-z0-9-]+)'?: \{ icon: '([a-z0-9-]+)', tone: '([a-z]+)' \}/gm),
  ].map((m) => ({ key: m[1], icon: m[2], tone: m[3] }));
  if (rows.length === 0) throw new Error(`${SYMBOLS} から絵の名前を 1 つも読めなかった`);
  return rows;
}

/**
 * ローカルの Phosphor Duotone `style.css` から
 * `name -> { before(下地の符号位置), after(線の符号位置) }` を読む。
 *
 * ⚠ **構文で拾う**(CLAUDE.md §1)── `.ph-duotone.ph-<name>:before/:after` の
 * ブロックだけを見るので、他の書体(bold / fill / …)の同名クラスに当たらない
 * (このファイルは duotone 版の style.css 1 本だけを対象にしている)。
 *
 * @param {string} cssText
 * @returns {Map<string, {before: number, after: number}>}
 */
export function phosphorDuotoneTable(cssText) {
  const before = new Map();
  const after = new Map();
  for (const m of cssText.matchAll(
    /\.ph-duotone\.ph-([a-z0-9-]+):before\s*\{\s*content:\s*"\\([0-9a-f]+)";/g,
  )) {
    before.set(m[1], parseInt(m[2], 16));
  }
  for (const m of cssText.matchAll(
    /\.ph-duotone\.ph-([a-z0-9-]+):after\s*\{\s*content:\s*"\\([0-9a-f]+)";/g,
  )) {
    after.set(m[1], parseInt(m[2], 16));
  }
  const out = new Map();
  for (const [name, b] of before) {
    const a = after.get(name);
    // ⚠ 全数ではない(`cell-signal-none` / `wifi-none` は :after を持たない ──
    //   実測)。duotone ではない = こちらの要求対象に無ければ気にしない。
    if (a !== undefined) out.set(name, { before: b, after: a });
  }
  return out;
}

/**
 * `rows`(`PKC_SYMBOLS` の表)のうち、Phosphor の duotone 一式に
 * **名前が無い**(または片方の符号位置しか無い)ものを挙げる。
 *
 * ⚠ **集合で突き合わせる**(CLAUDE.md §8)── 件数ではなく 1 件 1 件を見る。
 *
 * @param {{key: string, icon: string, tone: string}[]} rows
 * @param {Map<string, {before: number, after: number}>} phosphor
 * @returns {string[]}
 */
export function missingFromPhosphor(rows, phosphor) {
  const offenders = [];
  for (const r of rows) {
    if (!phosphor.has(r.icon)) {
      offenders.push(`${r.key}(${r.icon}): Phosphor Duotone にその名前が無い`);
    }
  }
  return offenders;
}

/**
 * 表の並び順から、こちら側の私用領域(PUA)を 1 絵につき 2 個ずつ割り当てる。
 * ⚠ **決定的**(同じ表なら毎回同じ値。手で書かない ── CLAUDE.md §7)。
 *
 * @param {{key: string}[]} rows
 * @returns {Map<string, {underlay: number, line: number}>}
 */
export function planCodepoints(rows) {
  const out = new Map();
  rows.forEach((r, i) => {
    const underlay = PUA_BASE + i * 2;
    const line = underlay + 1;
    if (line > PUA_MAX) throw new Error(`私用領域を使い切った(${rows.length} 種は多すぎる)`);
    out.set(r.key, { underlay, line });
  });
  return out;
}

/**
 * 🔴 **検めるだけ。焼かない・書かない**(`--check`)。
 *
 * ⚠ `@phosphor-icons/web` が `node_modules` に無い(devDependency の install
 * 漏れ等)ときは **`✗`(赤)ではなく「測れなかった」と分かる形で終える**。
 */
export function runCheck() {
  const rows = tableOf();
  let cssText;
  try {
    cssText = readFileSync(PHOSPHOR_CSS, 'utf8');
  } catch (e) {
    console.error(
      `✗ 測れなかった(@phosphor-icons/web が読めない): ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(2);
  }
  const phosphor = phosphorDuotoneTable(cssText);
  const offenders = missingFromPhosphor(rows, phosphor);
  if (offenders.length > 0) {
    for (const o of offenders) console.error(`✗ ${o}`);
    process.exit(1);
  }
  console.log(`✓ ${rows.length} 種、Phosphor Duotone(${PHOSPHOR_CSS})と一致`);
}

/** 焼く(既定の動き)。 */
function runBake() {
  const rows = tableOf();

  // ① 名前が実在するかを、ローカルの Phosphor 一式で検める
  const cssText = readFileSync(PHOSPHOR_CSS, 'utf8');
  const phosphor = phosphorDuotoneTable(cssText);
  const missing = missingFromPhosphor(rows, phosphor);
  if (missing.length > 0) {
    for (const m of missing) console.error(`✗ ${m}`);
    throw new Error('Phosphor Duotone に無い名前がある(上を見よ)');
  }

  // ② こちら側の符号位置(PUA)を、表の並び順で機械的に割り当てる
  const target = planCodepoints(rows);

  // ③ subset-duotone.py へ渡す注文書を組む(源の符号位置 + 付け替え先)
  const requests = rows.map((r) => {
    const source = phosphor.get(r.icon);
    const t = target.get(r.key);
    return {
      name: r.key,
      sourceUnderlay: source.before,
      sourceLine: source.after,
      targetUnderlay: t.underlay,
      targetLine: t.line,
    };
  });

  const outAbs = new URL(`../${OUT}`, import.meta.url);
  const srcAbs = new URL(`../${PHOSPHOR_WOFF2}`, import.meta.url);
  const helperAbs = new URL(`../${SUBSET_HELPER}`, import.meta.url);

  const payload = JSON.stringify({
    src: fileURLToPath(srcAbs),
    out: fileURLToPath(outAbs),
    requests,
  });

  const result = spawnSync('python3', [fileURLToPath(helperAbs)], {
    input: payload,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    // ⚠ stderr には fontTools の warning(FFTM 等)が混ざることがある ──
    //   それ自体は失敗ではないので、まず stdout の JSON を読んでから判断する。
    let parsed;
    try {
      parsed = JSON.parse(result.stdout.trim().split('\n').pop());
    } catch {
      // stdout が JSON にならない = script 自体が落ちた
    }
    throw new Error(
      `subset-duotone.py が失敗した(exit ${result.status}): ${parsed?.error ?? result.stderr}`,
    );
  }
  const lastLine = result.stdout.trim().split('\n').pop();
  const parsed = JSON.parse(lastLine);
  if (!parsed.ok) throw new Error(`subset-duotone.py が失敗した: ${parsed.error}`);

  // ④ 空振り防止 ── woff2 の印(`wOF2`)が在ることまで見てから「焼けた」とする
  const woff2 = readFileSync(fileURLToPath(outAbs));
  if (woff2.subarray(0, 4).toString('latin1') !== 'wOF2')
    throw new Error(`woff2 ではない物が書かれた(先頭 4 バイト: ${woff2.subarray(0, 4).toString('hex')})`);

  // ⑤ 目録を読める形で隣に置く(`.codepoints`)。⚠ 1 行に 2 個(下地・線)。
  writeFileSync(
    LIST,
    rows
      .map((r) => {
        const t = target.get(r.key);
        return `${r.key} ${t.underlay.toString(16)} ${t.line.toString(16)}`;
      })
      .join('\n') + '\n',
  );

  // ⑥ 絵を出す規則も、ここで作る(符号位置の `content` だけ)。
  //    ⚠ **tone(色)はもう焼かない**(#1054 段①-2、2026-09-25)── 絵 1 つに
  //    tone は 1 つしか持てない制約を無くすため、tone は `data-pkc-tone`
  //    (JS 側。`icons.ts` の `setIcon` / `ACTION_TONES`)から読む形に移した
  //    (`app.css` の `[data-pkc-icon][data-pkc-tone='…']` が固定 7 本を持つ)。
  writeFileSync(
    CSS_OUT,
    [
      '/* 🔴 **自動生成**(`npm run icons:font`)── 手で直さない。',
      ' * 絵の表は `src/features/icon/symbols.ts`、書体は `fonts/pkc-symbols.woff2`',
      ' * (Phosphor Duotone の部分集合。#1054 段①)。',
      ' * ⚠ **器に字を入れない**ので、絵はここが出す(そうしないとボタンの `textContent` に',
      ' *   目に見えない字が混ざり、文言を読む側が静かに外れる)。',
      ' * ⚠ **tone(色)はここに無い**(#1054 段①-2)── `data-pkc-tone` を読む',
      ' *   `app.css` の `[data-pkc-icon][data-pkc-tone=\'…\']` が持つ(固定 7 本)。',
      ' *   ここは符号位置(`content`)だけを絵ごとに焼く。 */',
      ...rows.map((r) => {
        const t = target.get(r.key);
        return [
          `[data-pkc-icon][data-pkc-symbol='${r.key}']::before {`,
          `  content: '\\${t.underlay.toString(16)}';`,
          '}',
          `[data-pkc-icon][data-pkc-symbol='${r.key}']::after {`,
          `  content: '\\${t.line.toString(16)}';`,
          '}',
        ].join('\n');
      }),
      '',
    ].join('\n'),
  );
  console.log(`✓ ${OUT} ── ${rows.length} 種 / ${woff2.length} バイト`);
  console.log(`✓ ${CSS_OUT} ── ${rows.length} 種 × 2 規則`);
}

/**
 * ⚠ **CLI としての実行を、直接呼ばれたときだけに限る**(以前からの guard と同じ形)
 * ── これが無いと、この file を test から `import` した瞬間に
 * ①`node_modules` の Phosphor 一式を読み ②`spawnSync` で python を叩き
 * ③`writeFileSync` で書体と CSS を書き換える(= 表を読む口だけ確かめたい unit に
 * 副作用が走る)。
 */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) runCheck();
  else runBake();
}
