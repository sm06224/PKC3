/** @vitest-environment happy-dom */
/**
 * 🔴 **起動したときのお知らせ**(P11 段⑤。user 指示 2026-08-07
 * 「PKC3 にも PKC2 のようにお知らせポップアップをつけてください」)。
 *
 * ## この test が守るもの
 *
 * - **未読が在るときだけ出る**(空の枠を残さない / 読んだ物を出し直さない)
 * - 🔴 **`notices` / `update` の行に相乗りしない**(裁定 Q5)── 相乗りすると、
 *   取込のたびに読む前に消え、更新の案内と重なる
 * - 🔴 **「今後は出さない」に戻し道がある**(設定の「表示」)── 戻せない導線を作らない
 * - 🔴 **帯から切った設定が、設定画面に映る** ── 器は 1 度しか組まないので、
 *   映さないと古い値が見える(CLAUDE.md「設定画面の値の同期」)
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { createAnnounce } from '../../src/adapter/ui/render/announce';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { NoticeStore, type NoticeStorage } from '../../src/adapter/platform/notice-store';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { initialState } from '../../src/adapter/state/app-state';
import type { Notice } from '../../src/features/notice/notice-log';

function memory(): NoticeStorage {
  const data: Record<string, string> = {};
  return {
    get: (k) => data[k] ?? null,
    set: (k, v) => {
      data[k] = v;
    },
    remove: (k) => {
      delete data[k];
    },
  };
}

const NOTES: readonly Notice[] = [
  { id: '2026-08-08-b', title: '新しい方', items: ['あたらしい話'] },
  { id: '2026-01-01-a', title: '古い方', items: ['ふるい話'] },
];

let region: HTMLElement;
beforeEach(() => {
  document.body.textContent = '';
  region = document.createElement('section');
  region.hidden = true;
  document.body.append(region);
});

describe('お知らせの帯', () => {
  it('未読が在れば出て、新しい順に並ぶ', () => {
    createAnnounce(region, new NoticeStore(memory()), NOTES).present();
    expect(region.hidden, '出ていない').toBe(false);
    const ids = [...region.querySelectorAll('[data-pkc-announce]')].map((e) =>
      e.getAttribute('data-pkc-announce'),
    );
    expect(ids).toEqual(['2026-08-08-b', '2026-01-01-a']);
    expect(region.textContent, '本文が出ていない').toContain('あたらしい話');
    // ⚠ 閉じたら二度と読めない、と思わせない
    expect(region.textContent, 'あとから読める場所を書いていない').toContain('ヘルプ');
  });

  it('⚠ 未読が 0 件なら**行の高さを 0 に保つ**(空の枠を残さない)', () => {
    const store = new NoticeStore(memory());
    store.markSeen(NOTES.map((n) => n.id));
    createAnnounce(region, store, NOTES).present();
    expect(region.hidden, '空の枠が出ている').toBe(true);
    expect(region.textContent).toBe('');
  });

  it('🔴 閉じると既読になり、次からは出ない', () => {
    const store = new NoticeStore(memory());
    const a = createAnnounce(region, store, NOTES);
    a.present();
    a.dismiss();
    expect(region.hidden).toBe(true);
    a.present();
    expect(region.hidden, '読んだお知らせが出直している').toBe(true);
  });

  /**
   * ⚠ **出した時点の未読だけを既読にする。** 表示中に登記表が増えても、
   * user が見ていない物まで既読にしない。
   */
  it('⚠ 見ていないお知らせまで既読にしない', () => {
    const store = new NoticeStore(memory());
    const a = createAnnounce(region, store, [NOTES[1]!]); // 古い方だけ見せる
    a.present();
    a.dismiss();
    expect(store.seenIds()).toEqual(['2026-01-01-a']);
  });

  it('🔴 「今後は出さない」で恒久オフになり、既読にもなる', () => {
    const st = memory();
    const store = new NoticeStore(st);
    const a = createAnnounce(region, store, NOTES);
    a.present();
    a.mute();
    expect(region.hidden).toBe(true);
    // 戻したときに、もう読んだ物が出直さない
    expect(store.seenIds()).toHaveLength(2);
    expect(new NoticeStore(st).enabled(), '恒久オフが保存されていない').toBe(false);
  });

  it('恒久オフなら未読が在っても出ない', () => {
    const store = new NoticeStore(memory());
    store.setEnabled(false);
    createAnnounce(region, store, NOTES).present();
    expect(region.hidden, 'オフなのに出ている').toBe(true);
  });

  /**
   * ⚠ **設定から切っただけの user は読んでいない** ── `hide` は既読にしない。
   * 既読にすると、戻したときに「見ていないお知らせ」が消えたままになる。
   */
  it('⚠ 設定から切っても既読にはしない(戻せば出直す)', () => {
    const store = new NoticeStore(memory());
    const a = createAnnounce(region, store, NOTES);
    a.present();
    a.hide();
    expect(store.seenIds(), '読んでいないのに既読にした').toEqual([]);
  });

  it('⚠ 記法を書かない決まりどおり、素のテキストで出る', () => {
    createAnnounce(region, new NoticeStore(memory()), [
      { id: '2026-08-08-x', title: 't', items: ['**強調**にはしない'] },
    ]).present();
    const li = region.querySelector('[data-pkc-announce] li')!;
    // ⚠ textContent で描くので、記法を書くとアスタリスクが見える(PKC2 の失敗)
    expect(li.innerHTML, 'HTML として描いている').not.toContain('<strong>');
  });
});

