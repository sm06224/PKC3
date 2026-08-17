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
import { bindActions } from '../../src/adapter/ui/actions/binder';
import type { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState } from '../../src/adapter/state/app-state';
import { NOTICES, NOTICE_SHOW_MAX, type Notice } from '../../src/features/notice/notice-log';

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
     * 🔴 **版面は 6 つある** ── 広い / 1100px 以下 / 720px 以下の 3 つに加えて、
     * #197(ペインを畳む)で 左だけ / 右だけ / 両方畳んだ の 3 つが増えた。
     * ⚠ 1 巡目は `exec` で**最初の 1 つしか読んでおらず**、狭い 2 つの版面から
     *   帯の行を消す変異が素通りした(変異試験で判明)。
     * ⚠ **数を実数で pin する** ── 版面を足した人がここで必ず気づく
     *   (畳んだ版面から帯の行を落とすと、user は保存エラーを見られなくなる)。
     */
    const layouts = [...css.matchAll(/grid-template-areas:\s*([^;]+);/g)].map((m) => m[1] ?? '');
    expect(layouts, '版面を全部読めていない(空振り)').toHaveLength(6);
    for (const areas of layouts) {
      for (const name of ['announce', 'update', 'notices']) {
        const rows = areas.split('\n').filter((l) => l.includes(name));
        expect(rows, `${name} の行が 1 つではない版面がある`).toHaveLength(1);
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
    ['2026-08-17-word-export-page', '0bb5cbb5'],
    ['2026-08-17-word-export-figures', 'c569e98b'],
    ['2026-08-17-word-export-images', '235a2980'],
    ['2026-08-17-word-export', '4454a5dd'],
    ['2026-08-17-office-save-same-note', 'ed2e27ba'],
    ['2026-08-16-office-save-to-pkc', '3cdb4883'],
    ['2026-08-16-pdf-viewer', '14ad159e'],
    ['2026-08-16-live-row-box', '5d66f0d8'],
    ['2026-08-16-slim-ui', 'bdae224d'],
    ['2026-08-15-query-view', 'd29834b1'],
    ['2026-08-15-relations', '08672341'],
    ['2026-08-15-chart-fence', '0712f044'],
    ['2026-08-15-nav-and-panes', '265437d9'],
    ['2026-08-15-search-sort-tags', '84c6fe93'],
    ['2026-08-15-multi-tab', 'e2df18fa'],
    ['2026-08-14-asset-ref-link', '6f84d26c'],
    ['2026-08-14-live-editor-default', '7cdcef0b'],
    ['2026-08-14-attachment-doc-align', '69d4a0c6'],
    ['2026-08-14-office-tile', 'de2b82b9'],
    ['2026-08-14-office-mouse-select', '30f84355'],
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
