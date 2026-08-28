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
import type { ContactScan } from '../../src/features/contact/contact-card';
import { BROWSE_MODES, isBrowseMode } from '../../src/adapter/ui/render/browse-mode';
import { BROWSE_TABS } from '../../src/adapter/ui/render/browse';
import { BROWSE_ICONS } from '../../src/adapter/ui/render/icons';

const card = (lid: string, name: string, tels: string[] = [], emails: string[] = [], org = '') => ({
  lid,
  name,
  org,
  tels,
  emails,
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

  it('🔴 絞り込み中は絞った件数を言う(画面と書き出しは同じ 1 つの規則 ── §7)', () => {
    const host = paint({
      contactScan: scanOf([card('a', '山田', ['090']), card('b', '別人', [], ['b@x.jp'])]),
      filterQuery: '山田',
    });
    const btn = host.querySelector<HTMLButtonElement>('[data-pkc-field="contacts-export"]')!;
    expect(btn.textContent, '絞ったのに全件の数を言っている').toBe('vCard で書き出す(1 件)');
  });
});
