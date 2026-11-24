/** @vitest-environment happy-dom */
/**
 * 🔴 **ファイラー以外のタブでは、左のペインの上の「ファイラー用の頭」のうち効かない部分を畳む**(#1442 S3-2。user 指示 2026-11-24)。
 *
 * 頭 = ① 探す欄(+ 種類のチップ・保存した検索)② 並び順・⇅ ③ 作る帯(約 110px)。予定・アプリ・グラフ・シェル・連絡先などを開いているとき、
 * ファイラー専用の道具が場所を取っていた。畳んで各タブの領域を広げ、ファイラーへ戻れば元どおり出す(双方向)。
 *
 * ## 守る主張
 * 1. 判定は 1 関数(`filerHeaderFold`)で、**どのタブで何を畳むか**を表で持つ。ファイラーは何も畳まない(対照群)
 * 2. ⚠ **語が中身を絞るタブでは探す欄を畳まない**(絞りの原因が見えず外せなくなる ── 連絡先の「絞りを外す」の行き止まり)。
 *    表の根拠は**実装を読む test**(下の ②)で縛る:`state.filterQuery` を読む描画器 = 探す欄を畳まないタブ
 * 3. ⚠ **録音・時間を計るの押し口は作る帯にしか無い** ── 音/動画・時間のタブでは作る帯を畳まない
 * 4. 印(`data-pkc-filer-fold`)がモードに従って付く・戻ると外れる / 畳むのは CSS で、`hidden` 属性には触れない
 * 5. CSS が畳む・メッセージの入口(スマホ幅の作る帯の末尾)は畳まない
 * 6. `focus-search`(探す欄への焦点)は探す欄を畳んでいるとき**フォルダのタブへ移ってから**入れる
 * ⚠ 見え方(実座標)は `tests/smoke/toolbar-fold.smoke.spec.ts` が実ブラウザで見る。
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { BROWSE_MODES, FILER_FOLD_ATTR, filerHeaderFold, type BrowseMode } from '../../src/adapter/ui/render/browse-mode';
import { bindActions, runGlobalCommand } from '../../src/adapter/ui/actions/binder';
import { appKeymap } from '../../src/adapter/ui/render/keymap';
import { stripComments } from '../helpers/css-blocks';

beforeEach(() => {
  document.body.textContent = '';
});

describe('① filerHeaderFold(どのタブで何を畳むか。判定は 1 本)', () => {
  it('🔴 フォルダは何も畳まない(対照群)', () => {
    expect(filerHeaderFold('filer')).toEqual([]);
  });

  it('🔴 表: 予定・アプリ・連絡先は並び順と作る帯だけ / 音/動画・時間は並び順だけ / グラフ・PC・シェル・手書きは全部', () => {
    for (const m of ['launcher', 'schedule', 'contacts'] as const) expect(filerHeaderFold(m), m).toEqual(['sort', 'create']);
    for (const m of ['captures', 'timers'] as const) expect(filerHeaderFold(m), m).toEqual(['sort']);
    for (const m of ['graph', 'pc', 'shell', 'draw'] as const) expect(filerHeaderFold(m), m).toEqual(['search', 'sort', 'create']);
  });

  it('⚠ 空振り防止: 全モードを引ける(表に載っていないタブが無い)/ 並び順を畳まないのはフォルダだけ', () => {
    for (const m of BROWSE_MODES) expect(Array.isArray(filerHeaderFold(m)), m).toBe(true);
    expect(BROWSE_MODES.filter((m) => !filerHeaderFold(m).includes('sort'))).toEqual(['filer']);
  });
});

describe('② 表の根拠 ── 探す欄の語で中身を絞るタブでは、探す欄を畳まない(実装を読んで縛る)', () => {
  /** タブ → その中身を描く file。⚠ `browse.ts` の `render` の分岐と同じ顔ぶれ。 */
  const RENDERER: Readonly<Record<BrowseMode, string | null>> = {
    filer: 'filer.ts',
    launcher: 'launcher.ts',
    schedule: 'schedule.ts',
    contacts: 'contacts.ts',
    captures: 'captures.ts',
    graph: 'graph.ts',
    timers: 'timers.ts',
    pc: 'pc-folder.ts',
    shell: 'cmdshell.ts',
    draw: null, // 手書きの面は絞りを読まない(描画器を持たず、別ウィンドウの退避先)
  };
  it('🔴 `state.filterQuery` を読む描画器のタブは探す欄を畳まず、読まないタブだけが畳む', () => {
    for (const mode of BROWSE_MODES) {
      const file = RENDERER[mode];
      const reads =
        file !== null &&
        /state\.filterQuery|entryFilterOf\(/.test(readFileSync(`src/adapter/ui/render/${file}`, 'utf8'));
      const folded = filerHeaderFold(mode).includes('search');
      expect(folded, `${mode}: 語で絞るのに探す欄を畳んでいる / 絞らないのに出している(読んでいる=${String(reads)})`).toBe(!reads);
    }
  });

  it('🔴 音/動画・時間のタブに、録音・画面録画・時間を計るの押し口は作る帯にしか無い → 作る帯を畳まない', () => {
    for (const f of ['captures.ts', 'timers.ts']) {
      const src = readFileSync(`src/adapter/ui/render/${f}`, 'utf8');
      expect(/start-audio-capture|start-screen-capture|start-timer/.test(src), `${f} に自前の押し口ができた(作る帯を畳んでよいか見直す)`).toBe(false);
    }
    for (const m of ['captures', 'timers'] as const) expect(filerHeaderFold(m)).not.toContain('create');
  });
});

