#!/usr/bin/env node
/**
 * 🔴 **図案の書体を焼き直す**(#770 段①、2026-09-11)。
 *
 * `src/features/icon/symbols.ts` に並ぶ絵**だけ**を含む Material Symbols の
 * 部分集合を落として `src/styles/fonts/pkc-symbols.woff2` へ置く。
 *
 * ```
 * npm run icons:font
 * ```
 *
 * ⚠ **絵を足したら必ず回す。** 回さないと、足した絵だけ**豆腐(□)**になる
 * ── 書体に glyph が無いからである。門は `tests/features/icon-symbols.test.ts`
 * (同梱した書体の中身と表を突き合わせる)。
 *
 * ⚠ **CI では回さない。** 外の網に依存する操作なので、**焼いた物を repo に置く**
 * (取れない日にビルドが止まる形にしない)。
 *
 * ## `--check`(#849、2026-09-13)── **検めるだけ。焼かない・書かない**
 *
 * ```
 * node scripts/build-icon-font.mjs --check
 * ```
 *
 * いまは焼くとき(下の①)にしか上流と突き合わせていないので、**上流が符号位置を
 * 動かしても、焼き直すまで気づけない**。`--check` はその①だけを取り出し、
 * 夜(nightly)から回す ── 何も書かないので CI で回してよい。
 *
 * ⚠ **集合で突き合わせる**(CLAUDE.md §8)。件数だけ見ると同じ数だけ取り違えても
 * 通るので、`PKC_SYMBOLS` の 1 件 1 件について**両方向**を見る:
 * ① 上流にその名前が無い(上流から消えた / こちらにしか無い)
 * ② 上流には在るが、符号位置が違う(上流が動かした)。
 *
 * 終わり方は 3 通り(CLAUDE.md §4「判定不能と結果を混ぜない」):
 *
 * | exit code | 意味 |
 * |---|---|
 * | 0 | 一致(緑) |
 * | 1 | 食い違いが在る(赤) |
 * | 2 | **上流を取得できなかった**(測れなかった。赤ではない ── 呼び出し側が
 * |   | warning に変えて exit 0 にする。`.github/workflows/nightly.yml` を見よ) |
 *
 * ## なぜ部分集合か
 *
 * | | 大きさ |
 * |---|---|
 * | 素の Material Symbols Rounded(4,284 種の可変書体) | **5.37 MB** |
 * | ここで焼く版(76 種・wght 500・FILL 0) | **約 10 KB** |
 *
 * ⚠ 配る量は棄却理由にならない(user 指示 2026-08-03)が、**常駐メモリは別**である
 * ── 76 種のために 5 MB を常駐させる理由が無い。
 *
 * ## ⚠ リガチャではなく符号位置で使う
 *
 * 部分集合にも符号位置(cmap)は残る ── 実測で 40 種とも入っていることを確かめてある。
 * 🔑 だから描く側は `String.fromCodePoint` で 1 文字を置く(`symbols.ts`)。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SYMBOLS = 'src/features/icon/symbols.ts';
const OUT = 'src/styles/fonts/pkc-symbols.woff2';
/** ⚠ 焼いた中身の目録(test が読む ── woff2 は畳まれていて読めない)。 */
const LIST = 'src/styles/fonts/pkc-symbols.codepoints';
/** ⚠ 絵を出す規則。**字は器に入れない**ので、`::before` の `content` がここに要る。 */
const CSS_OUT = 'src/styles/icons.generated.css';
/** 焼く形。⚠ **`symbols.ts` の注記と揃える**(片方だけ変えると見た目が変わる)。 */
const AXES = 'opsz,wght,FILL,GRAD@24,500,0,0';
const CODEPOINTS =
  'https://raw.githubusercontent.com/google/material-design-icons/master/variablefont/MaterialSymbolsRounded%5BFILL%2CGRAD%2Copsz%2Cwght%5D.codepoints';

/**
 * ⚠ **表は `symbols.ts` から読む**(script に 2 つ目の一覧を持たない ── §7)。
 * 🔑 綴りは `icon: 'name', cp: 0x____` で固定してあるので、そこだけを拾う。
 */
export function tableOf() {
  const src = readFileSync(SYMBOLS, 'utf8');
  const rows = [...src.matchAll(/icon: '([a-z0-9_]+)', cp: 0x([0-9a-f]+)/g)].map((m) => ({
    icon: m[1],
    cp: parseInt(m[2], 16),
  }));
  if (rows.length === 0) throw new Error(`${SYMBOLS} から絵の名前を 1 つも読めなかった`);
  return rows;
}

