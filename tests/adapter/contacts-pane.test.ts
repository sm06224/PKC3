/** @vitest-environment happy-dom */
/**
 * 🔴 **連絡先の面**(#278 段①)。
 *
 * ⚠ 見るのは **user が何を見て、何を押せるか** ──
 *   ①「まだ」と「駄目だった」を取り違えない ②押せない宛先をボタンにしない
 *   ③切ったことを黙らない。
 */
import { describe, expect, it } from 'vitest';
import { ContactsRenderer } from '../../src/adapter/ui/render/contacts';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { CONTACT_LIMITS, type ContactScan } from '../../src/features/contact/contact-card';
import { BROWSE_MODES, isBrowseMode } from '../../src/adapter/ui/render/browse-mode';
import { BROWSE_TABS } from '../../src/adapter/ui/render/browse';
import { BROWSE_ICONS } from '../../src/adapter/ui/render/icons';

const card = (lid: string, name: string, tels: string[] = [], emails: string[] = [], org = '') => ({
  lid,
  name,
  org,
  tels,
  emails,
  birthday: '',
  orgParts: org === '' ? [] : org.split(' '),
  overlong: false,
});

const scanOf = (cards: ReturnType<typeof card>[], truncated = false): ContactScan => ({
  cards,
  totalNotes: cards.length,
  scannedNotes: cards.length,
  truncated,
});

function paint(state: Partial<AppState>): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  new ContactsRenderer(host).render({ ...initialState, ...state } as AppState);
  return host;
}

const note = (host: HTMLElement): string =>
  host.querySelector('[data-pkc-field="contacts-note"]')?.textContent ?? '';
const rows = (host: HTMLElement): HTMLElement[] =>
  [...host.querySelectorAll<HTMLElement>('[data-pkc-contact]')];

