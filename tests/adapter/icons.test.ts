/** @vitest-environment happy-dom */
/**
 * 図案の**配線**(P9 段③ → **#770 段① で書体にした**)。
 *
 * 🔴 経緯:絵文字 → 単色 SVG(2026-08-03 の 2 件に同時に反していたため)→
 *   **Material Symbols の部分集合**(user 要望 2026-09-07)。
 *
 * ⚠ **書体そのもの**(豆腐を出さない)は `tests/features/icon-symbols.test.ts` が見る。
 *   ここで見るのは**画面に出るまでの配線**である:
 *   読み上げに出さない / 表が 1 つに寄っている / 差し替えで空にならない。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import {
  ACTION_ICONS,
  ARCHETYPE_ICONS,
  BROWSE_ICONS,
  iconButton,
  iconSpan,
  setIcon,
} from '../../src/adapter/ui/render/icons';
import { PKC_SYMBOLS } from '../../src/features/icon/symbols';
import { blocksFor, stripComments, withoutMedia } from '../helpers/css-blocks';
import { SidebarRenderer } from '../../src/adapter/ui/render/sidebar';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import type { AppState } from '../../src/adapter/state/app-state';

const ALL_NAMES = [
  ...new Set([
    ...Object.values(ACTION_ICONS),
    ...Object.values(ARCHETYPE_ICONS),
    ...Object.values(BROWSE_ICONS),
  ]),
];

describe('図案は書体の 1 文字である(#770 段①)', () => {
  /**
   * 🔴 **器は名前だけ持ち、絵は CSS が出す**(2026-09-11。全量 smoke が 5 件落ちて確定)。
   *
   * ⚠ 1 稿目は `span.textContent` に符号位置の 1 文字を入れていた ── 動きはするが、
   *   **ボタン丸ごとの `textContent` に目に見えない 1 文字が混ざる**(下の pin を見よ)。
   * 🔑 いま器に在るのは `data-pkc-symbol` だけで、絵は
   *   `src/styles/icons.generated.css` の `::before { content }` が出す。
   * ⚠ **happy-dom は `::before` を計算しない**ので、ここで見られるのは
   *   「名前が付いていること」まで ── 名前 → 符号位置 → 書体の鎖は
   *   `tests/features/icon-symbols.test.ts` が、実際に描けることは
   *   `tests/smoke/icon-font.smoke.spec.ts` が見る。
   */
  it('🔴 表に在る図案が、全部 名前つきの空の器になる', () => {
    expect(ALL_NAMES.length, '図案の表が空(前提が崩れている)').toBeGreaterThan(10);
    for (const name of ALL_NAMES) {
      const span = iconSpan(name);
      // ⚠ **どの絵か**は名前で言う(符号位置は目で読めない)
      expect(span.getAttribute('data-pkc-symbol'), `${name} の名前が器に無い`).toBe(name);
      // 🔴 器に字を入れない ── ここが崩れると、文言を読む側が静かに外れる
      expect(span.textContent ?? '', `${name} の器に字が入っている`).toBe('');
      // ⚠ 空振り防止 ── 表にその名前が実在すること(名前を打ち間違えたら鳴る)
      expect(PKC_SYMBOLS[name], `${name} が図案の表に無い`).toBeDefined();
    }
  });

  it('🔴 器に色も大きさも書いていない(値は CSS が決める)', () => {
    for (const name of ALL_NAMES) {
      const span = iconSpan(name);
      for (const attr of ['style', 'color', 'class'])
        expect(span.getAttribute(attr), `${name} の器が ${attr} を持っている`).toBeNull();
    }
  });

  /**
   * 🔴 **図案の大きさを器の字に載せない**(#770 段①)。
   * ⚠ 帯のボタンは 12px なので、`em` で載せると枠の字が 12.6px(12 × 1.05)、
   *   **描く絵は 14.5px**(さらに 1.15em)まで縮む ── Material は 20px 前提の
   *   設計なので、そこまで縮むと潰れる。
   */
  it('🔴 図案の大きさが px で固定されている(帯の 12px に引きずられない)', () => {
    // 🔑 **構文で拾う**(注釈に満たされない / 子孫選択子に当たらない)──
    //    理由は `tests/features/icon-symbols.test.ts` の同じ形の検査に書いた
    const css = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));
    const blocks = blocksFor(css, '[data-pkc-icon]');
    expect(blocks.length, '図案の枠の規則が読めていない(空振り)').toBe(1);
    expect(blocks[0], '大きさが器の字に載っている(帯で潰れる)').toMatch(/font-size:\s*\d+px/);
  });

  it('🔴 危険な操作と種別に色が付いている(意味を持つ色は使う)', () => {
    const css = readFileSync('src/styles/app.css', 'utf-8');
    // 消える操作は先に分かるべき情報である
    expect(css).toMatch(/\[data-pkc-action='delete-entry'\][^{]*\{[^}]*--danger/s);
    // 種別は「何のノートか」= 情報。⚠ 図案を持つ種別すべてに色がある
    for (const archetype of Object.keys(ARCHETYPE_ICONS))
      expect(css, `種別 ${archetype} のチップに色が無い`).toContain(
        `[data-pkc-chip='${archetype}']`,
      );
    // ⚠ 選択中の行では行の色に戻す(選択は種別より上位の情報)
    expect(css).toContain('[data-pkc-selected] [data-pkc-chip]');
  });

  it('🔴 読み上げに出さない(意味は隣の文字が持つ)', () => {
    const span = iconSpan('page');
    expect(span.getAttribute('data-pkc-icon')).toBe('');
    // ⚠ `::before` の字も読み上げに拾われる ── これが無いと私用領域の 1 文字を読もうとする
    expect(span.getAttribute('aria-hidden')).toBe('true');
    // 器は **span**(大きさを決める CSS がそこに当たっている)
    expect(span.tagName.toLowerCase()).toBe('span');
  });

  it('🔴 図案つきボタンは 図案 + 文字 の 2 つで組む(文言は第 2 引数)', () => {
    const btn = iconButton('delete-entry', '削除');
    expect(btn.getAttribute('data-pkc-action')).toBe('delete-entry');
    expect(
      btn.querySelector('[data-pkc-icon]')?.getAttribute('data-pkc-symbol') ?? '',
      '図案の名前が無い(ACTION_ICONS の鍵がずれている)',
    ).toBe('trash');
    expect(btn.querySelector('[data-pkc-field="label"]')?.textContent).toBe('削除');
    // ⚠ 図案の無い action は**器ごと出さない**(空の枠を置かない)
    const plain = iconButton('append-entry', '追記');
    expect(plain.querySelector('[data-pkc-icon]')).toBeNull();
    expect(plain.querySelector('[data-pkc-field="label"]')?.textContent).toBe('追記');
  });

  /**
   * 🔴 **ボタン丸ごとの `textContent` は、文言そのもの**(#770 段①、2026-09-11)。
   *
   * ⚠ ここは**実害から生まれた pin** である。1 稿目は図案を器の字として入れたので、
   *   `button.textContent` が「**目に見えない 1 文字** + 文言」になった ──
   *   `toHaveText` で文言を比べる smoke が **4 本**、種別の一覧が **1 本**落ちた
   *   (見た目は 1 ドットも違わないので、落ちた字面を並べても違いが読めない)。
   * 🔑 直したのは test ではなく**器**である:絵は CSS の `::before` が出すので、
   *   読み手が読む値は SVG だった頃と**同じ形**に戻った。
   * ⚠ この検査が落ちたら、直すのは**この test ではなく `setIcon`** である
   *   (CLAUDE.md §10「器を替えても、読み取れる値を変えない」)。
   */
  it('🔴 ボタン丸ごとの字は文言そのもの(器に図案の字を入れない)', () => {
    const btn = iconButton('delete-entry', '削除');
    const label = btn.querySelector('[data-pkc-field="label"]')?.textContent ?? '';
    expect(label, '文言の欄が読めない').toBe('削除');
    // ⚠ 空振り防止 ── 図案の器は**在る**(器ごと消えて「字が同じ」になっていない)
    expect(btn.querySelector('[data-pkc-icon]'), '図案の器が無い(空振り)').not.toBeNull();
    // 🔴 **等値**で見る ── 「含む」だと、字が 1 つ混ざっても静かに通る
    expect(btn.textContent ?? '', 'ボタンの字に図案が混ざっている').toBe(label);
  });

  it('🔴 差し替えると名前が入れ替わる(古い絵が残らない)', () => {
    const span = iconSpan('page');
    setIcon(span, 'folder');
    expect(span.getAttribute('data-pkc-symbol'), '差し替えで絵が変わっていない').toBe('folder');
    // ⚠ 差し替えでも器の字は空のまま(ここで字を入れると上の pin が崩れる)
    expect(span.textContent ?? '', '差し替えで器に字が入った').toBe('');
    // 🔑 2 つの名前が**別の絵**を指していること ── 同じなら上の assert は何も守らない
    expect(PKC_SYMBOLS['folder'].cp, 'page と folder が同じ絵(前提が崩れている)').not.toBe(
      PKC_SYMBOLS['page'].cp,
    );
  });
});

