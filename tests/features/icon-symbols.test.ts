/**
 * 🔴 **図案の書体**(#770 段①、2026-09-11 → **#1054 段①、2026-09-25 に
 * Phosphor Duotone へ**)。
 *
 * ⚠ ここで守るのは 1 つだけ ── **豆腐(□)を出さない**。
 *   user の要望はそのものである:「**内部的にはリガチャで表示できないってことが
 *   ないようにしたい**」。
 *
 * 🔴 **この file が見られるのは「注文書」までである**(#770 の着地前レビュー 1 で
 * 訂正。#1054 段①でも変わらない)。
 *
 * ⚠ `pkc-symbols.codepoints` は **焼いた書体を読んで書いた物ではない** ──
 *   `scripts/build-icon-font.mjs` が `symbols.ts` の並び順から**機械的に**
 *   0xE000 起点で 2 個ずつ(下地・線)割り当てて書いている(woff2 は brotli で
 *   畳まれていて node から読めないため)。
 * 🔴 だから **「書体からだけ 1 つ消える」は、この file では原理的に捕まえられない**。
 *   捕まえるのは実ブラウザの `tests/smoke/icon-font.smoke.spec.ts` で、
 *   **目録の全数を全部測る**(送り幅が 1em でなければ豆腐)。
 *
 * 🔑 ここが守る 4 つ(全部「注文が揃っているか」である):
 *   ① 表(`symbols.ts`)に在る名前は、注文した目録(`.codepoints`)にも在る
 *   ② 目録と、生成 CSS(`icons.generated.css`)の符号位置が食い違わない
 *   ③ CSS が**枠に書体を当てている**(既定の書体には私用領域の絵が無い)
 *   ④ 表の `tone` に対応する `--pkc-tone-*` が `tokens.css` に実在する
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { ICON_NAMES, PKC_SYMBOLS, isIconName } from '../../src/features/icon/symbols';
import { blocksFor, stripComments, withoutMedia } from '../helpers/css-blocks';

const FONT = 'src/styles/fonts/pkc-symbols.woff2';
const LIST = 'src/styles/fonts/pkc-symbols.codepoints';
const TOKENS = 'src/styles/tokens.css';

/**
 * 焼いた書体の目録(`npm run icons:font` が書く)。
 * ⚠ **1 行に符号位置が 2 つ**(下地・線)── Duotone は絵ごとに符号位置が 2 つ要る。
 */
function baked(): Map<string, { underlay: number; line: number }> {
  return new Map(
    readFileSync(LIST, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => {
        const [name, u, ln] = l.split(' ');
        return [name!, { underlay: parseInt(u!, 16), line: parseInt(ln!, 16) }] as const;
      }),
  );
}