describe('連絡先の面(#278)', () => {
  it('🔴 「まだ集めていない」と「集められなかった」を取り違えない', () => {
    // ⚠ 取り違えると、面が「集めています…」を出したまま**永久に止まって見える**
    expect(note(paint({ contactScan: null })), 'まだ集めていない').toContain('集めています');
    expect(
      note(paint({ contactScan: null, contactScanFailed: true })),
      '駄目だったのに「集めています」と出ている',
    ).toContain('集められませんでした');
  });

  /**
   * 🔴 **同じ器に 2 回描かせる**(2 巡目の着地前レビュー 2026-08-28)。
   *
   * ⚠ 上の test は `paint()` を**別々に**呼ぶので、毎回新品の renderer になり
   *   **早期 return の経路を 1 度も通っていなかった**(CLAUDE.md §2)。
   *   実物は器を使い回す(`browse.ts` が `ContactsRenderer` を 1 個持つ)ので、
   *   指紋が一致すると **DOM が 1 バイトも書き換わらない**。
   * ⚠ 直す前の指紋は `scan === null` を先に見ていたため、
   *   「まだ集めていない」と「初回が失敗した」が**同じ字**になり、
   *   断り文が**一度も画面に出なかった**(= 永久に「集めています…」)。
   */
  it('🔴 集められなかったら、同じ器でも断り文に入れ替わる(永久に「集めています」にしない)', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const r = new ContactsRenderer(host);
    r.render({ ...initialState, contactScan: null } as AppState);
    expect(note(host)).toContain('集めています');
    r.render({ ...initialState, contactScan: null, contactScanFailed: true } as AppState);
    expect(note(host), '駄目だったのに「集めています」のまま止まった').toContain(
      '集められませんでした',
    );
  });

  /**
   * 🔴 **押し先は原値から作る**(2 巡目の着地前レビュー 2026-08-28)。
   * ⚠ 丸めた字から `mailto:` を作ると、字は正しく `…` で切れているのに
   *   **押すと別の宛先へ送る**。`…` は `[^\s@]` に当たるので `mailHref` の
   *   検査を**すり抜ける**(= 押せない口にもならない、いちばん気づけない形)。
   */
  it('🔴 丸めた字を押し先にしない(字は切る / href は原値)', () => {
    const long = `taro@${'y'.repeat(140)}.example.com`;
    const host = paint({ contactScan: scanOf([card('a', '山田', [], [long])]) });
    const a = host.querySelector('[data-pkc-field="contact-mail"]')!;
    expect(a.getAttribute('href'), '丸めた字が押し先に漏れた').toBe(`mailto:${long}`);
    expect(a.textContent, '字は丸めてよい(画面が壊れる)').toContain('…');
  });

  it('🔴 1 件も無いときは、書き方を教える(黙って空にしない)', () => {
    const host = paint({ contactScan: scanOf([]) });
    expect(note(host)).toContain('tel:');
    expect(rows(host)).toHaveLength(0);
  });

  it('🔴 名前を押すとそのノートが開く(開く口を増やさない)', () => {
    const host = paint({ contactScan: scanOf([card('a', '山田', ['090-1234-5678'])]) });
    const open = rows(host)[0]!.querySelector('[data-pkc-field="contact-name"]')!;
    expect(open.getAttribute('data-pkc-action'), '既存の select-entry を通していない').toBe(
      'select-entry',
    );
    expect(open.getAttribute('data-pkc-entry')).toBe('a');
  });

  it('🔴 電話とメールは押せる宛先になる', () => {
    const host = paint({
      contactScan: scanOf([card('a', '山田', ['090-1234-5678'], ['t@example.com'])]),
    });
    const tel = rows(host)[0]!.querySelector<HTMLAnchorElement>('[data-pkc-field="contact-tel"]')!;
    const mail = rows(host)[0]!.querySelector<HTMLAnchorElement>('[data-pkc-field="contact-mail"]')!;
    expect(tel.getAttribute('href'), '記号を落としていない').toBe('tel:09012345678');
    expect(tel.textContent, '字は書いたとおりに出す').toBe('090-1234-5678');
    expect(mail.getAttribute('href')).toBe('mailto:t@example.com');
  });

  it('🔴 押せない宛先はボタンにしない(押しても何も起きない口を作らない)', () => {
    const host = paint({ contactScan: scanOf([card('a', '山田', ['あとで聞く'], ['こわれた'])]) });
    expect(rows(host)[0]!.querySelector('[data-pkc-field="contact-tel"]')).toBeNull();
    expect(rows(host)[0]!.querySelector('[data-pkc-field="contact-mail"]')).toBeNull();
    // ⚠ **字は消さない**(user が書いたものは残す)
    expect(rows(host)[0]!.textContent).toContain('あとで聞く');
    expect(rows(host)[0]!.textContent).toContain('こわれた');
  });

  it('🔴 切ったことを黙らない(「無い」と読ませない)', () => {
    expect(note(paint({ contactScan: scanOf([card('a', '山田', ['090'])], true) }))).toContain(
      '途中まで',
    );
  });

  /**
   * 🔴 **丸めは画面の仕事**(着地前レビュー 2026-08-28)。
   * ⚠ `ContactCard` が原値を持つようになったので、**面が丸めなければ
   *   30 本の電話がそのまま並ぶ**(一覧が壊れる)。上の
   *   `contact-card.test.ts`「原値を丸めない」と**対**である ──
   *   片方だけだと、丸めが書き出しへ戻るか、一覧が壊れるかのどちらかへ倒れる。
   */
  it('🔴 並べすぎは画面で切り、切った数を言う(黙って落とさない)', () => {
    const many = Array.from({ length: 12 }, (_, i) => `090-0000-${String(i).padStart(4, '0')}`);
    const host = paint({ contactScan: scanOf([card('a', '山田', many)]) });
    const ways = host.querySelector('[data-pkc-field="contact-ways"]')!;
    expect(
      ways.querySelectorAll('[data-pkc-field="contact-tel"]'),
      '原値のまま全部並べた(一覧が壊れる)',
    ).toHaveLength(CONTACT_LIMITS.each);
    expect(
      ways.querySelector('[data-pkc-field="contact-ways-more"]')?.textContent,
      '切ったのに黙っている',
    ).toContain(`ほか ${12 - CONTACT_LIMITS.each} 件`);
  });

  it('⚠ 収まっているときは「ほか N 件」を出さない', () => {
    const host = paint({ contactScan: scanOf([card('a', '山田', ['090'], ['t@example.com'])]) });
    expect(host.querySelector('[data-pkc-field="contact-ways-more"]')).toBeNull();
  });

  it('🔴 絞り込みが効き、当たらなければそう言う', () => {
    const cards = [card('a', '山田', ['090-1111-2222']), card('b', '鈴木', ['090-3333-4444'])];
    expect(rows(paint({ contactScan: scanOf(cards), filterQuery: '山田' }))).toHaveLength(1);
    const none = paint({ contactScan: scanOf(cards), filterQuery: '佐藤' });
    expect(rows(none)).toHaveLength(0);
    expect(note(none), '当たらなかったことを言っていない').toContain('絞り込み');
  });

  it('⚠ 集め終わった瞬間に一覧が出る(指紋が「まだ」と 0 件を取り違えない)', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const r = new ContactsRenderer(host);
    r.render({ ...initialState, contactScan: null } as AppState);
    expect(rows(host)).toHaveLength(0);
    r.render({ ...initialState, contactScan: scanOf([card('a', '山田', ['090'])]) } as AppState);
    expect(rows(host), '集め終わったのに一覧が出ない').toHaveLength(1);
  });

  it('🔴 1 件も無いと分かった瞬間に、断り文が入れ替わる', () => {
    /**
     * 🔴 **ここが指紋の当たり所**(変異試験 C11 が SURVIVED で教えた)。
     * ⚠ 「まだ集めていない」と「集めたが 0 件」は**どちらも一覧が空**なので、
     *   指紋に状態を入れないと**同じ指紋**になり、面は
     *   **「集めています…」を出したまま止まる**。
     * ⚠ 1 件でも在る形では見抜けない(そちらは一覧の字で指紋が変わる)。
     */
    const host = document.createElement('div');
    document.body.append(host);
    const r = new ContactsRenderer(host);
    r.render({ ...initialState, contactScan: null } as AppState);
    expect(note(host)).toContain('集めています');
    r.render({ ...initialState, contactScan: scanOf([]) } as AppState);
    expect(note(host), '0 件と分かったのに「集めています」のまま').toContain('tel:');
  });
});