describe('一覧のチップ ── 行を作り直さずに種別が変わっても消えない', () => {
  function meta(lid: string, archetype: string): EntryMeta {
    return {
      lid,
      title: 't-' + lid,
      archetype,
      createdAt: null,
      updatedAt: null,
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
      bodyChars: null,
    };
  }
  const stateWith = (m: EntryMeta): AppState =>
    reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [m], relations: [] }).state;

  it('🔴 種別だけ変えた patch 経路でチップが空にならない', () => {
    const root = document.createElement('div');
    const regions = buildShell(root);
    const sidebar = new SidebarRenderer(regions.sidebar);

    sidebar.render(stateWith(meta('a', 'text')));
    const chip = root.querySelector('[data-pkc-chip]');
    expect(chip, 'チップが出ていない').not.toBeNull();
    expect(chip!.getAttribute('data-pkc-symbol') ?? '', '初回描画でチップに絵が無い').toBe('page');

    /**
     * 🔴 **行は作り直さない**(同じ lid なので patch 経路に入る)。
     * ⚠ 中身が `<svg>` 要素だった頃は `chip.textContent = …` が **svg ごと消して
     *   空にした**。いまは絵が CSS 側なので消えようが無いが、
     *   **印(`data-pkc-chip`)と名前(`data-pkc-symbol`)が揃って動くこと**は変わらず見る
     *   ── 片方だけ直すと、行の色は folder なのに絵は text のまま、が静かに出る。
     */
    sidebar.render(stateWith(meta('a', 'folder')));
    const after = root.querySelector('[data-pkc-chip]');
    expect(after!.getAttribute('data-pkc-chip'), '種別の印が変わっていない').toBe('folder');
    expect(after!.getAttribute('data-pkc-symbol'), 'patch で絵が古いまま').toBe('folder');
  });

  it('🔴 未知の種別でもチップが空にならない(行の頭が揃う)', () => {
    const root = document.createElement('div');
    const regions = buildShell(root);
    const sidebar = new SidebarRenderer(regions.sidebar);
    sidebar.render(stateWith(meta('a', 'なにか未知')));
    // ⚠ 未知は `dot`(表に無い種別で器ごと消えると、行の頭が 1 件だけ揃わない)
    expect(
      root.querySelector('[data-pkc-chip]')?.getAttribute('data-pkc-symbol') ?? '',
      '未知の種別でチップに絵が無い',
    ).toBe('dot');
  });
});

