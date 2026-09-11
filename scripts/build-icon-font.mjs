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
 * ## なぜ部分集合か
 *
 * | | 大きさ |
 * |---|---|
 * | 素の Material Symbols Rounded(4,284 種の可変書体) | **5.37 MB** |
 * | ここで焼く版(40 種・wght 500・FILL 0) | **約 6 KB** |
 *
 * ⚠ 配る量は棄却理由にならない(user 指示 2026-08-03)が、**常駐メモリは別**である
 * ── 40 種のために 5 MB を常駐させる理由が無い。
 *
 * ## ⚠ リガチャではなく符号位置で使う
 *
 * 部分集合にも符号位置(cmap)は残る ── 実測で 40 種とも入っていることを確かめてある。
 * 🔑 だから描く側は `String.fromCodePoint` で 1 文字を置く(`symbols.ts`)。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SYMBOLS = 'src/features/icon/symbols.ts';
const OUT = 'src/styles/fonts/pkc-symbols.woff2';
/** ⚠ 焼いた中身の目録(test が読む ── woff2 は畳まれていて読めない)。 */
const LIST = 'src/styles/fonts/pkc-symbols.codepoints';
/** 焼く形。⚠ **`symbols.ts` の注記と揃える**(片方だけ変えると見た目が変わる)。 */
const AXES = 'opsz,wght,FILL,GRAD@24,500,0,0';
const CODEPOINTS =
  'https://raw.githubusercontent.com/google/material-design-icons/master/variablefont/MaterialSymbolsRounded%5BFILL%2CGRAD%2Copsz%2Cwght%5D.codepoints';

/**
 * ⚠ **表は `symbols.ts` から読む**(script に 2 つ目の一覧を持たない ── §7)。
 * 🔑 綴りは `icon: 'name', cp: 0x____` で固定してあるので、そこだけを拾う。
 */
function tableOf() {
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

const rows = tableOf();

// ① 符号位置が合っているかを、上流の表で検める(ここが食い違うと豆腐になる)
const cpText = await get(CODEPOINTS, true);
const upstream = new Map(
  cpText
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const [name, hex] = l.split(' ');
      return [name, parseInt(hex, 16)];
    }),
);
const wrong = rows.filter((r) => upstream.get(r.icon) !== r.cp);
if (wrong.length > 0) {
  for (const r of wrong)
    console.error(
      `✗ ${r.icon}: 表は 0x${r.cp.toString(16)} だが、上流は ` +
        (upstream.has(r.icon) ? `0x${upstream.get(r.icon).toString(16)}` : '**その名前が無い**'),
    );
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
 * ④ 🔴 **焼いた中身を、読める形で隣に置く**(`.codepoints`)。
 *
 * ⚠ woff2 は brotli で畳まれているので、**test から中身を読めない** ── だから
 *   「この書体には何が入っているか」を**この script が知っている形**で書き出す。
 * 🔑 これで `tests/features/icon-symbols.test.ts` が
 *   「表に足したのに書体を焼き直していない」を落とせる ── **それが豆腐の原因である**。
 * ⚠ 書き出すのは**要求した名前**ではなく**焼いた行そのもの**(上で上流と突き合わせ済み)。
 */
writeFileSync(
  LIST,
  rows.map((r) => `${r.icon} ${r.cp.toString(16)}`).join('\n') + '\n',
);
console.log(`✓ ${OUT} ── ${rows.length} 種 / ${woff2.length} バイト`);