/**
 * 🔴 **自分の行に出る**(裁定 Q5)。
 * ⚠ `notices` は取込のたびに中身が作り替わる ── 相乗りすると読む前に消える。
 * ⚠ `update` と同じ行にすると、両方出たときに重なる。
 */
describe('🔴 帯の置き場', () => {
  it('notices / update とは別の器である', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    expect(regions.announce, 'お知らせの器が無い').toBeTruthy();
    expect(regions.announce).not.toBe(regions.notices);
    expect(regions.announce).not.toBe(regions.update);
    expect(regions.announce.getAttribute('data-pkc-region')).toBe('announce');
    expect(regions.announce.hidden, '既定で場所を取っている').toBe(true);
  });

  /**
   * 🔴 **grid の区画名が 3 つとも別**。同じ area に載せると重なる ──
   * `shell.ts` を直しても CSS を直し忘れると、そこで初めて重なる。
   */
  it('🔴 CSS の区画が notices / update と別に取ってある', async () => {
    const css = await import('node:fs').then((fs) =>
      fs.readFileSync('src/styles/app.css', 'utf-8'),
    );
    expect(css, 'announce の区画が無い').toMatch(/\[data-pkc-region='announce'\]\s*\{[^}]*grid-area:\s*announce/);
    // 3 つの帯が別の行に居る(いちばん広い版面の表で見る)
    const areas = /grid-template-areas:\s*([^;]+);/.exec(css)?.[1] ?? '';
    for (const name of ['announce', 'update', 'notices']) {
      const rows = areas.split('\n').filter((l) => l.includes(name));
      expect(rows, `${name} の行が 1 つではない`).toHaveLength(1);
    }
  });
});

describe('🔴 「今後は出さない」の戻し道(設定の「表示」)', () => {
  it('設定に切替が在り、いまの値が映る', () => {
    const store = new NoticeStore(memory());
    const host = document.createElement('div');
    document.body.append(host);
    new SettingsRenderer(host, undefined, undefined, store).render(initialState);
    const box = host.querySelector<HTMLInputElement>('[data-pkc-field="notices-enabled"]');
    expect(box, '戻し道が無い(押した user が復帰できない)').not.toBeNull();
    expect(box!.checked, '既定は出す').toBe(true);
  });

  /**
   * 🔴 **帯から切ったことが、設定画面に映る。**
   * ⚠ 器は 1 度しか組まないので、映さないと**古い値が見える** ── そして user は
   *   「切ったのに戻っている」と読む(CLAUDE.md「設定画面の値の同期」)。
   */
  it('🔴 帯から切った後に設定を開き直すと、オフが映る', () => {
    const store = new NoticeStore(memory());
    const host = document.createElement('div');
    document.body.append(host);
    const s = new SettingsRenderer(host, undefined, undefined, store);
    s.render(initialState); // 1 度目 = 器を組む
    createAnnounce(region, store, NOTES).mute(); // 画面の外で設定が変わる
    s.render(initialState); // 2 度目 = 器は組み直さない
    const box = host.querySelector<HTMLInputElement>('[data-pkc-field="notices-enabled"]')!;
    expect(box.checked, '古い値のまま見えている').toBe(false);
  });
});
