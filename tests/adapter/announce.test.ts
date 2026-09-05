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
import { createHash } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import { createAnnounce, announceServices } from '../../src/adapter/ui/render/announce';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import {
  NoticeStore,
  appNoticeStore,
  type NoticeStorage,
} from '../../src/adapter/platform/notice-store';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { stripComments } from '../helpers/css-blocks';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import type { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState } from '../../src/adapter/state/app-state';
import {
  NOTICES,
  NOTICE_SEEN_MAX,
  NOTICE_SHOW_MAX,
  recentNotices,
  type Notice,
} from '../../src/features/notice/notice-log';

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
  /** 画面に出ている お知らせの id(0 件なら空)。 */
  const onScreen = (): string[] =>
    [...region.querySelectorAll('[data-pkc-announce]')].map(
      (e) => e.getAttribute('data-pkc-announce') ?? '',
    );

  /**
   * 🔴 **出すのは 1 件だけ**(#475、2026-08-27 の実機検証レポート #16)。
   *
   * ⚠ 直す前は未読を**全部積んで**いた ── 初回起動の user は未読が登記表の全数
   * (最大 10 件)なので、必ず `max-height: 30vh` に当たり、
   * 「**箱が大きいのに一度に 1 件しか読めない**」形だった。
   *
   * 🔑 ここで見るのは 3 つ:**1 件だけ出る / 新しい順 / 送ると次が出る**。
   * ⚠ 「1 件だけ」だけを見ると、**常に同じ 1 件を出し続ける**実装で通る ──
   *   送った先が**別の id** であることまで見る。
   */
  it('🔴 出るのは 1 件だけ ── 新しい順に、送ると次が出る', () => {
    const a = createAnnounce(region, new NoticeStore(memory()), NOTES);
    a.present();
    expect(region.hidden, '出ていない').toBe(false);
    expect(onScreen(), '1 件ずつではない(積んでいる)').toEqual(['2026-08-08-b']);
    expect(region.textContent, '本文が出ていない').toContain('あたらしい話');
    // ⚠ 閉じたら二度と読めない、と思わせない
    expect(region.textContent, 'あとから読める場所を書いていない').toContain('ヘルプ');

    a.next();
    expect(onScreen(), '送っても次が出ない').toEqual(['2026-01-01-a']);
    expect(region.textContent, '次の本文が出ていない').toContain('ふるい話');
    // 🔑 **送っただけでは畳まない**(畳むのは「閉じる」と、残り 0 件のときだけ)
    expect(region.hidden, '送っただけで帯が消えた').toBe(false);
  });

  /**
   * 🔴 **送るのは「その 1 件だけ」を既読にする。**
   * ⚠ ここを `shown` 全部にすると、1 回押しただけで残り全部が消える ──
   *   user は 1 件しか読んでいないのに、9 件が黙って既読になる。
   */
  it('🔴 送ると、いま出ている 1 件だけが既読になる', () => {
    const store = new NoticeStore(memory());
    const a = createAnnounce(region, store, NOTES);
    a.present();
    a.next();
    expect(store.seenIds(), '読んでいない分まで既読にした').toEqual(['2026-08-08-b']);
  });

  /** 🔴 最後の 1 件を送ったら畳む(空の枠を残さない)。 */
  it('🔴 最後の 1 件を送ると、帯が畳まれる', () => {
    const store = new NoticeStore(memory());
    const a = createAnnounce(region, store, NOTES);
    a.present();
    a.next();
    // ⚠ 空振り防止 ── ここで既に畳まれていたら、下の assert は自明に通る
    expect(region.hidden, '2 件目が出ていない(前提が崩れている)').toBe(false);
    a.next();
    expect(region.hidden, '最後まで送っても帯が残っている').toBe(true);
    expect([...store.seenIds()].sort(), '全部を読んだのに既読になっていない').toEqual(
      NOTES.map((n) => n.id).sort(),
    );
  });

  /**
   * 🔴 **帯が出した登記表が、そのまま既読の席を守る側へ渡る**
   * (2026-08-29 の変異試験 M7 が SURVIVED で教えた)。
   *
   * ⚠ 既定の配線では帯が出すのも席を守るのも `NOTICES` なので、**渡し忘れても
   *   結果が同じ**になり、既存の台では 1 度も見えなかった
   *   (CLAUDE.md §7「同じ値が 2 か所にある」/ 2026-08-27「前も後も通るなら守っていない」)。
   * 🔑 だから **`NOTICES` に 1 件も入っていない登記表**で帯を組み、
   *   閉じたあとに**その分が既読の席に残っている**ことを見る。
   *   ⚠ 渡っていなければ「登記表に無い id」として真っ先に捨てられる。
   */
  it('🔴 帯に渡した登記表が、既読の席を守る側にも渡る', () => {
    const store = new NoticeStore(memory());
    const a = createAnnounce(region, store, NOTES);
    // 席を溢れさせる ── 溢れなければ取捨が起きず、渡し忘れても結果が同じ(空振り)
    const top = NOTES.map((n) => n.id).sort().at(-1) ?? '';
    store.markSeen(
      Array.from({ length: NOTICE_SEEN_MAX }, (_, i) => `${top}-zz${i}`),
      NOTES,
    );
    a.present();
    a.dismiss();

    const seen = new Set(store.seenIds());
    expect(store.seenIds(), '切り詰めが起きていない(台の空振り)').toHaveLength(NOTICE_SEEN_MAX);
    expect(
      NOTES.filter((n) => !seen.has(n.id)).map((n) => n.id),
      '帯に出した分が既読から落ちた ── 登記表が渡っていない',
    ).toEqual([]);
  });

  /**
   * 🔴 **押せない導線を作らない。** 残り 1 件で「次へ」を出すと、
   * 押しても何も起きない(= 無言の dead click)。
   */
  it('⚠ 残り 1 件のときは「次へ」を出さない', () => {
    const a = createAnnounce(region, new NoticeStore(memory()), NOTES);
    a.present();
    // ⚠ 空振り防止 ── 2 件のときは在ること(無ければ下は自明に通る)
    expect(
      region.querySelector('[data-pkc-action="next-announce"]'),
      '2 件あるのに「次へ」が無い',
    ).not.toBeNull();
    a.next();
    expect(
      region.querySelector('[data-pkc-action="next-announce"]'),
      '残り 1 件なのに「次へ」が出ている(押しても何も起きない)',
    ).toBeNull();
    expect(
      region.querySelector('[data-pkc-action="dismiss-announce"]'),
      '閉じる導線まで消えた',
    ).not.toBeNull();
  });

  /**
   * 🔴 **送った後も焦点が帯に残る**(CLAUDE.md §10「閉じたら焦点を返す」)。
   *
   * ⚠ 送るたびに帯を描き直す = **押したボタンごと消える**ので、何もしないと
   *   焦点が `<body>` へ落ちる ── 鍵で読み進める user は **2 件目で止まる**。
   * ⚠ 対照群を同じ it に置く(帯の外に焦点が在るなら**奪わない**)──
   *   置かないと「常に focus する」実装が通り、作業中の入力欄から焦点を盗む。
   */
  it('🔴 送っても焦点が帯に残る(鍵で読み進められる)', () => {
    const a = createAnnounce(region, new NoticeStore(memory()), NOTES);
    a.present();
    const next = region.querySelector<HTMLElement>('[data-pkc-action="next-announce"]')!;
    next.focus();
    expect(document.activeElement, '前提: 「次へ」に焦点が無い').toBe(next);
    a.next();
    expect(
      region.contains(document.activeElement),
      '送ったら焦点が帯の外へ落ちた(鍵で次が押せない)',
    ).toBe(true);

    // 🔑 対照群 ── 帯の外に焦点が在るときは奪わない
    const outside = document.createElement('input');
    document.body.append(outside);
    const a2 = createAnnounce(region, new NoticeStore(memory()), NOTES);
    a2.present();
    outside.focus();
    expect(document.activeElement, '前提: 外に焦点が無い').toBe(outside);
    a2.next();
    expect(document.activeElement, '作業中の欄から焦点を奪った').toBe(outside);
  });

  /**
   * 🔴 **残りの件数が減る。** 1 件ずつ出す以上、「あと何件あるか」は
   * 見出しの数字が**唯一の手掛かり**である。
   * ⚠ 「2 件と出る」だけでは、**数が動かない**実装(常に総数を出す)が通る。
   */
  it('🔴 見出しの残り件数が、送るたびに減る', () => {
    const head = (): string =>
      region.querySelector('[data-pkc-field="announce-title"]')?.textContent ?? '';
    const a = createAnnounce(region, new NoticeStore(memory()), NOTES);
    a.present();
    expect(head(), '残り件数が出ていない').toContain('残り 2 件');
    a.next();
    expect(head(), '残り 1 件でまだ件数を出している').not.toContain('2 件');
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

  /**
   * 🔴 **閉じるは、流れる箱の外に在る**(#151、2026-08-14 の実機報告)。
   *
   * ⚠ 「導線が在る」だけの上の test は、**壊れていても通っていた** ──
   * 閉じるは本文・案内文のあとに在り、面は `max-height: 30vh` で中を流すので、
   * お知らせが 2 件も在れば**箱の中で見切れて**いた(実機で「閉じ方が分からない」)。
   * 🔑 だから見るのは**在るか**ではなく**どこに在るか**である ──
   * 流れるのは `announce-body` だけなので、閉じるが**その中に居ないこと**を pin する。
   * ⚠ 実際に見えているか(高さ・重なり)は DOM では測れない ── smoke が見る
   * (`tests/smoke/help-announce.smoke.spec.ts`)。
   */
  it('🔴 閉じるは見出しの行に在り、流れる本文の中に入っていない', () => {
    createAnnounce(region, new NoticeStore(memory()), NOTES).present();
    const close = region.querySelector('[data-pkc-action="dismiss-announce"]')!;
    const head = region.querySelector('[data-pkc-field="announce-title"]')!;
    const body = region.querySelector('[data-pkc-field="announce-body"]')!;
    // ⚠ 空振り防止 ── 本文の箱そのものが在ること(無ければ下の 2 つは自明に通る)
    expect(body, '流れる本文の箱が無い').not.toBeNull();
    expect(head.contains(close), '閉じるが見出しの行に無い').toBe(true);
    expect(body.contains(close), '閉じるが流れる箱の中に在る(見切れる)').toBe(false);
    // 🔑 **順も pin する** ── 見出しを本文の後ろへ回すと、包含関係は保ったまま
    //    「見出し」が本文の下に出る(マニュアルの「見出しに在るので」が嘘になる)
    expect(
      head.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING,
      '見出しが本文より後ろに在る',
    ).toBeTruthy();
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
  it('次へ / 閉じる / 今後は出さない / 設定の切替が、それぞれの受け手を呼ぶ', () => {
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
      nextAnnounce: () => calls.push('next'),
      muteAnnounce: () => calls.push('mute'),
      setNoticesEnabled: (on) => calls.push(`set:${String(on)}`),
    });

    // ⚠ 「次へ」は 2 件以上のときだけ出る ── NOTES は 2 件なので在る
    root.querySelector<HTMLElement>('[data-pkc-action="next-announce"]')!.click();
    root.querySelector<HTMLElement>('[data-pkc-action="dismiss-announce"]')!.click();
    root.querySelector<HTMLElement>('[data-pkc-action="mute-announce"]')!.click();
    const box = root.querySelector<HTMLInputElement>('[data-pkc-field="notices-enabled"]')!;
    // ⚠ **押した後の値**を渡すこと(反転して渡す変異をここで殺す)
    box.checked = false;
    box.click(); // click は checked を反転させる → true
    expect(calls, '受け手が呼ばれていない / 値が反転している').toEqual([
      'next',
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

  /**
   * 🔴 **戻す側もその場で効く**(2026-08-08、レビュー指摘)。
   * ⚠ 直す前は `if (!on)` だけで、**切る側は即座に効き、戻す側は次の起動まで
   *   効かなかった**。test も `false` しか呼んでいなかったので誰も気づかない。
   */
  it('🔴 設定から戻すと、その場で帯が出直す', () => {
    const store = new NoticeStore(memory());
    store.setEnabled(false);
    const a = createAnnounce(region, store, NOTES);
    const s = announceServices(a, store);
    s.setNoticesEnabled(true);
    expect(store.enabled(), '設定を保存していない').toBe(true);
    expect(region.hidden, '戻したのに帯が出ない(次の起動まで効かない)').toBe(false);
  });

  /** ⚠ 未読が無ければ、戻しても空の枠は立たない。 */
  it('⚠ 戻しても、未読が無ければ何も出ない', () => {
    const store = new NoticeStore(memory());
    store.markSeen(NOTES.map((n) => n.id));
    store.setEnabled(false);
    const a = createAnnounce(region, store, NOTES);
    announceServices(a, store).setNoticesEnabled(true);
    expect(region.hidden, '読んだものが出直した').toBe(true);
  });

  it('🔴 閉じるは既読にする(hide にすり替わっていない)', () => {
    const store = new NoticeStore(memory());
    const a = createAnnounce(region, store, NOTES);
    a.present();
    announceServices(a, store).dismissAnnounce();
    expect(store.seenIds(), '閉じても既読にならない').toHaveLength(2);
  });

  /**
   * 🔴 **「次へ」は畳まない**(#475)。⚠ `dismiss` にすり替える変異は、
   *   「既読になった」しか見ない test では殺せない ── **帯が残ること**と
   *   **残りが既読になっていないこと**を対で見る。
   */
  it('🔴 「次へ」は 1 件だけ進める(閉じるにすり替わっていない)', () => {
    const store = new NoticeStore(memory());
    const a = createAnnounce(region, store, NOTES);
    a.present();
    announceServices(a, store).nextAnnounce();
    expect(region.hidden, '送っただけで帯が畳まれた').toBe(false);
    expect(store.seenIds(), '残りまで既読にした').toEqual(['2026-08-08-b']);
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
     * 🔴 **版面は 9 つある** ── 広い / 1100px 以下 / 720px 以下の 3 つに加えて、
     * #197(ペインを畳む)で 左だけ / 右だけ / 両方畳んだ の 3 つ、さらに
     * **#607(2026-08-30)で狭い 2 帯にも畳んだ版面**が 3 つ増えた
     * (1100px 以下に 2 つ / 720px 以下に 1 つ ── 720px は 3 通りを 1 規則にまとめた)。
     *
     * ⚠ #607 は「**数だけ書き換えると検査ごと骨抜きになる**」と警告していたが、
     *   下の `for (const areas of layouts)` が**版面ごとに全幅の帯を見る**ので、
     *   増えた 3 つも自動的に検められる ── 骨抜きにはならない。
     * 🔑 それでも数を pin し続けるのは、**版面を足した人がここで必ず気づく**ためである。
     * ⚠ 1 巡目は `exec` で**最初の 1 つしか読んでおらず**、狭い 2 つの版面から
     *   帯の行を消す変異が素通りした(変異試験で判明)。
     * ⚠ **数を実数で pin する** ── 版面を足した人がここで必ず気づく
     *   (畳んだ版面から帯の行を落とすと、user は保存エラーを見られなくなる)。
     */
    /**
     * ⚠ **注釈を先に落とす**(2026-08-29)。ここは「行が**在る**」ことの主張なので、
     *   CLAUDE.md §1 の作法どおり**コメントは検査を満たしてしまう** ──
     *   区画の行を消しても、同じ名前を書いた注釈が残っていれば 1 行と数えられ、
     *   **緑のまま帯が版面から落ちる**。
     * ⚠ 剥ぐのは **`stripComments`**(`css-blocks.ts`)── CSS の正本はこちらである。
     *   `codeOnly` は JS/TS 用で、`url(//cdn/x.png)` のような `:` の付かない `//` を
     *   **行末まで削る**(`code-only.ts` の docstring がそう戒めている)。
     */
    const layouts = [...stripComments(css).matchAll(/grid-template-areas:\s*([^;]+);/g)].map(
      (m) => m[1] ?? '',
    );
    /**
     * ⚠ **2026-09-02 に 9 → 8**(#632 段①)── `@media (max-width: 720px)` の
     *   版面 2 つ(素の 1 列 / 畳んだ 1 列)が消え、スマホ用画面の 1 つが増えた。
     *   スマホでは畳みを画面へ写さない(`applyPaneVisibility` のガード)ので、
     *   「畳んだときの 1 列」という版面がそもそも要らなくなった。
     */
    expect(layouts, '版面を全部読めていない(空振り)').toHaveLength(8);
    /**
     * 🔑 **名前は手で並べず、いちばん広い版面から引く** ── 1 行を丸ごと
     *   占めている区画(全部のセルが同じ名前)が「全幅の帯」である。
     * ⚠ 手で並べると、帯を足した人がここを広げ忘れる(実際 #413 で 3 本ぶん忘れた)。
     * ⚠ 数は**実数で pin する** ── 引き方が壊れて 0 件になったら気づけない。
     */
    const rowsOf = (areas: string): string[][] =>
      areas
        .split('\n')
        .map((l) => l.trim().replace(/^'|'$/g, '').split(/\s+/).filter(Boolean))
        .filter((cells) => cells.length > 0);
    const FULL_WIDTH_AREAS = rowsOf(layouts[0] ?? '')
      .filter((cells) => cells.length > 1 && cells.every((c) => c === cells[0]))
      .map((cells) => cells[0]!);
    expect(
      FULL_WIDTH_AREAS,
      '全幅の帯を引けていない(空振り)。帯を増減したらこの数も直す',
    ).toEqual(['capture', 'timers', 'alarms', 'announce', 'update', 'notices', 'status']);
    /**
     * 🔴 **宣言した名前が、どれも基準の版面に出ていること**(2026-08-29 の着地前レビュー)。
     *
     * ⚠ 上の `FULL_WIDTH_AREAS` は**基準の版面から**引くので、
     *   「**基準にも書き忘れた**」型の事故(= #413 の一段深い形)には鳴らない。
     * 🔑 だから**宣言の側**(`grid-area: x`)と突き合わせる ── 除外リストを
     *   持たずに済む形にしてある(手で並べた瞬間、また広げ忘れる)。
     */
    const declared = new Set(
      [...stripComments(css).matchAll(/grid-area:\s*([a-z-]+)\s*;/g)].map((m) => m[1]!),
    );
    const inBase = new Set(rowsOf(layouts[0] ?? '').flat());
    expect(declared.size, '`grid-area:` を引けていない(空振り)').toBeGreaterThan(7);
    expect(
      [...declared].filter((n) => !inBase.has(n)).sort(),
      '`grid-area:` で宣言したのに、基準の版面に置いていない区画がある(暗黙のトラックへ落ちる)',
    ).toEqual([]);
    /**
     * 🔴 **伸びるのは本文の行だけ**(2026-08-29 の着地前レビュー、変異 M3)。
     *
     * ⚠ 上のセル検査は「どの行がどの区画か」しか見ないので、**行の並びを
     *   入れ替える**変異が生き延びた ── `grid-template-rows` の `1fr` が
     *   `detail` ではなく `capture` に当たると、**狭い窓で本文が中身の高さまで縮み**、
     *   帯だけが伸びる。⚠ **区画の名前は 1 つも変わらない**ので、名前を見る検査は全部緑。
     * 🔑 **`1fr` の位置と、`detail` を含む行の位置が一致すること**を見る。
     * ⚠ `grid-template-rows` を書いていない版面は継承なので対象外 ── ただし
     *   「1 つも見つからない」= 引き方が壊れた、なので**数を実数で pin する**。
     */
    const withRows = [
      ...stripComments(css).matchAll(
        /grid-template-areas:\s*([^;]+);\s*grid-template-rows:\s*([^;]+);/g,
      ),
    ];
    expect(withRows.length, '行の丈を宣言している版面を引けていない(空振り)').toBe(1);
    /**
     * ⚠ **括弧の中で切らない**(2026-09-02)── `minmax(0, 1fr)` は空白を含むので、
     *   素の `split(/\s+/)` では **1 本の丈が 2 本に割れて**「丈の数と行数が合わない」で
     *   落ちる。🔑 スマホ用画面は素の `1fr` ではなく `minmax(0, 1fr)` を使う
     *   (素の `1fr` = `minmax(auto, 1fr)` なので、**重ねた 3 面のうち背の高い面の
     *   min-content が行を押し広げ**、本文が画面の外へ出る)。
     */
    const tracksOf = (v: string): string[] => {
      const out: string[] = [];
      let depth = 0;
      let cur = '';
      for (const ch of v.trim()) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (depth === 0 && /\s/.test(ch)) {
          if (cur !== '') out.push(cur);
          cur = '';
        } else cur += ch;
      }
      if (cur !== '') out.push(cur);
      return out;
    };
    for (const m of withRows) {
      const rows = rowsOf(m[1] ?? '');
      const tracks = tracksOf(m[2] ?? '');
      expect(tracks.length, '丈の数と区画の行数が合っていない').toBe(rows.length);
      // ⚠ 伸びる丈は **1 本だけ**(2 本あると「どちらが本文か」が読めない)
      expect(
        tracks.filter((t) => t.includes('1fr')).length,
        '伸びる行が 1 本ではない',
      ).toBe(1);
      expect(
        tracks.findIndex((t) => t.includes('1fr')),
        '伸びる行が本文(detail)ではない ── 狭い窓で本文が縮み、帯だけが伸びる',
      ).toBe(rows.findIndex((cells) => cells.includes('detail')));
    }
    for (const areas of layouts) {
      /**
       * 🔴 **全幅の帯は 7 本ある**(2026-08-29 に 3 → 7 へ広げた)。
       *
       * ⚠ 直す前は `announce` / `update` / `notices` の **3 つしか見ておらず**、
       *   #413 で足した **`capture` / `timers` / `alarms` が誰にも守られていなかった** ──
       *   実際に 1100px 以下と 720px 以下の版面から 3 行とも落ちており、
       *   帯は暗黙の列へ化けて**互いに重なり、480px では画面の外**に出ていた
       *   (`app.css:287` の「止める口が消えると、マイクが回り続ける」が破れていた)。
       * 🔑 **`grid-area:` を宣言している名前を数え上げて、その全部を見る**
       *   ── 名前を手で並べると、次に足した人がまたここを広げ忘れる。
       */
      /**
       * 🔴 **「行が在る」ではなく「行を丸ごと占めている」まで見る**
       *   (2026-08-29 の着地前レビューが 3 つの変異で突いた)。
       *
       * ⚠ 直す前は `l.includes(name)` で**セルを 1 つも読んでいなかった**ので、
       *   次がどれも**緑のまま**通った:
       *   ① `'capture capture xx'` → 収録の帯が**画面幅の 2/3** になる
       *   ② `'alarms gripl gripl'` → 非矩形になり**版面が丸ごと無効**になる
       *   ③ 行の**並び**を入れ替える → `1fr` が本文以外に当たる(下の別 assert で見る)
       * 🔑 セル数と中身の両方を等値で見る ── 「その名前だけが、器の端から端まで」。
       */
      const grid = rowsOf(areas);
      const cols = grid[0]?.length ?? 0;
      expect(cols, `版面のセルを読めていない(空振り)`).toBeGreaterThan(0);
      for (const name of FULL_WIDTH_AREAS) {
        const rows = grid.filter((cells) => cells.includes(name));
        expect(rows, `${name} の行が 1 つではない版面がある`).toHaveLength(1);
        expect(
          rows[0],
          `${name} が全幅を占めていない版面がある(帯が器の一部にしか出ない)`,
        ).toEqual(Array.from({ length: cols }, () => name));
      }
    }
  });

  /**
   * 🔴 **お知らせと注意は同じ形**(#151。「同じものは同じ場所に在る」)。
   *
   * どちらも `max-height: 30vh` の帯で、中身が溢れうる。**流れてよいのは
   * 読むものだけ**で、閉じる導線を流してはいけない ── お知らせ側で実機報告された
   * 欠陥(閉じるが箱の中で見切れる)の同型が、注意側にも在った。
   *
   * ⚠ **実ブラウザで見ているのはお知らせ側だけ**である(注意の帯を溢れさせるには
   * 200 件級の取込が要る)。ここは**構造が揃っていること**を静的に pin する ──
   * 片方だけ直す変更をこの test が落とす。
   * ⚠ コメントを剥いでから読む(注記の中の字面に当てない)。
   */
  it('🔴 お知らせと注意は同じ形 ── 流れるのは中身だけで、見出しは固定', async () => {
    const raw = await import('node:fs').then((fs) =>
      fs.readFileSync('src/styles/app.css', 'utf-8'),
    );
    /**
     * ⚠ **`@media` の中まで拾わない**(レビュー 2026-08-14)。
     * 「どれかに在ればよい」という主張なので、印刷や狭い版面だけの規則で
     * **画面の規則を消しても緑**になりうる。この file は「`@media` は最後に置く」
     * 規約なので、最初の `@media` で切る ── ⚠ 規約が破れたら**落ちる**側に倒れる。
     */
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    const at = stripped.indexOf('@media');
    expect(at, '@media が 1 つも無い(規約が変わった可能性)').toBeGreaterThan(0);
    const css = stripped.slice(0, at);
    /**
     * ⚠ **同じ selector の規則は 1 つとは限らない。** 1 稿目は
     * `indexOf` で最初の 1 つだけ読み、**版面の `grid-area` の規則**に当たって
     * 落ちた ── 隣の test が戒めているのと同じ罠を、同じ file で踏んだ。
     * ⚠ 2 稿目は `"${sel} {"` で探したので、**選択子リスト**
     * (`A,\nB {`)に書いた規則を 1 つも拾えなかった(空振りで落ちて判明)。
     * 🔑 **構文で拾う** ── `選択子 { 宣言 }` を全部読み、選択子リストを
     * `,` で割って**丸ごと一致**を見る。部分一致より厳密である
     * (`A > button` を A の規則と読み違えない)。
     */
    const block = (selector: string): string => {
      const found: string[] = [];
      const re = /([^{}]+)\{([^{}]*)\}/g;
      for (let m = re.exec(css); m; m = re.exec(css)) {
        const sels = (m[1] ?? '').split(',').map((x) => x.trim());
        if (sels.includes(selector)) found.push(m[2] ?? '');
      }
      expect(found.length, `${selector} の規則が無い(空振り)`).toBeGreaterThan(0);
      return found.join('\n');
    };

    for (const region of ["[data-pkc-region='announce']", "[data-pkc-region='notices']"]) {
      /**
       * ⚠ **`flex-direction` だけでは足りない**(レビュー 2026-08-14、実際に
       * 変異を当てて生存を確認された)。`display: flex` を消すと
       * `flex-direction` は無効になり、中身が縮まなくなって**帯ごと流れる**
       * = #151 で直した欠陥が戻る。宣言を名指しで全部見る。
       */
      expect(block(region), `${region} が flex になっていない`).toMatch(/display:\s*flex/);
      expect(block(region), `${region} が縦並びの箱になっていない`).toMatch(
        /flex-direction:\s*column/,
      );
      // ⚠ 高さを切っていないと、そもそも溢れず本文の 1fr を食う(P8 段㉒)
      expect(block(region), `${region} の高さが青天井`).toMatch(/max-height:\s*30vh/);
      // ⚠ 逃げ場(低い画面で中身がこぼれない)
      expect(block(region), `${region} に逃げ場が無い`).toMatch(/overflow:\s*auto/);
    }
    /**
     * 🔑 **見出しの行が flex でなければ、右端へ寄せる規則は 1 行も効かない**
     * (`margin-inline-start: auto` は inline-level では 0 に解決される)。
     * ⚠ 字面と貼り付きも、寄せ直すときに落としやすい ── 実際 1 稿目で
     * `font-weight` を落とし、見出しが中の見出しより細くなっていた。
     */
    for (const head of [
      "[data-pkc-field='announce-title']",
      "[data-pkc-field='notices-title']",
    ]) {
      expect(block(head), `${head} が flex の行になっていない`).toMatch(/display:\s*flex/);
      expect(block(head), `${head} の見出しが太字でない`).toMatch(/font-weight:\s*600/);
      expect(block(head), `${head} が送っても残らない`).toMatch(/position:\s*sticky/);
    }
    // 🔑 **流れるのは中身のほう** ── これが無いと帯ごと流れて見出しが消える
    for (const scroller of ["[data-pkc-field='announce-body']", "[data-pkc-region='notices'] ul"]) {
      expect(block(scroller), `${scroller} が流れない`).toMatch(/overflow:\s*auto/);
    }
    // 🔑 **閉じるは右端**(お知らせの文面とマニュアルがそう書いている)
    expect(css, '閉じるを右端へ寄せる規則が無い').toMatch(
      /\[data-pkc-field='notices-title'\]\s*>\s*button\s*\{[^}]*margin-inline-start:\s*auto/,
    );
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

/**
 * 🔴 **配ったお知らせの文面は、あとから書き換えても届かない**(#220-7)。
 *
 * 既読は **id の集合**である(`unreadNotices`)。だから既に配った entry の文面を
 * その場で直しても、**その id を閉じた user はもう見ない** ── #219 で実際にやった
 * (2026-08-16 の entry の 1 行を書き換えた)。id を振り直すのも禁じ手
 * (`.claude/skills/notice-writing/SKILL.md`「id は既読の鍵」)。
 *
 * 🔑 だから **文面を等値 pin** して、書き換えたら**必ず落ちる**ようにする。
 * 落ちたときの選択肢は 2 つしかない:
 *   ① 挙動が変わったなら **新しい entry を足す**(既読の user にも帯で届く)
 *   ② 誤字直し等で届かなくてよいなら、**この表を更新する**(= 届かないと認める)
 * ⚠ どちらも「気づかずに書き換える」ことだけを防ぐ形である。
 */
describe('お知らせの文面は固定(#220-7)', () => {
  /** id → 文面(題名 + items)の digest。⚠ **足したら 1 行足す**。 */
  const KNOWN: readonly [string, string][] = [
    ['2026-09-05-editing-buttons-and-labels', '8984f7c3'],
    ['2026-09-05-local-dates', '264b389c'],
    ['2026-09-05-note-window-polish', '431fe10e'],
    ['2026-09-05-apps-in-windows', '2b5dc69f'],
    ['2026-09-05-phone-dual-polish', '8815c548'],
    ['2026-09-05-attach-polish', '52c8e543'],
    ['2026-09-05-blocks-and-boards', 'cec7cdf8'],
    ['2026-09-05-manual-window-polish', '26cabf2f'],
    ['2026-09-05-office-macros-keep', 'c4dd292d'],
    ['2026-09-05-diagram-picker', '3b467985'],
    // ⚠ 落とした entry の注記(訂正の経緯)は CHANGELOG と git の履歴に在る ── ここには残さない
  ];

  const digest = (n: { title: string; items: readonly string[] }): string =>
    createHash('sha256').update(JSON.stringify([n.title, n.items])).digest('hex').slice(0, 8);

  it('🔴 既に配った文面が変わっていない(変えても既読の user には届かない)', () => {
    // 空振り防止 ── 表が空 / 件数が食い違う形で「全部一致した」と言わない
    expect(KNOWN.length, '登記表と表の件数が違う ── 足した entry を表に足していない').toBe(
      NOTICES.length,
    );
    const map = new Map(KNOWN);
    const drift: string[] = [];
    for (const n of NOTICES) {
      const want = map.get(n.id);
      if (want === undefined) {
        drift.push(`${n.id}: 表に無い(足したなら ['${n.id}', '${digest(n)}'] を足す)`);
        continue;
      }
      if (want !== digest(n))
        drift.push(
          `${n.id}: 文面が変わっている(${want} → ${digest(n)})` +
            ' ── 挙動が変わったなら新しい entry を足す。届かなくてよいならこの表を直す',
        );
    }
    expect(drift).toEqual([]);
  });
});

/**
 * 🔴 **登記表に在るものは、全部アプリから読める**(#596 E ── 案⑴)。
 *
 * ## 直す前(2026-08-29 の実測)
 *
 * 登記表は **20 件**持つのに、帯もヘルプも **10 件**しか出さなかった
 * (`recentNotices` の既定 = `NOTICE_SHOW_MAX`)── つまり **10 件が
 * アプリのどこからも読めない**まま配られていた(今日配ったものの半分を含む)。
 * ⚠ 足した人には見えない ── 1 件足すと、いちばん古い 1 件が**黙って窓の外へ出る**。
 *
 * ## 直した形
 *
 * 🔑 `NOTICE_KEEP_MAX` を `NOTICE_SHOW_MAX` と**同じ数**にした。
 *   ⚠ 2 倍だった理由は「**原本は残す**」だが、その役目はいま `CHANGELOG.md` が担う。
 *   ⚠ **user から見える所は 1px も変わらない**(その 10 件はもともと出ていない)。
 *
 * ## だから守るのは「押し出しの一覧」ではなく「押し出しが起きないこと」
 *
 * ⚠ 1 稿目は**読めない entry を等値で名指し**する形だった ── それは
 *   「読めないものが在る」を**前提にした**計器である。前提ごと消したので、
 *   **0 件であること**を見る形へ書き換えた。
 */
describe('登記表と画面のずれ(#596 E)', () => {
  it('🔴 どこにも出ない entry が 1 件も無い', () => {
    const shown = new Set(recentNotices(NOTICES).map((n) => n.id));
    expect(
      NOTICES.filter((n) => !shown.has(n.id)).map((n) => n.id),
      'アプリから読めない entry が生まれた ── 登記表を切るか、出す数を増やす',
    ).toEqual([]);
  });

  it('⚠ 空振り防止 ── 登記表も出る側も、本当に中身がある', () => {
    // ⚠ 0 件どうしなら上の検査は常に真になる
    expect(NOTICES.length, '登記表が空(空振り)').toBeGreaterThanOrEqual(5);
    expect(recentNotices(NOTICES)).toHaveLength(NOTICES.length);
  });

  /**
   * 🔴 **上限を超えたら、超えた分が読めなくなる**ことを、その場で見せる。
   * ⚠ これが無いと「登記表を 11 件にしても誰も鳴らない」── 上の検査は
   *   `recentNotices` を通すので、**11 件目が黙って落ちる**だけである。
   */
  it('🔴 上限を 1 件超えると、いちばん古い 1 件が読めなくなる(だから超えさせない)', () => {
    /**
     * ⚠ **足すのは先頭である**(2026-08-29 の着地前レビュー C)。
     *   1 稿目は末尾へ足していたが、手順書は「`NOTICES` の**先頭**に 1 件足す」
     *   (`.claude/skills/notice-writing/SKILL.md`)── 末尾に足す形は**現実には起きない**。
     * 🔑 そして実際に落ちるのは「足した分」ではなく **いちばん古い既存の 1 件**である
     *   ── 足した人から見て**自分が押し出した物が見えない**のが、この欠陥の顔だった。
     */
    /**
     * ⚠ **日付は「いちばん新しい既存 entry より後」にする**(2026-09-02 に直した)。
     *   `recentNotices` は id(= 日付が前置き)の降順で切るので、fixture が
     *   古い日付だと**押し出されるのは fixture 自身**になり、この test は
     *   「足した分が見えない」を主張してしまう(空振りではないが、**別の主張**)。
     */
    const over = [
      { id: '2026-12-31-over', title: '新しく足した分', items: ['先頭に足しました。'] },
      ...NOTICES,
    ];
    const shown = new Set(recentNotices(over).map((n) => n.id));
    expect(over.filter((n) => !shown.has(n.id)).map((n) => n.id)).toEqual([
      NOTICES[NOTICES.length - 1]!.id,
    ]);
  });
});