describe('図案の書体(#1054 段①)', () => {
  it('🔴 表に在る絵は、注文した目録にも在る(足して焼き忘れると豆腐になる)', () => {
    const inFont = baked();
    // ⚠ 空振り防止 ── 目録が空なら下の for は 1 度も回らない
    expect(inFont.size, '焼いた書体の目録が空(前提が崩れている)').toBeGreaterThan(10);
    expect(ICON_NAMES.length, '図案の表が空(前提が崩れている)').toBeGreaterThan(10);
    for (const name of ICON_NAMES) {
      expect(inFont.has(name), `${name} が目録に無い ── npm run icons:font を回す`).toBe(true);
    }
  });

  it('🔴 注文した目録に、表から消えた名前が残っていない(消して回し忘れを捕まえる)', () => {
    const want = new Set<string>(ICON_NAMES);
    for (const name of baked().keys())
      expect(want.has(name), `${name} は表に無いのに注文されている ── npm run icons:font を回す`).toBe(
        true,
      );
  });

  it('🔴 別の図案が同じ符号位置を指していない(取り違えが静かに通る)', () => {
    const seen = new Map<number, string>();
    for (const [name, { underlay, line }] of baked()) {
      for (const cp of [underlay, line]) {
        const first = seen.get(cp);
        expect(first, `${name} と ${first ?? ''} が同じ符号位置になっている`).toBeUndefined();
        seen.set(cp, name);
      }
    }
  });

  /**
   * ⚠ **私用領域であることを見る** ── 素の書体に在る字(`A` など)を割り当てると、
   *   書体が当たらなくても**それらしく出てしまう**ので、壊れたことに気づけない。
   * 🔑 **目録から見る**(`PKC_SYMBOLS` はもう符号位置を持たない ── §7「二重表現に
   *   しない」。焼く側の `scripts/build-icon-font.mjs` が唯一の割り当て元である)。
   */
  it('🔴 符号位置は私用領域(書体が無ければ豆腐になる = 気づける)', () => {
    const rows = baked();
    // ⚠ 空振り防止
    expect(rows.size, '目録が空(前提が崩れている)').toBeGreaterThan(10);
    for (const [name, { underlay, line }] of rows) {
      for (const [label, cp] of [
        ['下地', underlay],
        ['線', line],
      ] as const) {
        expect(cp, `${name} の${label}が私用領域の外`).toBeGreaterThanOrEqual(0xe000);
        expect(cp, `${name} の${label}が私用領域の外`).toBeLessThanOrEqual(0xf8ff);
      }
    }
  });

  it('🔴 書体を同梱している(外から取りに行かない)', () => {
    const size = statSync(FONT).size;
    // ⚠ 下限も置く ── 0 バイトの file を置いても「在る」は真になる
    expect(size, '書体が小さすぎる(焼き損ない)').toBeGreaterThan(2000);
    // ⚠ 上限も置く ── 素の Phosphor Duotone 一式(1,512 種の丸ごと)を
    //   丸ごと置いてしまう手違いを止める(実測:一式は 164KB、部分集合は 1 割強)
    expect(size, '書体が大きすぎる(部分集合になっていない)').toBeLessThan(200_000);
    /**
     * 🔴 **注釈を落としてから、`@font-face` の塊だけを見る**(2026-09-11。変異 MC が
     *   SURVIVED で教えた)。⚠ 1 稿目は **file 全体**を見ていたので、`block` を `swap` へ
     *   変えても**すぐ上に書いた自分の解説コメント**が条件を満たして緑だった
     *   (CLAUDE.md §1「範囲が広すぎて無関係な散文に満たされる」の 6 度目)。
     */
    const css = readFileSync('src/styles/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const face = /@font-face\s*\{([^}]*'PKC Symbols'[^}]*)\}/.exec(css)?.[1] ?? '';
    expect(face, '書体の宣言が読めていない(空振り)').not.toBe('');
    expect(face, 'CSS が書体を読み込んでいない').toContain("url('./fonts/pkc-symbols.woff2')");
    expect(face, '外から取りに行く形になっている').not.toContain('fonts.gstatic.com');
    expect(face, '外から取りに行く形になっている').not.toContain('fonts.googleapis.com');
    // 🔑 届くまで**字を出さない**(`swap` だと私用領域の豆腐が一瞬出る)
    expect(face, 'font-display が block でない').toMatch(/font-display:\s*block/);
  });

  /**
   * 🔴 **構文で拾う**(2026-09-11、着地前レビュー 3。継承)。
   *
   * ⚠ 1 稿目は `/\[data-pkc-icon\]\s*\{([^}]*)\}/` で**注釈も剥がずに**拾っていた。
   *   罠は 2 つ重なっていた:
   *   ① **注釈に満たされる** ── 規則から `font-family` を消しても、すぐ上の
   *      「🔴 **書体で描く** … ここを外すと**豆腐**になる」が条件を満たす
   *   ② 🔴 **子孫選択子に当たる** ── `[data-pkc-region='browse-tabs'] [data-pkc-icon]`
   *      も同じ形なので、**そちらへ書き足せば素の規則を空にしても緑**になる
   *      (実測:`app.css` にその形の規則が複数在る)。
   * 🔑 だから `tests/helpers/css-blocks.ts` で読む ── 選択子リストを `,` で割って
   *   **丸ごと一致**を見るので、子孫選択子は拾わない。
   */
  it('🔴 図案の枠に書体が当たっている(当たっていないと全部豆腐)', () => {
    const css = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf8')));
    const blocks = blocksFor(css, '[data-pkc-icon]');
    // ⚠ 空振り防止 ── 素の `[data-pkc-icon]` の規則が 1 本も取れていない形で
    //   「当たっている」と言わない
    expect(blocks.length, '図案の枠の規則が読めていない(空振り)').toBe(1);
    expect(blocks[0], '枠に書体が当たっていない').toContain("font-family: 'PKC Symbols'");
  });

  /**
   * 🔴 **duotone の重ね描きの機構が居る**(#1054 段①)。⚠ `[data-pkc-icon]::before` /
   *   `::after` は `app.css` の**手書きの**規則(生成物ではない ── 絵ごとに違うのは
   *   `content` だけで、それは `icons.generated.css` が持つ。CLAUDE.md §7「同じ値は
   *   1 か所」の逆:**違う値だけを分ける**)。
   */
  it('🔴 下地・線の共通の見た目(色・不透明度・重ね方)が app.css に居る', () => {
    const css = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf8')));
    const before = blocksFor(css, '[data-pkc-icon]::before');
    const after = blocksFor(css, '[data-pkc-icon]::after');
    expect(before.length, '下地の共通規則が読めていない(空振り)').toBe(1);
    expect(after.length, '線の共通規則が読めていない(空振り)').toBe(1);
    expect(before[0], '下地が tone を読んでいない').toContain('--pkc-icon-underlay');
    expect(after[0], '線が currentColor を継いでいない').toContain('currentColor');
    expect(after[0], '線が下地に重なっていない(margin-left: -1em が無い)').toContain(
      'margin-left: -1em',
    );
  });

  /**
   * 🔴 **`tone` は `IconTone` の値そのもの、かつ tokens.css に実在する**
   * (#1054 段①)。⚠ ここが壊れると、`var(--pkc-tone-XXX)` が**存在しない変数**を
   *   指し、下地が**常に無色**になる(壊れても test 以外どこも鳴らない ── CSS の
   *   未定義 var は既定でだんまりで初期値へ落ちるため)。
   */
  it('🔴 表の全 tone が tokens.css に定義されている', () => {
    const tokens = readFileSync(TOKENS, 'utf8');
    const tones = new Set(Object.values(PKC_SYMBOLS).map((v) => v.tone));
    // ⚠ 空振り防止
    expect(tones.size, 'tone が 1 種類も無い(前提が崩れている)').toBeGreaterThan(3);
    for (const tone of tones) {
      expect(tokens, `--pkc-tone-${tone} が tokens.css に無い`).toContain(`--pkc-tone-${tone}:`);
    }
  });

  /** 🔑 task 要求「every IconName has a tone and both code points」。 */
  it('🔴 図案名は 1 つ残らず tone を持ち、目録に下地・線の両方を持つ', () => {
    const rows = baked();
    expect(ICON_NAMES.length, '前提が崩れている(表が空)').toBeGreaterThan(10);
    for (const name of ICON_NAMES) {
      const entry = PKC_SYMBOLS[name];
      expect(typeof entry.tone, `${name} が tone を持たない`).toBe('string');
      expect(entry.tone.length, `${name} の tone が空`).toBeGreaterThan(0);
      const cps = rows.get(name);
      expect(cps, `${name} が目録に無い`).toBeDefined();
      expect(cps!.underlay, `${name} の下地の符号位置が無い`).toBeGreaterThan(0);
      expect(cps!.line, `${name} の線の符号位置が無い`).toBeGreaterThan(0);
      expect(cps!.underlay, `${name} の下地と線が同じ符号位置`).not.toBe(cps!.line);
    }
  });
});

/**
 * 🔴 **新ゲート M4・M6**(#1054 段①-2、2026-09-25)── 変異試験で SURVIVED だった 2 つ。
 *
 * - M4: `tone` を落とす / 許された集合の外の値にする変異。⚠ `PKC_SYMBOLS` は
 *   `satisfies Readonly<Record<string, { tone: IconTone }>>` で**型としては**
 *   守られているが、変異試験は file の**文字列**を書き換えて `vitest` を
 *   そのまま回すことがあり(esbuild は型を検めない)、実行時の網も要る。
 * - M6: `isIconName` が**表に無い名前**を弾くか。
 */
describe('新ゲート(M4・M6)', () => {
  /** ⚠ `IconTone`(型)と**同じ集合を実行時にも持つ** ── 型だけでは変異試験で見えない。 */
  const ALLOWED_TONES = ['create', 'capture', 'io', 'find', 'system', 'danger', 'kind', 'neutral'];

  it('🔴 M4:図案は 1 つ残らず、tone が許された集合の中にある', () => {
    expect(ICON_NAMES.length, '前提が崩れている(表が空)').toBeGreaterThan(10);
    for (const name of ICON_NAMES) {
      const tone: unknown = PKC_SYMBOLS[name].tone;
      expect(
        ALLOWED_TONES.includes(tone as string),
        `${name} の tone(${String(tone)})が許された集合の外 ── tone を落とした/typo した変異を捕まえる`,
      ).toBe(true);
    }
  });

  it('🔴 M6:isIconName は表に無い名前を弾く', () => {
    for (const bogus of ['', 'settin', 'nope']) {
      expect(isIconName(bogus), `isIconName('${bogus}') が true を返した`).toBe(false);
    }
    // ⚠ 対照群 ── 弾く側だけ見ると「常に false を返す」変異を見逃す
    expect(isIconName('settings'), '実在する名前まで弾いている(対照群が崩れている)').toBe(true);
  });
});

/**
 * 🔴 **新ゲート M7**(#1054 段①-2)── tone 色が透明になる変異(不透明度 0 /
 * `transparent` / アルファ付き色)を、`tokens.css` のテキストから検める。
 * ⚠ 実ブラウザでの検め(computed style の alpha)は
 * `tests/smoke/icon-font.smoke.spec.ts` の M7 を見よ ── ここは**静的**な網。
 */
describe('新ゲート(M7・tone は不透明)', () => {
  const TOKENS_SRC = readFileSync('src/styles/tokens.css', 'utf8');

  it('🔴 全 --pkc-tone-* が「透明になりうる書き方」を含まない', () => {
    const rows = [
      ...TOKENS_SRC.matchAll(/--pkc-tone-([a-z]+):\s*([^;]+);/g),
    ].map((m) => ({ tone: m[1] as string, value: (m[2] as string).trim() }));
    // ⚠ 空振り防止
    expect(rows.length, '--pkc-tone-* を 1 つも拾えていない(前提が崩れている)').toBeGreaterThan(3);
    for (const { tone, value } of rows) {
      expect(value, `--pkc-tone-${tone} が transparent`).not.toContain('transparent');
      // rgba(...)/hsla(...) 系で最後の引数(alpha)が 1 未満なのを弾く
      const alphaFn = /(?:rgba|hsla)\([^)]*,\s*([0-9.]+)\s*\)/.exec(value);
      if (alphaFn !== null) {
        expect(Number(alphaFn[1]), `--pkc-tone-${tone} の alpha が 1 未満: ${value}`).toBe(1);
      }
      // #rrggbbaa(8 桁 hex)を弾く
      const hex8 = /#[0-9a-fA-F]{8}\b/.exec(value);
      expect(hex8, `--pkc-tone-${tone} が 8 桁 hex(アルファ付き): ${value}`).toBeNull();
    }
  });
});

