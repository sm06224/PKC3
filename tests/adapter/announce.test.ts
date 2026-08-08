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
import { createAnnounce, announceServices } from '../../src/adapter/ui/render/announce';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import {
  NoticeStore,
  appNoticeStore,
  type NoticeStorage,
} from '../../src/adapter/platform/notice-store';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import type { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState } from '../../src/adapter/state/app-state';
import { NOTICE_SHOW_MAX, type Notice } from '../../src/features/notice/notice-log';

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

  /**
   * 🔴 **素のテキストとして描く**(`textContent`)。
   *
   * ⚠ 1 巡目はここを「`**強調**` が `<strong>` にならない」で見ていた ──
   * **`innerHTML` で描いても markdown は HTML にならない**ので、
   * `innerHTML` へ替える変異が素通りした(変異試験で判明)。
   * 🔑 だから fixture は **HTML そのもの**にする ── 描き方の違いが出る唯一の形である。
   */
  it('🔴 素のテキストで出る(HTML として描かない)', () => {
    createAnnounce(region, new NoticeStore(memory()), [
      { id: '2026-08-08-x', title: 't', items: ['<b>太字</b>と <img src="x"> を書いた'] },
    ]).present();
    const li = region.querySelector('[data-pkc-announce] li')!;
    expect(li.children.length, 'HTML として描いている').toBe(0);
    expect(li.textContent, '原文が消えている').toContain('<b>太字</b>');
  });

  /** ⚠ **導線が画面に在る**(API を直接呼ぶ test は、ボタンが消えても通る)。 */
  it('🔴 閉じる導線と、戻せる導線が画面に在る', () => {
    createAnnounce(region, new NoticeStore(memory()), NOTES).present();
    expect(region.querySelector('[data-pkc-action="dismiss-announce"]'), '閉じる導線が無い')
      .not.toBeNull();
    expect(region.querySelector('[data-pkc-action="mute-announce"]'), '戻せる導線が無い')
      .not.toBeNull();
    // ⚠ **戻し道をその場に書く**(押した後に探させない)
    const mute = region.querySelector('[data-pkc-action="mute-announce"]')!;
    expect(mute.getAttribute('title') ?? '', '戻せることが書かれていない').toContain('設定');
  });

  /** ⚠ 件数を出す(「何件あるか」に気づく手掛かり)。 */
  it('⚠ 2 件以上なら件数が出る', () => {
    createAnnounce(region, new NoticeStore(memory()), NOTES).present();
    expect(region.querySelector('[data-pkc-field="announce-title"]')?.textContent).toContain(
      '2 件',
    );
  });

  /**
   * 🔴 **出した分だけを既読にする。**
   * ⚠ 1 巡目の fixture は `all === shown` にしかならず、`shown` を `all` に
   *   すり替える変異が素通りした ── **上限を超える登記表**が未測定の次元だった。
   */
  it('🔴 表示上限を超えていても、出した分だけ既読にする', () => {
    const many = Array.from({ length: NOTICE_SHOW_MAX + 3 }, (_, i) => ({
      id: `2026-01-${String(i + 1).padStart(2, '0')}-x`,
      title: `t${i}`,
      items: ['本文'],
    }));
    expect(many.length, 'fixture が上限を超えていない(空振り)').toBeGreaterThan(NOTICE_SHOW_MAX);
    const store = new NoticeStore(memory());
    const a = createAnnounce(region, store, many);
    a.present();
    a.dismiss();
    expect(store.seenIds(), '出していない分まで既読にした').toHaveLength(NOTICE_SHOW_MAX);
  });

  /** ⚠ 出していないなら、閉じても既読にならない(恒久オフ中の `dismiss`)。 */
  it('⚠ 出していないお知らせは、閉じても既読にならない', () => {
    const store = new NoticeStore(memory());
    store.setEnabled(false);
    const a = createAnnounce(region, store, NOTES);
    a.present(); // 恒久オフなので何も出ない
    a.dismiss();
    expect(store.seenIds(), '見ていないのに既読になった').toEqual([]);
  });
});

/**
 * 🔴 **押した先が繋がっている**(2026-08-08、変異試験の指摘)。
 *
 * ⚠ binder の 3 ハンドラは**1 度も実行されていなかった** ── 中身を空にしても、
 * 値を反転して渡しても、全 test が緑だった。`repo-hygiene` は「表に名前が在るか」
 * しか見ないので、**名前を消す変異は殺せるが、中身を空にする変異は殺せない**。
 */