async function get(url, asText) {
  const res = await fetch(url, {
    headers: {
      // ⚠ 素の User-Agent だと woff2 ではなく古い形式が返る(Google の出し分け)
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`取れなかった(${res.status}): ${url}`);
  return asText ? await res.text() : Buffer.from(await res.arrayBuffer());
}

/**
 * ⚠ **上流の表を取ってくる**(`get(CODEPOINTS, true)` を包んだだけ)。
 * 焼き(`runBake`)と検め(`runCheck`)の**両方**がここを通る ── 2 つ目の
 * 取得ロジックを作らない(§7「同じ値は 1 回だけ作って両方へ配る」)。
 *
 * @returns {Promise<Map<string, number>>}
 */
async function fetchUpstreamTable() {
  const cpText = await get(CODEPOINTS, true);
  return new Map(
    cpText
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => {
        const [name, hex] = l.split(' ');
        return [name, parseInt(hex, 16)];
      }),
  );
}

/**
 * `rows`(`PKC_SYMBOLS` の表)を上流の表と**集合で**突き合わせる(#849)。
 *
 * ⚠ **件数ではなく、1 件 1 件を照合する**(CLAUDE.md §8「入力を守る検査は
 * 集合で突き合わせる」)── `rows.length === upstream.size` のような数だけの
 * 比較だと、同じ数だけ取り違えても一致してしまう。
 *
 * 見るのは**両方向**:① 上流にその名前が無い(上流から消えた/こちらにしか無い)
 * ② 上流には在るが符号位置が違う(上流が動かした)。この 2 つで尽くせる ──
 * 「上流にだけ在る名前」(こちらが使っていない残り 4,000 種余り)は、
 * こちらが使っていない以上、比較する意味が無い。
 *
 * @param {{icon: string, cp: number}[]} rows
 * @param {Map<string, number>} upstream
 * @returns {string[]} 食い違いの説明(空 = 一致)
 */
export function diffAgainstUpstream(rows, upstream) {
  const offenders = [];
  for (const r of rows) {
    if (!upstream.has(r.icon)) {
      offenders.push(`${r.icon}: 上流にその名前が無い(消えた、またはこちらにしか無い)`);
    } else if (upstream.get(r.icon) !== r.cp) {
      offenders.push(
        `${r.icon}: 表は 0x${r.cp.toString(16)} だが、上流は 0x${upstream.get(r.icon).toString(16)}`,
      );
    }
  }
  return offenders;
}

/**
 * 🔴 **検めるだけ。焼かない・書かない**(#849、上のモジュール docstring を見よ)。
 *
 * ⚠ 上流が取れないとき(通信できない等)は **`✗`(赤)ではなく「測れなかった」と
 * 分かる形で終える** ── 落ちたのか測れなかったのかが読めないと、夜の赤が
 * 意味を失う(CLAUDE.md §4)。呼び出し側(`nightly.yml`)が exit code 2 を
 * 見て warning に変える。
 */
export async function runCheck() {
  const rows = tableOf();
  let upstream;
  try {
    upstream = await fetchUpstreamTable();
  } catch (e) {
    console.error(`✗ 測れなかった(上流を取得できない): ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  const offenders = diffAgainstUpstream(rows, upstream);
  if (offenders.length > 0) {
    for (const o of offenders) console.error(`✗ ${o}`);
    process.exit(1);
  }
  console.log(`✓ ${rows.length} 種、上流と一致(${CODEPOINTS})`);
}

/** 焼く(既定の動き。①〜⑤は上のモジュール docstring と対応)。 */
async function runBake() {
  const rows = tableOf();

  // ① 符号位置が合っているかを、上流の表で検める(ここが食い違うと豆腐になる)
  const upstream = await fetchUpstreamTable();
  const wrong = diffAgainstUpstream(rows, upstream);
  if (wrong.length > 0) {
    for (const w of wrong) console.error(`✗ ${w}`);
    process.exit(1);
  }

  // ② その絵だけの部分集合を落とす
  const names = rows.map((r) => r.icon).join(',');
  const css = await get(
    `https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:${AXES}&icon_names=${names}`,
    true,
  );
  const url = /url\((https:\/\/fonts\.gstatic\.com[^)]+)\)/.exec(css)?.[1];
  if (url === undefined) throw new Error('書体の URL が CSS に無い(出し分けが変わった?)');
  const woff2 = await get(url, false);

  // ③ 空振り防止 ── woff2 の印(`wOF2`)が在ることまで見てから置く
  if (woff2.subarray(0, 4).toString('latin1') !== 'wOF2')
    throw new Error(`woff2 ではない物が返った(先頭 4 バイト: ${woff2.subarray(0, 4).toString('hex')})`);
  writeFileSync(OUT, woff2);

  /**
   * ④ **要求した一覧を、読める形で隣に置く**(`.codepoints`)。
   *
   * 🔴 **これは「焼いた書体の中身」ではない**(2026-09-11 に訂正。着地前レビュー 1)。
   *
   * ⚠ かつてここには「⚠ 書き出すのは**要求した名前**ではなく**焼いた行そのもの**」と
   *   書いてあったが、**事実と逆だった** ── 下の `rows` は `symbols.ts` から読んだ
   *   **表そのもの**で、落としてきた woff2 は **1 バイトも読んでいない**。
   * ⚠ 実測(fontTools):この書体の cmap は **95 符号位置**在る(表は 40)──
   *   Google Fonts の部分集合は ASCII と、絵が内部で使う PUA を巻き込んで返す。
   * 🔴 だから **`.codepoints` と表を比べても、配る書体については何も言えない** ──
   *   「書体からだけ 1 つ消す」変異は、ここと生成 CSS が**両方 `rows` から書かれる**
   *   ので、unit を 1 件も落とさずに通る(= そのボタンだけ豆腐で出荷)。
   * 🔑 **書体そのものを見るのは実ブラウザだけ**(`tests/smoke/icon-font.smoke.spec.ts`)──
   *   この一覧の 40 件を**全部**測り、送り幅が 1em でなければ落ちる。
   * 🔑 ここが守れるのは 1 つだけ:**表に足したのに `npm run icons:font` を回し忘れた**
   *   (= この file が古いまま)。それも豆腐の原因なので、門としては残す。
   */
  writeFileSync(
    LIST,
    rows.map((r) => `${r.icon} ${r.cp.toString(16)}`).join('\n') + '\n',
  );
  /**
   * ⑤ 🔴 **絵を出す規則も、ここで作る**(2026-09-11)。
   *
   * ⚠ 器に字を入れると、**ボタン丸ごとの `textContent` に見えない 1 文字が混ざる**
   *   ── 直す前は `<svg>` で字を持たなかったので、読み手はそれに頼っていた
   *   (実測:全量 smoke が 5 本落ちた)。だから**絵は `::before` が出す**。
   * 🔑 符号位置を手で 2 か所に書かないため、**表から機械で作る**(§7)。
   *   ⚠ 名前(PKC 側)も要るので、`symbols.ts` の鍵ごと拾い直す。
   */
  const keys = [
    ...readFileSync(SYMBOLS, 'utf8').matchAll(/^ {2}'?([a-z0-9-]+)'?: \{ icon: '([a-z0-9_]+)', cp: 0x([0-9a-f]+) \}/gm),
  ].map((m) => ({ key: m[1], icon: m[2], cp: m[3] }));
  if (keys.length !== rows.length)
    throw new Error(`鍵を ${keys.length} 件しか拾えなかった(絵は ${rows.length} 件)`);
  writeFileSync(
    CSS_OUT,
    [
      '/* 🔴 **自動生成**(`npm run icons:font`)── 手で直さない。',
      ' * 絵の表は `src/features/icon/symbols.ts`、書体は `fonts/pkc-symbols.woff2`。',
      ' * ⚠ **器に字を入れない**ので、絵はここが出す(そうしないとボタンの `textContent` に',
      ' *   目に見えない 1 文字が混ざり、文言を読む側が静かに外れる)。 */',
      ...keys.map((k) => `[data-pkc-icon][data-pkc-symbol='${k.key}']::before {\n  content: '\\${k.cp}';\n}`),
      '',
    ].join('\n'),
  );
  console.log(`✓ ${OUT} ── ${rows.length} 種 / ${woff2.length} バイト`);
  console.log(`✓ ${CSS_OUT} ── ${keys.length} 規則`);
}

/**
 * ⚠ **CLI としての実行を、直接呼ばれたときだけに限る**(`scripts/nightly-red.mjs`
 * と同じ形)── これが無いと、この file を test から `import` した瞬間に
 * ①外の網へ実際に取りに行き ②`writeFileSync` で書体と CSS を書き換える
 * (= `diffAgainstUpstream` を unit で当てたいだけなのに、副作用が走る)。
 */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) await runCheck();
  else await runBake();
}
