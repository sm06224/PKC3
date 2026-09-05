/** @vitest-environment happy-dom */
/**
 * 図案(P9 段③)。**絵文字を捨てて単色 SVG にした**ことの pin。
 *
 * 🔴 なぜ捨てたか ── user 指示 2026-08-03 の 2 件に同時に反していた:
 *   ① 「地は無彩色、色は情報にだけ使う」── 絵文字は多色で `color` を無視する
 *   ② 「絵文字を使うとボタンの高さが合わない」── 書体ごとに字幅・行送りが違う
 *
 * ⚠ 見るのは「SVG が出た」ではなく、**方針が守られていること**である:
 *   色を持たない / 表が 1 つに寄っている / 差し替えで空にならない。
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
  svgIcon,
} from '../../src/adapter/ui/render/icons';
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

describe('図案は単色の線画である', () => {
  it('🔴 図案がすべて描かれている(空の枠が無い)', () => {
    expect(ALL_NAMES.length, '図案の表が空(前提が崩れている)').toBeGreaterThan(10);
    for (const name of ALL_NAMES) {
      const svg = svgIcon(name);
      expect(svg.tagName.toLowerCase(), `${name} が svg でない`).toBe('svg');
      expect(svg.getAttribute('viewBox'), `${name} に viewBox が無い`).toBe('0 0 24 24');
      const paths = svg.querySelectorAll('path');
      expect(paths.length, `${name} に線が 1 本も無い(空の図案)`).toBeGreaterThan(0);
      for (const p of paths) {
        // 形が入っていること ── `d` が空の path は描かれない
        expect((p.getAttribute('d') ?? '').length, `${name} に空の path がある`).toBeGreaterThan(3);
      }
    }
  });

  it('🔴 図案に色を書いていない(値ではなく意味の名前だけ持つ)', () => {
    // 🔑 P10 で**塗りは使えるようにした**が、色の**値**は CSS が決める。
    //    ここに色を書くと、テーマや選択中の行で追従しない
    for (const name of ALL_NAMES) {
      const svg = svgIcon(name);
      for (const el of [svg, ...svg.querySelectorAll('*')]) {
        for (const attr of ['fill', 'stroke', 'color', 'style', 'fill-opacity']) {
          expect(
            el.getAttribute(attr),
            `${name} が ${attr} を持っている(色は CSS が決める)`,
          ).toBeNull();
        }
        const marker = el.getAttribute('data-pkc-fill');
        if (marker !== null) {
          // ⚠ 意味の名前だけ(色名・色値が紛れ込んでいないこと)
          expect(['solid', 'soft'], `${name} の塗りの名前が未知: ${marker}`).toContain(marker);
        }
      }
    }
  });

  it('🔴 塗りの名前が CSS で実際に描かれる(死んだ印を置かない)', () => {
    const css = readFileSync('src/styles/app.css', 'utf-8');
    const used = new Set<string>();
    for (const name of ALL_NAMES)
      for (const p of svgIcon(name).querySelectorAll('[data-pkc-fill]'))
        used.add(p.getAttribute('data-pkc-fill') ?? '');
    // ⚠ 使っている印が CSS に無ければ、その path は**何も塗られない**
    //    (= 中空の細線に戻る。見やすさのための塗りが黙って無効化される)
    expect(used.size, '塗りを使っている図案が 1 つも無い(前提が崩れている)').toBeGreaterThan(0);
    for (const marker of used)
      expect(css, `data-pkc-fill="${marker}" を描く規則が CSS に無い`).toContain(
        `path[data-pkc-fill='${marker}']`,
      );
  });

  it('🔴 線の太さを CSS px で決めている(場所によって細さが変わらない)', () => {
    const css = readFileSync('src/styles/app.css', 'utf-8');
    // viewBox 24 の中の値で決めると、13.3px の 設定 と 16px のチップで
    // 0.97px / 1.17px と散る ── `non-scaling-stroke` が外側の座標系で揃える
    expect(css, '`non-scaling-stroke` が無い(太さが場所で変わる)').toContain(
      'vector-effect: non-scaling-stroke',
    );
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
    expect(span.getAttribute('aria-hidden')).toBe('true');
    expect(span.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    // 器は **span**(大きさを決める CSS がそこに当たっている)
    expect(span.tagName.toLowerCase()).toBe('span');
  });

  it('🔴 図案つきボタンは 図案 + 文字 の 2 つで組む(文言は第 2 引数)', () => {
    const btn = iconButton('delete-entry', '削除');
    expect(btn.getAttribute('data-pkc-action')).toBe('delete-entry');
    expect(btn.querySelector('[data-pkc-icon] svg path')).not.toBeNull();
    expect(btn.querySelector('[data-pkc-field="label"]')?.textContent).toBe('削除');
    // ⚠ 図案の無い action は**器ごと出さない**(空の枠を置かない)
    const plain = iconButton('append-entry', '追記');
    expect(plain.querySelector('[data-pkc-icon]')).toBeNull();
    expect(plain.querySelector('[data-pkc-field="label"]')?.textContent).toBe('追記');
  });

  it('🔴 差し替えで空にならない(textContent 代入の罠)', () => {
    const span = iconSpan('page');
    setIcon(span, 'folder');
    expect(span.querySelectorAll('svg').length, '差し替えで svg が増えている').toBe(1);
    expect(span.querySelector('svg path'), '差し替えで中身が消えた').not.toBeNull();
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
    expect(chip!.querySelector('svg path'), '初回描画でチップが空').not.toBeNull();

    // 🔴 **行は作り直さない**(同じ lid なので patch 経路に入る)。ここが
    //    `chip.textContent = …` のままだと **svg ごと消えて空になる**
    sidebar.render(stateWith(meta('a', 'folder')));
    const after = root.querySelector('[data-pkc-chip]');
    expect(after!.getAttribute('data-pkc-chip'), '種別の印が変わっていない').toBe('folder');
    expect(after!.querySelector('svg path'), 'patch でチップが空になった').not.toBeNull();
  });

  it('🔴 未知の種別でもチップが空にならない(行の頭が揃う)', () => {
    const root = document.createElement('div');
    const regions = buildShell(root);
    const sidebar = new SidebarRenderer(regions.sidebar);
    sidebar.render(stateWith(meta('a', 'なにか未知')));
    expect(root.querySelector('[data-pkc-chip] svg path')).not.toBeNull();
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

    const src = readFileSync('src/adapter/ui/render/icons.ts', 'utf-8');
    const bare = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const between = (text: string, from: string, to: string): string => {
      const a = text.indexOf(from);
      expect(a, `icons.ts に ${from} が無い(形が変わった)`).toBeGreaterThanOrEqual(0);
      const b = text.indexOf(to, a);
      expect(b, `icons.ts の ${from} が閉じていない`).toBeGreaterThan(a);
      return text.slice(a, b);
    };

    // ⚠ 図案の key は**引用符なし**(`settings: [`)── 引用符ありで探すと 0 件になる
    const names = [
      ...bare(between(src, 'const ICON_PATHS', '\nexport type IconName')).matchAll(/^ {2}'?([a-z0-9-]+)'?:/gm),
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
      if (f.endsWith('render/icons.ts')) continue;
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