/**
 * 🔴 **絵を出しているのは CSS である**(2026-09-11。全量 smoke が 5 件落ちて、こう直した)。
 *
 * ⚠ 器(`[data-pkc-icon]`)に字を入れると、**ボタン丸ごとの `textContent` に
 *   目に見えない 1 文字が混ざる** ── 文言を読む側が静かに外れる
 *   (CLAUDE.md §10「器を替えても、読み取れる値を変えない」)。
 * 🔑 だから絵は `::before` / `::after` の `content` が出す。⚠ ここで**符号位置が
 *   3 か所目**に出てくるので(目録 / 生成 CSS / 実ブラウザの smoke)、
 *   CLAUDE.md §7 のとおり突き合わせる。
 *   ⚠ **両方向**で見る ── 「規則が無い絵」は豆腐、「表に無い規則」は
 *   `npm run icons:font` を回し忘れた側の腐りである。
 */
describe('図案の規則(自動生成の CSS)', () => {
  const GEN = 'src/styles/icons.generated.css';

  /**
   * `data-pkc-symbol='X'` ごとに `{ underlay, line }` を読む。
   *
   * 🔴 **もう tone を持たない**(#1054 段①-2、2026-09-25)── 直す前はここに
   *   `--pkc-icon-underlay: var(--pkc-tone-…)` の 3 つ目の規則が在ったが、
   *   tone は絵ごとではなく **action ごと**(`icons.ts` の `ACTION_TONES`)に
   *   決まるようになったので、生成 CSS からは落とした(固定 7 本の tone 規則は
   *   `app.css` の `[data-pkc-icon][data-pkc-tone='…']` が持つ)。
   */
  function rules(): Map<string, { underlay: number; line: number }> {
    const css = readFileSync(GEN, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const before = new Map<string, number>();
    for (const m of css.matchAll(
      /\[data-pkc-icon\]\[data-pkc-symbol='([a-z0-9-]+)'\]::before\s*\{\s*content:\s*'\\([0-9a-f]+)';\s*\}/g,
    )) {
      before.set(m[1] as string, parseInt(m[2] as string, 16));
    }
    const after = new Map<string, number>();
    for (const m of css.matchAll(
      /\[data-pkc-icon\]\[data-pkc-symbol='([a-z0-9-]+)'\]::after\s*\{\s*content:\s*'\\([0-9a-f]+)';\s*\}/g,
    )) {
      after.set(m[1] as string, parseInt(m[2] as string, 16));
    }
    const out = new Map<string, { underlay: number; line: number }>();
    for (const [name, u] of before) {
      const l = after.get(name);
      if (l !== undefined) out.set(name, { underlay: u, line: l });
    }
    return out;
  }

  it('🔴 表に在る絵は、全部 CSS の規則(下地 / 線)を持つ(無い絵は何も描かれない)', () => {
    const got = rules();
    // ⚠ 空振り防止 ── 綴りが変わって 1 件も拾えていないと、下の for が回らない
    expect(got.size, '規則を 1 つも拾えていない(生成の形が変わった)').toBeGreaterThan(10);
    const baked_ = baked();
    for (const name of ICON_NAMES) {
      const row = got.get(name);
      expect(row, `${name} の規則が無い ── npm run icons:font を回す`).toBeDefined();
      const want = baked_.get(name);
      expect(row!.underlay, `${name} の下地の符号位置が目録と食い違う`).toBe(want?.underlay);
      expect(row!.line, `${name} の線の符号位置が目録と食い違う`).toBe(want?.line);
    }
  });

  it('🔴 表から消えた絵の規則が残っていない(死んだ規則を溜めない)', () => {
    const want = new Set<string>(ICON_NAMES);
    for (const name of rules().keys())
      expect(want.has(name), `${name} は表に無いのに規則が在る ── npm run icons:font を回す`).toBe(
        true,
      );
  });

  it('🔴 その CSS が配られている(読み込まれなければ全部 空の器)', () => {
    const css = readFileSync('src/styles/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css, 'app.css が図案の規則を読み込んでいない').toContain(
      "@import './icons.generated.css';",
    );
  });

  /**
   * 🔴 **M2 の unit 側**(#1054 段①-2 の新ゲート)── 「下地(`::before`)が
   *   丸ごと消える」変異を、生成 CSS の側だけで検める。⚠ 実ブラウザ側
   *   (`content` が実際に 1 文字を描くか・色が付くか)は
   *   `tests/smoke/icon-font.smoke.spec.ts` が見る ── ここは**構造**だけ:
   *   全絵が `::before` と `::after` を**両方**・**空でない `content`** で持つ。
   */
  it('🔴 M2:下地(::before)を消す変異は、規則が消えることで捕まる', () => {
    const got = rules();
    expect(got.size, '前提が崩れている(0 件)').toBeGreaterThan(10);
    for (const name of ICON_NAMES) {
      const row = got.get(name);
      expect(row, `${name} の規則が無い`).toBeDefined();
      // ⚠ 符号位置 0(content: '\0')は「無い」と区別が付かないので下限に置く
      expect(row!.underlay, `${name} の下地の符号位置が空(0)`).toBeGreaterThan(0);
      expect(row!.line, `${name} の線の符号位置が空(0)`).toBeGreaterThan(0);
    }
  });
});

/**
 * 🔴 **`rename` / `note-plus` の絵を差し替えた**(#1054 段②-2、着地前レビュー)。
 *
 * ① `rename`(2 ペインの「名前」)── `cursor-text`(文字入力。色を持たない
 *   唯一のタイルだった)から `pencil-simple-line` + `tone: 'create'` へ
 *   (「ノートを編集する」= `pencil`/`create` と同じ色の系統に揃える)。
 * ② `note-plus`(2 ペインの「ノート」= `dual-mknote`)── `note-pencil`
 *   (ノート + 鉛筆 = 「編集」と読める絵。①を鉛筆系にすると隣に鉛筆が 2 本並ぶ)
 *   から `file-plus` へ(`folder-plus`(フォルダを作る)と対になる絵)。
 * ⚠ **符号位置(codepoints)は変えない** ── `symbols.ts` の並び順(= key の数と
 *   順番)を変えていないので、`npm run icons:font` は同じ符号位置に**別の
 *   Phosphor 絵を焼き直す**だけである(この test は焼き直したことまでは
 *   見ない ── それは実ブラウザの `tests/smoke/icon-font.smoke.spec.ts` の担当)。
 */
describe('rename / note-plus の絵と tone(#1054 段②-2)', () => {
  it('🔴 rename は pencil-simple-line + create', () => {
    expect(PKC_SYMBOLS.rename).toEqual({ icon: 'pencil-simple-line', tone: 'create' });
  });

  it('🔴 note-plus は file-plus(tone は create のまま)', () => {
    expect(PKC_SYMBOLS['note-plus']).toEqual({ icon: 'file-plus', tone: 'create' });
  });

  // 🔑 空振り防止 ── 消した絵(cursor-text / note-pencil)が、他の PKC 名から
  //   まだ指されていないこと(指されていたら「消した」にならない)
  it('⚠ cursor-text / note-pencil は、もうどの PKC 名からも指されていない', () => {
    const icons = Object.values(PKC_SYMBOLS).map((v) => v.icon);
    expect(icons).not.toContain('cursor-text');
    expect(icons).not.toContain('note-pencil');
  });
});
