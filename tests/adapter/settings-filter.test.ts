/** @vitest-environment happy-dom */
/**
 * 🔴 **設定を探す欄**(#1966 3-1)── システムの画面の 40 ほどの設定を、項目の名前・説明の語で絞る。
 *
 * - 字の均し方は「操作を探す」と同じ(全角半角・ひらがなカタカナ・大文字小文字)
 * - 空白で区切った語は全部含む行だけ残す / 見出しに当たればその節は丸ごと残す / 当たりの無い節と目次は隠す
 * - ⚠ 隠すのは専用の印で、各節の `hidden` は触らない(語を消せば、節が自分で隠していた物はそのまま)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { SETTINGS_FILTERED_ATTR, applySettingsFilter } from '../../src/adapter/ui/render/settings-filter';
import { initialState } from '../../src/adapter/state/app-state';
import { JobMonitor } from '../../src/adapter/platform/job-monitor';
import { matchesSettingsQuery, settingsQueryWords } from '../../src/features/settings/settings-query';

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('当たり判定(pure)', () => {
  it('🔴 「操作を探す」と同じ均し方 ── ひらがな / 半角カナ / 全角英数で当たる', () => {
    expect(matchesSettingsQuery('文字の大きさ', settingsQueryWords('もじ'))).toBe(false);
    expect(matchesSettingsQuery('フォントの大きさ', settingsQueryWords('ふぉんと'))).toBe(true);
    expect(matchesSettingsQuery('フォントの大きさ', settingsQueryWords('ﾌｫﾝﾄ'))).toBe(true);
    expect(matchesSettingsQuery('PDF の開き方', settingsQueryWords('ｐｄｆ'))).toBe(true);
  });
  it('🔴 空白(全角も)で区切った語は、全部含むときだけ当たる', () => {
    expect(matchesSettingsQuery('文字の大きさ', settingsQueryWords('文字　大きさ'))).toBe(true);
    expect(matchesSettingsQuery('文字の大きさ', settingsQueryWords('文字 配色'))).toBe(false);
  });
  it('⚠ 空・空白だけなら絞らない', () => {
    expect(settingsQueryWords('  　 ')).toEqual([]);
    expect(matchesSettingsQuery('何でも', [])).toBe(true);
  });
});

function mount() {
  const root = document.createElement('div');
  document.body.append(root);
  const settings = new SettingsRenderer(root, new JobMonitor());
  settings.render(initialState);
  const input = root.querySelector<HTMLInputElement>('[data-pkc-field="settings-filter"]');
  expect(input, '設定を探す欄が無い').not.toBeNull();
  const type = (q: string): void => {
    input!.value = q;
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const shownDt = (): string[] =>
    [...root.querySelectorAll<HTMLElement>('[data-pkc-region="settings-body"] dt')]
      .filter((dt) => dt.closest(`[${SETTINGS_FILTERED_ATTR}]`) === null)
      .map((dt) => (dt.textContent ?? '').trim());
  const count = (): string => root.querySelector('[data-pkc-field="settings-filter-count"]')?.textContent ?? '';
  return { root, settings, type, shownDt, count };
}

describe('システムの画面で絞る', () => {
  it('🔴 語を打つと、当たった設定だけが残り、件数が出る / 消すと全部戻る', () => {
    const { type, shownDt, count } = mount();
    const all = shownDt();
    expect(all.length, '前提が崩れている(設定の行が少なすぎる)').toBeGreaterThan(15);
    expect(all).toContain('文字の大きさ');
    type('文字の大きさ');
    const hit = shownDt();
    expect(hit, '当たった行が残っていない').toContain('文字の大きさ');
    expect(hit, '当たらない行が残っている').not.toContain('配色');
    expect(hit.length).toBeLessThan(all.length);
    expect(count()).toMatch(/^\d+ 件$/);
    type('');
    expect(shownDt(), '語を消しても全部戻らない').toEqual(all);
    expect(count()).toBe('');
  });

  it('🔴 見出しに当たれば、その節の行は丸ごと残る', () => {
    const { type, shownDt, root } = mount();
    type('表示');
    const hit = shownDt();
    // 「表示」節の「配色」は、行の字に「表示」が無くても見出しで残る
    expect(hit, '見出しに当たった節の行が消えた').toContain('配色');
    const userSection = root.querySelector('[data-pkc-region="settings-user"]')!;
    expect(userSection.hasAttribute(SETTINGS_FILTERED_ATTR)).toBe(false);
  });

  it('🔴 当たりの無い節は見出しごと隠し、目次のそのボタンも隠す', () => {
    const { type, root } = mount();
    type('文字の大きさ');
    const perm = root.querySelector('[data-pkc-region="settings-permissions"]')!;
    expect(perm.hasAttribute(SETTINGS_FILTERED_ATTR), '当たりの無い「許可」の節が残っている').toBe(true);
    const permId = perm.querySelector('h3')!.getAttribute('data-pkc-section');
    const link = root.querySelector(`[data-pkc-region="settings-toc"] [data-pkc-target="${permId}"]`)!;
    expect(link.hasAttribute(SETTINGS_FILTERED_ATTR), '目次に飛んでも何も無い節のボタンが残っている').toBe(true);
    // 当たった節の目次は残る
    const config = root.querySelector('[data-pkc-region="settings-config"]')!;
    const cfgId = config.querySelector('h3')!.getAttribute('data-pkc-section');
    expect(root.querySelector(`[data-pkc-target="${cfgId}"]`)!.hasAttribute(SETTINGS_FILTERED_ATTR)).toBe(false);
  });

  it('⚠ 何も当たらなければ、そう言う', () => {
    const { type, shownDt, count } = mount();
    type('ぜったいにない語ｘｙｚ');
    expect(shownDt()).toEqual([]);
    expect(count()).toBe('この語を含む設定はありません');
  });

  it('⚠ 節が自分で付けた hidden は触らない(語を消しても、節が隠していた物は隠れたまま)', () => {
    const { type, root } = mount();
    const dts = [...root.querySelectorAll<HTMLElement>('[data-pkc-region="settings-body"] dt')];
    const own = dts[3]!;
    own.hidden = true; // 節の都合で隠れている行の代わり
    type('文字');
    type('');
    expect(own.hidden, '絞り込みが節の hidden を外した').toBe(true);
  });

  it('🔑 映し直し(render)で節が行を作り直しても、語が入っていれば絞り直す', () => {
    const { type, shownDt, settings, root } = mount();
    type('文字の大きさ');
    const before = shownDt();
    // 節の sync が行を作り直した形を真似る(印の無い新しい行が 1 つ増える)
    // ⚠ 当たった行(文字の大きさ)と同じ dl に足す ── 隠れた節に足すと、絞り直さなくても見えないので空振る
    const dl = [...root.querySelectorAll('[data-pkc-region="settings-body"] dt')]
      .find((e) => (e.textContent ?? '').trim() === '文字の大きさ')!
      .closest('dl')!;
    const dt = document.createElement('dt');
    dt.textContent = '作り直された関係ない行';
    const dd = document.createElement('dd');
    dl.append(dt, dd);
    settings.render(initialState);
    expect(shownDt(), '映し直しの後、絞りが外れた行が出ている').toEqual(before);
  });
});

describe('着地前レビューの指摘', () => {
  it('🔴 節の名前と項目の名前を混ぜて打っても当たる(「表示 配色」)', () => {
    const { type, shownDt } = mount();
    type('表示 配色');
    const hit = shownDt();
    expect(hit, '見出しと行に分かれた語で当たらない').toContain('配色');
    expect(hit, '「配色」を含まない行まで残っている').not.toContain('文字の大きさ');
  });

  it('🔴 h3 の見出しの語(「許可」)で、その節は丸ごと残る', () => {
    const { type, root } = mount();
    type('許可');
    const perm = root.querySelector('[data-pkc-region="settings-permissions"]')!;
    expect(perm.hasAttribute(SETTINGS_FILTERED_ATTR), '見出しに当たった節が隠れた').toBe(false);
    const cfg = root.querySelector('[data-pkc-region="settings-user"]')!;
    expect(cfg.hasAttribute(SETTINGS_FILTERED_ATTR), '当たらない「表示」の節が残っている').toBe(true);
  });

  it('⚠ 語を消すと、目次のボタンの印も全部外れる', () => {
    const { type, root } = mount();
    type('文字の大きさ');
    const toc = root.querySelector('[data-pkc-region="settings-toc"]')!;
    expect(toc.querySelectorAll(`[${SETTINGS_FILTERED_ATTR}]`).length, '前提: 目次が絞られていない').toBeGreaterThan(0);
    type('');
    expect(toc.querySelectorAll(`[${SETTINGS_FILTERED_ATTR}]`).length, '目次のボタンが隠れたまま').toBe(0);
  });
});

describe('件数(手で組んだ画面で数える)', () => {
  function fixture(): HTMLElement {
    const body = document.createElement('div');
    body.innerHTML = `
      <p>先頭の案内 りんご</p>
      <section><h3>果物</h3>
        <dl>
          <dt>りんご</dt><dd>赤い</dd>
          <dt>みかん</dt><dd>りんごではない</dd>
          <dt hidden>りんご(節が隠した)</dt><dd>りんご</dd>
          <dt>ぶどう</dt><dd><button>りんごを割り当てる</button></dd>
        </dl>
        <section><h4>一覧</h4><p>りんごの表</p></section>
        <section><h4>別</h4><p>なし</p></section>
      </section>
      <section><h3>野菜</h3><dl><dt>なす</dt><dd>紫</dd></dl></section>`;
    document.body.append(body);
    return body;
  }

  it('🔴 行 2 + 葉の節 1 + 節の外 1 = 4 件(隠れた行・ボタンの字は数えない)', () => {
    const body = fixture();
    expect(applySettingsFilter(body, 'りんご')).toBe(4);
    const shown = [...body.querySelectorAll('dt')]
      .filter((dt) => dt.closest(`[${SETTINGS_FILTERED_ATTR}]`) === null && !dt.hidden)
      .map((dt) => dt.textContent);
    expect(shown).toEqual(['りんご', 'みかん']);
    // ボタンの字だけで当たる「ぶどう」は隠れる
    const grape = [...body.querySelectorAll('dt')].find((dt) => dt.textContent === 'ぶどう')!;
    expect(grape.hasAttribute(SETTINGS_FILTERED_ATTR)).toBe(true);
    // 当たりの無い「野菜」の節と「別」の節は隠れる
    const secs = [...body.querySelectorAll('section')];
    expect(secs.filter((s) => s.hasAttribute(SETTINGS_FILTERED_ATTR)).map((s) => s.firstElementChild!.textContent)).toEqual([
      '別',
      '野菜',
    ]);
    expect(applySettingsFilter(body, '')).toBeNull();
    expect(body.querySelectorAll(`[${SETTINGS_FILTERED_ATTR}]`).length).toBe(0);
  });

  it('⚠ 節が隠した行だけが当たる節は、見出しごと隠す(見えない物で節を残さない)', () => {
    const body = document.createElement('div');
    body.innerHTML = `<section><h3>甲</h3><dl><dt hidden>みつけた</dt><dd></dd><dt>ほか</dt><dd></dd></dl></section>`;
    expect(applySettingsFilter(body, 'みつけた')).toBe(0);
    expect(body.querySelector('section')!.hasAttribute(SETTINGS_FILTERED_ATTR)).toBe(true);
  });
});