describe('集めるのは「開いたとき」だけ(#278)', () => {
  it('🔴 頼むと走査の依頼が出る', () => {
    const { events } = reduce(initialState, { type: 'REFRESH_CONTACT_SCAN' });
    expect(events.map((e) => e.type)).toContain('REQUEST_CONTACT_SCAN');
  });

  it('🔴 集め直しても、前の一覧は消えない(行が飛ばない)', () => {
    // ⚠ 消すと、集め直すたびに一覧が空になって**押そうとした行が消える**
    const withScan = reduce(initialState, {
      type: 'SET_CONTACT_SCAN',
      scan: scanOf([card('a', '山田', ['090'])]),
    }).state;
    const again = reduce(withScan, { type: 'REFRESH_CONTACT_SCAN' }).state;
    expect(again.contactScan?.cards, '集め直しで一覧が消えた').toHaveLength(1);
  });

  /**
   * 🔴 **取り込んだら、その場で一覧が変わる**(2 巡目の動線レビュー 2026-08-28)。
   *
   * ⚠ 直す前は `SYS_BOOTED`(取込の `reload()` が通る)に **`contactScan` だけが
   *   居なかった** ── 集計・予定・雛形は捨てて頼み直すのに、連絡先は素通り。
   *   帰結:`.vcf` を 200 枚入れても一覧は「連絡先はまだありません」のままで、
   *   帯だけが「200 件」と言う ── user は「入らなかった」と読み、
   *   **同じ file をもう一度取り込んで 400 件になる**。
   * ⚠ 集め直しの合図は「左のタブを連絡先へ切り替えたとき」**1 か所しか無い**ので、
   *   タブを開いたままの user には永久に届かなかった。
   */
  it('🔴 再読込(取込)で連絡先を頼み直す ── ただし一度も開いていない人には撃たない', () => {
    const booted = (base: AppState): ReturnType<typeof reduce> =>
      reduce(base, { type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    const withScan = reduce(initialState, {
      type: 'SET_CONTACT_SCAN',
      scan: scanOf([card('a', '山田', ['090'])]),
    }).state;
    expect(
      booted({ ...withScan, cid: 'c1' }).events,
      '取り込んだのに集め直しを頼んでいない(一覧が古いまま)',
    ).toContainEqual({ type: 'REQUEST_CONTACT_SCAN' });
    // ⚠ 対照群 ── 一度も開いていない user に全ノートの走査を負わせない
    expect(booted(initialState).events).not.toContainEqual({ type: 'REQUEST_CONTACT_SCAN' });
  });

  /**
   * 🔴 **消えたノートの行を残さない**(同レビュー)。
   * ⚠ **丸ごと捨てない** ── `SYS_BOOTED` は別タブが書くたびに飛ぶので、
   *   捨てると一覧が「集めています…」へ落ちて**押そうとした行が飛ぶ**
   *   (`REFRESH_CONTACT_SCAN` が「消さない」と書いている理由と同じ)。
   */
  it('🔴 再読込で、消えたノートの行だけが落ちる(生きている行は残る)', () => {
    const withScan = reduce(initialState, {
      type: 'SET_CONTACT_SCAN',
      scan: scanOf([card('a', '山田', ['090']), card('b', '消えた', ['091'])]),
    }).state;
    const meta = {
      lid: 'a',
      title: '山田',
      archetype: 'text',
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
      bodyChars: null,
    } as never;
    const out = reduce(
      { ...withScan, cid: 'c1' },
      { type: 'SYS_BOOTED', cid: 'c1', metas: [meta], relations: [] },
    );
    expect(
      out.state.contactScan?.cards.map((c) => c.lid),
      '消えたノートの行が残った(押しても何も起きない)',
    ).toEqual(['a']);
  });

  it('🔴 集められなかったら、そう覚える(「まだ」と区別する)', () => {
    const failed = reduce(initialState, { type: 'CONTACT_SCAN_FAILED' }).state;
    expect(failed.contactScanFailed).toBe(true);
    expect(failed.contactScan, '駄目だったのに一覧が入った').toBeNull();
    // ⚠ 集まったら**印は下ろす**(古い断り文を出し続けない)
    const ok = reduce(failed, { type: 'SET_CONTACT_SCAN', scan: scanOf([]) }).state;
    expect(ok.contactScanFailed).toBe(false);
  });
});

/**
 * 🔴 **探し方を足したときの取りこぼしを止める**(#278 段① で実際に踏んだ)。
 *
 * ⚠ 直す前は「探し方の型」と「妥当性の判定」が別々に書かれており、
 *   連絡先を足したとき**判定のほうを足し忘れた**。帰結は
 *   🔴 **タブは出る・押せる・器も在るのに、面が切り替わらない**
 *   ── user から見て「押しても何も起きない」であり、**どこにも何も出ない**。
 * 🔑 いまは一覧(`BROWSE_MODES`)から型も判定も導いてあるので足し忘れようがない。
 *   ⚠ それでも**タブ・図案は別の表**なので、ここで突き合わせる
 *   (CLAUDE.md「入力を守る検査と、出力が届いたかを見る検査は別物」)。
 */
describe('探し方の全数(#278 段①)', () => {
  it('🔴 タブ・判定・図案が、探し方の一覧と過不足なく揃っている', () => {
    // 空振り防止 ── 一覧そのものが空 / 縮んだ形で「全部揃った」と言わない
    expect(BROWSE_MODES.length, '探し方の一覧が縮んでいる').toBeGreaterThanOrEqual(5);
    expect([...BROWSE_TABS].map((t) => t.mode).sort(), 'タブと探し方が食い違っている').toEqual(
      [...BROWSE_MODES].sort(),
    );
    for (const mode of BROWSE_MODES) {
      expect(isBrowseMode(mode), `${mode} を判定が弾いている(面が切り替わらない)`).toBe(true);
      expect(BROWSE_ICONS[mode], `${mode} の図案が無い`).toBeDefined();
    }
    expect(isBrowseMode('しらない'), '知らない値を通した').toBe(false);
  });
});

describe('vCard の書き出し(#278 段③)', () => {
  it('🔴 ボタンは連絡先が見えているときだけ出て、件数を言う', () => {
    const host = paint({
      contactScan: scanOf([card('a', '山田', ['090']), card('b', '別人', [], ['b@x.jp'])]),
    });
    const btn = host.querySelector<HTMLButtonElement>('[data-pkc-field="contacts-export"]')!;
    expect(btn, '書き出しの口が無い').not.toBeNull();
    expect(btn.getAttribute('data-pkc-action')).toBe('export-vcards');
    expect(btn.textContent).toBe('vCard で書き出す(2 件)');
    // 0 件なら出さない(空の file を落とす口を見せない)
    const empty = paint({ contactScan: scanOf([]) });
    expect(empty.querySelector('[data-pkc-field="contacts-export"]')).toBeNull();
  });

  /**
   * 🔴 **出ない物を言う**(着地前レビュー 2026-08-28)。⚠ 書き出しは
   *   frontmatter の鍵だけを写すので、**本文に書いた住所やメモは出ない** ──
   *   それを言わないと、user は「連絡先を書き出した」と思って
   *   **元の .vcf を消す**(戻れない欠損になる)。
   */
  it('🔴 何が出ないかをボタン自身が言う(書き出したつもりで元を消させない)', () => {
    const host = paint({ contactScan: scanOf([card('a', '山田', ['090'])]) });
    const title = host.querySelector('[data-pkc-field="contacts-export"]')!.getAttribute('title')!;
    expect(title, '出る物を言っていない').toContain('誕生日');
    expect(title, '出ない物を言っていない').toMatch(/住所|メモ/);
  });

  /**
   * 🔴 **途中までしか集めていないことを、書き出しの側でも言う**(#536 ①)。
   * ⚠ 面は「(多いので途中まで集めました)」と出すのに、**ボタンと帯は黙って**いた ──
   *   「全部出た」と思って元の .vcf を捨てる側に効く。
   */
  it('🔴 途中までしか集めていないなら、ボタンの字でも言う', () => {
    const host = paint({ contactScan: scanOf([card('a', '山田', ['090'])], true) });
    expect(
      host.querySelector('[data-pkc-field="contacts-export"]')!.textContent,
      '切ったのに件数だけ言っている(全部と読まれる)',
    ).toContain('途中まで集めた');
  });

  it('⚠ 対照群 ── 切っていなければ今までどおりの字(要らない断りを出さない)', () => {
    const host = paint({ contactScan: scanOf([card('a', '山田', ['090'])]) });
    expect(host.querySelector('[data-pkc-field="contacts-export"]')!.textContent).toBe(
      'vCard で書き出す(1 件)',
    );
  });

  it('🔴 絞り込み中は絞った件数を言う(画面と書き出しは同じ 1 つの規則 ── §7)', () => {
    const host = paint({
      contactScan: scanOf([card('a', '山田', ['090']), card('b', '別人', [], ['b@x.jp'])]),
      filterQuery: '山田',
    });
    const btn = host.querySelector<HTMLButtonElement>('[data-pkc-field="contacts-export"]')!;
    expect(btn.textContent, '絞ったのに全件の数を言っている').toBe('vCard で書き出す(1 件)');
  });
});