/** src 配下の TS を全部集める。 */
function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * 🔴 **登記だけ在って誰も呼ばない図案を溜めない**(#712 (b))。
 *
 * `icons.ts` は自分で「⚠ **生きている鍵だけ置く**。前の版は 22 件のうち **9 件が
 * 死んでいた** … 死んだ表は『在るのに効かない』ので、次に触る人を惑わせる」と
 * 書いているが、**それを守る test が無かった** ── 実際 `set-view:dual` が
 * 死んだまま残っていた(2 ペインは上の帯ではなく**アプリのタイル**から開くので、
 * この鍵を引く者はどこにも居ない)。
 *
 * ⚠ **消してよいのは「誰も呼ばないから」ではなく「呼ばれる道が無いから」である。**
 *   畳んであるだけの図案(封印中の `todo` の枠)は**残す** ── 解くときに要る
 *   (`features/sealed.ts`「消すのではなく畳む」)。だから下は**等値 pin**にして、
 *   増えたら落ちる形にしてある。
 */
describe('図案の登記に死んだ行を残さない', () => {
  it('🔴 `set-view:*` の鍵は、シェルが実際に描く面と等値', () => {
    const root = document.createElement('div');
    buildShell(root);
    const drawn = [...root.querySelectorAll('[data-pkc-action="set-view"]')]
      .map((el) => el.getAttribute('data-pkc-view') ?? '')
      .sort();
    // ⚠ 空振り防止 ── 1 つも描けていないと「等値」が 0 対 0 で成立する
    expect(drawn.length, '面の切替ボタンが 1 つも描かれていない(前提が崩れている)').toBeGreaterThanOrEqual(3);

    const registered = Object.keys(ACTION_ICONS)
      .filter((k) => k.startsWith('set-view:'))
      .map((k) => k.slice('set-view:'.length))
      .sort();
    // 🔑 **等値**で見る ── 片側だけだと「余った鍵」か「図案の無いボタン」の
    //   どちらかを見逃す(2026-09-05 に余っていたのは前者)
    expect(registered, '`set-view:*` の登記と、実際に描かれる面が食い違っている').toEqual(drawn);
  });

  it('🔴 どの表からも指されない図案は、畳んであると名指しした物だけ', () => {
    /**
     * ⚠ **畳んである図案**(呼ぶ道はいま無いが、消すと戻せなくなる物)。
     *   `box` = 封印中の `todo` の「未完了」の枠。対になる `check-box` は
     *   `ARCHETYPE_ICONS.todo` が使っており、**状態を切り替える押し口が
     *   2026-08-19 に無くなった**(`sealed.ts`)ぶんだけ、こちらが浮いている。
     */
    const FOLDED = ['box'];

    const src = readFileSync('src/features/icon/symbols.ts', 'utf-8');
    const bare = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const between = (text: string, from: string, to: string): string => {
      const a = text.indexOf(from);
      expect(a, `symbols.ts に ${from} が無い(形が変わった)`).toBeGreaterThanOrEqual(0);
      const b = text.indexOf(to, a);
      expect(b, `symbols.ts の ${from} が閉じていない`).toBeGreaterThan(a);
      return text.slice(a, b);
    };

    // ⚠ 図案の key は**引用符あり / なしが混ざる**(`settings: {` と `'arrow-in': {`)
    const names = [
      ...bare(between(src, 'export const PKC_SYMBOLS', '\n} as const')).matchAll(
        /^ {2}'?([a-z0-9-]+)'?: \{/gm,
      ),
    ].map((m) => m[1] as string);
    expect(names.length, '図案を拾えていない(空振り)').toBeGreaterThan(10);

    // どこかから指されているか ── 3 つの表の値、または src の字面(icons.ts 以外)
    const pointed = new Set<string>([
      ...Object.values(ACTION_ICONS),
      ...Object.values(ARCHETYPE_ICONS),
      ...Object.values(BROWSE_ICONS),
    ]);
    const literals = new Set<string>();
    for (const f of tsFiles('src')) {
      if (f.endsWith('render/icons.ts') || f.endsWith('features/icon/symbols.ts')) continue;
      for (const m of bare(readFileSync(f, 'utf-8')).matchAll(/'([a-z0-9-]+)'/g))
        literals.add(m[1] as string);
    }
    const unpointed = names.filter((n) => !pointed.has(n) && !literals.has(n));
    expect(unpointed, '誰も指さない図案が増えた ── 呼ぶ道を作るか、落とすか、畳むと書く').toEqual(FOLDED);
  });
});

describe('絵文字を UI に置かない', () => {
  /**
   * 🔴 **絵文字が戻ってこないための網**。図案の表を 1 つに寄せても、
   * 次に触る人が「ここだけ絵文字で」と書けば方針は破れる。
   *
   * ⚠ 除外するのは 2 つだけで、どちらも**理由がある**:
   *   - `launcher.ts` … タイルの図案は **user のデータ**(添付の frontmatter
   *     `app_icon`)。ここを SVG にはできない
   *   - `export/pkc3-html.ts` … 書き出す HTML の中の文字列(アプリの画面ではない)
   */
  const ALLOWED = new Set([
    'src/adapter/ui/render/launcher.ts',
    'src/features/export/pkc3-html.ts',
  ]);

  it('🔴 UI の描画に絵文字リテラルが無い', () => {
    /**
     * 見るのは **絵文字の面(U+1F000〜1FAFF)だけ** ── 📄📁🚀📥💾🌐📝🧹📎🗑🕘 の類。
     *
     * ⚠ **BMP の記号は対象外**にしてある(⚠ ☑ ☐ ✕ ＋ ▦ …)。理由は 2 つ:
     *   ① user の指摘は「**多色**で書体依存」への指摘であり、BMP の記号は
     *      既定で単色の文字として出る
     *   ② `⚠ 注意 N 件` のように**文の中の記号**として使っている所がある
     *      (取込・書き出しの通知文)。あれはアイコンではないので直す対象ではない
     * ⚠ したがって「☑ を直に書く」型の退行は**この網では捕まらない**。
     *   kanban のトグルは P9 段③ で SVG へ寄せたが、それは `icons.test.ts` の
     *   「差し替えで空にならない」側と実装のレビューで守っている
     */
    const emoji = /[\u{1F000}-\u{1FAFF}]/u;
    const offenders: string[] = [];
    for (const f of tsFiles('src/adapter/ui').concat(tsFiles('src/features/launcher'))) {
      if (ALLOWED.has(f)) continue;
      // ⚠ **コメントは対象外**(この repo の注記は ⚠ や 🔴 を多用する)。
      //    block コメントを先に丸ごと落とし、そのあと行コメントを落とす ──
      //    行単位で `*` を見るだけでは `/** … */` の 1 行注記が残る(実際に踏んだ)
      const code = readFileSync(f, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''));
      for (const [i, line] of code.entries()) {
        if (emoji.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(offenders, '絵文字が UI に戻っている ── icons.ts の図案を使う').toEqual([]);
  });

  /**
   * 🔴 **隣に並ぶ図案は、輪郭で見分けられる**(2026-08-08、レビュー指摘で追加)。
   *
   * `icons.ts` は「設定の『つまみ』と**形が似ないもの**にした ── 隣に並ぶので、
   * 輪郭で区別が付く必要がある」と主張しているが、**それを守る test が無かった**
   * ── `set-view:flags` を `settings` に書き換えても 1 件も落ちなかった。
   *
   * ⚠ **全体の distinctness では見ない** ── 表には既に意図的な重複が在る
   * (`globe` / `arrow-out` 等は別の意味で同じ図案を使う)。⚠ ここが見るのは
   * **同時に画面へ並ぶもの**、つまり左の列の下に 3 つ並ぶ `set-view:*` だけである。
   */
  it('🔴 左の列に並ぶ図案が、互いに違う', () => {
    const keys = Object.keys(ACTION_ICONS).filter((k) => k.startsWith('set-view:'));
    // ⚠ 空振り防止 ── 面が増減したらここも動く(3 つとは書かない)
    expect(keys.length, '左の列の図案を拾えていない(空振り)').toBeGreaterThanOrEqual(3);
    const used = keys.map((k) => ACTION_ICONS[k]);
    expect(new Set(used).size, `隣り合う図案が同じ: ${used.join(' / ')}`).toBe(used.length);
  });

  it('🔴 この検査が空振りしていない(合成した違反を捕まえる)', () => {
    // ⚠ 検査する側も変異試験の対象(CLAUDE.md)
    const emoji = /[\u{1F000}-\u{1FAFF}]/u;
    expect(emoji.test("icon.textContent = '\u{1F4C4}';"), '絵文字を見つけられない').toBe(true);
    expect(emoji.test("const label = 'ノート';"), '普通の日本語を誤検知する').toBe(false);
    // ⚠ 文中の記号を誤検知しない(上の②の根拠)
    expect(emoji.test('`\u26a0 注意 ${n} 件`'), '文中の記号を誤検知する').toBe(false);
  });
});