function mount() {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const router = new BrowseRouter(regions.sidebar, regions.browseHost);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  return { root, d, regions, router };
}
const fold = (sidebar: HTMLElement): string | null => sidebar.getAttribute(FILER_FOLD_ATTR);

describe('③ BrowseRouter が印を付け外しする(双方向)', () => {
  it('🔴 フォルダ = 印なし / タブごとの表のとおり / フォルダへ戻ると印が外れる(双方向)', () => {
    const { d, regions, router } = mount();
    router.render(d.getState(), 'filer');
    expect(fold(regions.sidebar)).toBeNull();
    for (const m of BROWSE_MODES) {
      if (m === 'filer') continue;
      router.render(d.getState(), m);
      expect(fold(regions.sidebar), `${m} の印が表と違う`).toBe(filerHeaderFold(m).join(' '));
      router.render(d.getState(), 'filer');
      expect(fold(regions.sidebar), `${m} → フォルダで印が外れない`).toBeNull();
    }
  });

  it('🔴 畳みは `hidden` 属性を使わない(`>` の間の出し入れ ── create-bar の hidden ── と上書きし合わない)/ DOM は残る', () => {
    const { d, regions, router } = mount();
    router.render(d.getState(), 'graph');
    for (const r of ['find-bar', 'create-bar', 'kind-bar', 'saved-searches']) {
      expect(regions.sidebar.querySelector(`[data-pkc-region="${r}"]`), `${r} が DOM に無い(鍵の受け手が消えた)`).not.toBeNull();
    }
    expect(regions.sidebar.querySelector<HTMLElement>('[data-pkc-region="create-bar"]')!.hidden, 'hidden 属性を書いている').toBe(false);
    expect(regions.sidebar.querySelector('[data-pkc-field="entry-filter"]'), '探す欄が DOM から消えた').not.toBeNull();
  });
});

describe('④ CSS(畳む部分と属性の語が噛み合う / メッセージの入口は畳まない)', () => {
  const css = stripComments(readFileSync('src/styles/app.css', 'utf8'));
  const at = css.indexOf("[data-pkc-region='sidebar'][data-pkc-filer-fold~='search']");
  const rule = at < 0 ? '' : css.slice(at, css.indexOf('{', css.indexOf("[data-pkc-filer-fold~='create'] > [data-pkc-region='create-bar'] >", at)) + 1);

  it('🔴 3 つの語(search / sort / create)がそれぞれの部分を畳む', () => {
    expect(at, '畳む規則が無い').toBeGreaterThan(-1);
    expect(rule).toMatch(/filer-fold~='search'\] > :is\(\s*\[data-pkc-region='find-bar'\],\s*\[data-pkc-region='kind-bar'\],\s*\[data-pkc-region='saved-searches'\]/);
    expect(rule).toMatch(/filer-fold~='sort'\] > \[data-pkc-region='find-bar'\] > :is\(\s*\[data-pkc-field='entry-sort'\],\s*\[data-pkc-field='entry-sort-reverse'\]/);
    expect(rule).toMatch(/filer-fold~='create'\] > :is\(\s*\[data-pkc-region='create-menu'\]/);
    expect(css.slice(at)).toMatch(/\{\s*display:\s*none;\s*\}/);
    // 入口の居ない作る帯(PC)は丸ごと畳み、居る帯(スマホ)は子だけ畳んで入口を残す
    expect(rule).toContain(":not(:has(> [data-pkc-field='message-entry']))");
    expect(rule).toContain("> :not([data-pkc-field='message-entry'])");
  });

  it('⚠ 印の語は `filerHeaderFold` の語と同じ(綴りが片方だけ変わると畳まれなくなる)', () => {
    const words = new Set(BROWSE_MODES.flatMap((m) => filerHeaderFold(m)));
    expect([...words].sort()).toEqual(['create', 'search', 'sort']);
    for (const w of words) expect(rule, w).toContain(`filer-fold~='${w}'`);
  });
});

describe('⑤ 探す欄への焦点は、探す欄を畳んでいるときフォルダのタブへ移ってから入れる', () => {
  it('🔴 グラフのタブで focus-search を撃つと、フォルダのタブを押してから欄へ焦点が入る', () => {
    const { root, d, regions, router } = mount();
    bindActions(root, d, { setBrowse: (m) => router.render(d.getState(), m as BrowseMode) });
    router.render(d.getState(), 'graph');
    expect(fold(regions.sidebar)).toContain('search');
    const handled = runGlobalCommand('focus-search', root, d, appKeymap, () => {}, () => {}, false);
    expect(handled).toBe(true);
    expect(fold(regions.sidebar), 'フォルダへ移っていない').toBeNull();
    expect(document.activeElement).toBe(root.querySelector('[data-pkc-field="entry-filter"]'));
  });

  it('対照群: 探す欄が見えているタブ(予定)・フォルダでは、タブを動かさずに焦点だけ入る', () => {
    for (const mode of ['schedule', 'filer'] as const) {
      document.body.textContent = '';
      const { root, d, router } = mount();
      let moved = 0;
      bindActions(root, d, { setBrowse: () => void (moved += 1) });
      router.render(d.getState(), mode);
      runGlobalCommand('focus-search', root, d, appKeymap, () => {}, () => {}, false);
      expect(moved, `${mode}: 畳んでいないのにタブを動かした`).toBe(0);
      expect(document.activeElement, mode).toBe(root.querySelector('[data-pkc-field="entry-filter"]'));
    }
  });
});
