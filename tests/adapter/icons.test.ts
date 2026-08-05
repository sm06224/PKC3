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

  it('🔴 図案に色を書いていない(currentColor に任せる)', () => {
    // ⚠ ここが方針の本体 ── 属性で色を持つと、テーマや選択中の行で追従しない
    for (const name of ALL_NAMES) {
      const svg = svgIcon(name);
      for (const el of [svg, ...svg.querySelectorAll('*')]) {
        for (const attr of ['fill', 'stroke', 'color', 'style']) {
          expect(
            el.getAttribute(attr),
            `${name} が ${attr} を持っている(色は CSS の currentColor が決める)`,
          ).toBeNull();
        }
      }
    }
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

  it('🔴 この検査が空振りしていない(合成した違反を捕まえる)', () => {
    // ⚠ 検査する側も変異試験の対象(CLAUDE.md)
    const emoji = /[\u{1F000}-\u{1FAFF}]/u;
    expect(emoji.test("icon.textContent = '\u{1F4C4}';"), '絵文字を見つけられない').toBe(true);
    expect(emoji.test("const label = 'ノート';"), '普通の日本語を誤検知する').toBe(false);
    // ⚠ 文中の記号を誤検知しない(上の②の根拠)
    expect(emoji.test('`\u26a0 注意 ${n} 件`'), '文中の記号を誤検知する').toBe(false);
  });
});