describe('🔴 帯と設定のボタンが、受け手まで届く', () => {
  it('閉じる / 今後は出さない / 設定の切替が、それぞれの受け手を呼ぶ', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const band = document.createElement('section');
    root.append(band);
    createAnnounce(band, new NoticeStore(memory()), NOTES).present();
    const settingsHost = document.createElement('div');
    root.append(settingsHost);
    new SettingsRenderer(settingsHost, undefined, undefined, new NoticeStore(memory())).render(
      initialState,
    );

    const calls: string[] = [];
    const stop = bindActions(root, {} as unknown as Dispatcher, {
      dismissAnnounce: () => calls.push('dismiss'),
      muteAnnounce: () => calls.push('mute'),
      setNoticesEnabled: (on) => calls.push(`set:${String(on)}`),
    });

    root.querySelector<HTMLElement>('[data-pkc-action="dismiss-announce"]')!.click();
    root.querySelector<HTMLElement>('[data-pkc-action="mute-announce"]')!.click();
    const box = root.querySelector<HTMLInputElement>('[data-pkc-field="notices-enabled"]')!;
    // ⚠ **押した後の値**を渡すこと(反転して渡す変異をここで殺す)
    box.checked = false;
    box.click(); // click は checked を反転させる → true
    expect(calls, '受け手が呼ばれていない / 値が反転している').toEqual([
      'dismiss',
      'mute',
      'set:true',
    ]);
    stop();
  });
});

/**
 * 🔴 **配線そのもの**(`main.ts` はどの test からも実行されない)。
 * ⚠ ここが無いと「設定を切っただけの user を既読にする」型の取り違えが
 *   **全 test 緑のまま**出荷される(変異試験で実際に確かめた)。
 */
describe('🔴 お知らせの配線(main.ts から取り出した分)', () => {
  it('🔴 設定から切っても既読にしない / 保存する', () => {
    const store = new NoticeStore(memory());
    const a = createAnnounce(region, store, NOTES);
    a.present();
    const s = announceServices(a, store);
    s.setNoticesEnabled(false);
    expect(store.enabled(), '設定を保存していない').toBe(false);
    expect(store.seenIds(), '読んでいないのに既読にした').toEqual([]);
    expect(region.hidden, '切ったのに帯が出たまま').toBe(true);
  });

  it('🔴 閉じるは既読にする(hide にすり替わっていない)', () => {
    const store = new NoticeStore(memory());
    const a = createAnnounce(region, store, NOTES);
    a.present();
    announceServices(a, store).dismissAnnounce();
    expect(store.seenIds(), '閉じても既読にならない').toHaveLength(2);
  });

  it('🔴 「今後は出さない」の後に、画面を映し直す', () => {
    const store = new NoticeStore(memory());
    const a = createAnnounce(region, store, NOTES);
    a.present();
    let redrawn = 0;
    announceServices(a, store, () => {
      redrawn += 1;
    }).muteAnnounce();
    expect(store.enabled(), '恒久オフになっていない').toBe(false);
    expect(redrawn, '設定画面を映し直していない(古い値が見えたままになる)').toBe(1);
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
    /**
     * ⚠ **画面に入っている**ことまで見る(2026-08-08、変異試験の指摘)──
     * 属性だけ見ていたので、`shell.append` から外す変異が素通りした
     * (器は返るが、どこにも表示されない)。
     */
    expect(regions.announce.parentElement, '帯が shell に入っていない').toBe(
      root.querySelector('[data-pkc-region="shell"]'),
    );
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
    /**
     * 🔴 **版面は 3 つある**(広い / 1100px 以下 / 720px 以下)。
     * ⚠ 1 巡目は `exec` で**最初の 1 つしか読んでおらず**、狭い 2 つの版面から
     *   帯の行を消す変異が素通りした(変異試験で判明)。
     */
    const layouts = [...css.matchAll(/grid-template-areas:\s*([^;]+);/g)].map((m) => m[1] ?? '');
    expect(layouts, '版面を全部読めていない(空振り)').toHaveLength(3);
    for (const areas of layouts) {
      for (const name of ['announce', 'update', 'notices']) {
        const rows = areas.split('\n').filter((l) => l.includes(name));
        expect(rows, `${name} の行が 1 つではない版面がある`).toHaveLength(1);
      }
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
    // ⚠ ヘルプから読めることをその場に書く(「消えた」と思わせない)
    expect(host.textContent, 'ヘルプから読めることが書かれていない').toContain('ヘルプ');
  });

  /**
   * 🔴 **既定の store は帯と同じ 1 個**(2026-08-08、変異試験の指摘)。
   * ⚠ test が store を**手で渡していた**ので、既定引数を別物にする変異が
   *   素通りした ── 実アプリが通るのは既定引数の側である。
   */
  it('🔴 設定の既定の store が、アプリ共有の 1 個である', () => {
    const host = document.createElement('div');
    document.body.append(host);
    appNoticeStore.setEnabled(false);
    try {
      new SettingsRenderer(host).render(initialState); // 既定引数の経路
      expect(
        host.querySelector<HTMLInputElement>('[data-pkc-field="notices-enabled"]')!.checked,
        '設定が帯と別の store を見ている',
      ).toBe(false);
    } finally {
      appNoticeStore.setEnabled(true);
    }
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
