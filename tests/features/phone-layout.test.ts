/**
 * スマホ用画面の判定(#632 段①)。実体は `src/features/phone-layout.ts`。
 *
 * 🔴 守る主張:
 * 1. 何も選んでいなければ**一覧**(スマホの入口)
 * 2. 本文以外の面(設定・フラグ・ヘルプ・2 ペイン・集計)は**情報より強い**
 * 3. 情報ページは**開いたノートでだけ**開く ── 別のノートへ移ると**自分で閉じる**
 * 4. 帯(← 一覧 ｜ 題名 ｜ 情報 ｜ ⋯)を出すのは**本文を開いているとき**だけ
 */
import { describe, expect, it } from 'vitest';
import {
  PHONE_MAX_PX,
  PHONE_MIN_PX,
  phoneBandShown,
  phonePageOf,
  type PhoneShape,
} from '../../src/features/phone-layout';
import { VIEW_MODES, type ViewMode } from '../../src/adapter/state/app-state';

const at = (over: Partial<PhoneShape> = {}): PhoneShape => ({
  selectedLid: 'a',
  viewMode: 'detail',
  ...over,
});

describe('スマホ用画面の境目', () => {
  it('🔴 上限 720 / 下限 360 ── 数字はこの file にしか無い', () => {
    expect(PHONE_MAX_PX).toBe(720);
    expect(PHONE_MIN_PX).toBe(360);
    // ⚠ 下限は上限より小さい(逆に書くと「全部が対応外」になる)
    expect(PHONE_MIN_PX).toBeLessThan(PHONE_MAX_PX);
  });
});

describe('phonePageOf ── いま出す 1 枚', () => {
  it('🔴 何も選んでいなければ一覧', () => {
    expect(phonePageOf(at({ selectedLid: null }), null)).toBe('list');
    // ⚠ 情報を開いた状態で選択が外れても一覧へ戻る(情報だけ残らない)
    expect(phonePageOf(at({ selectedLid: null }), 'a')).toBe('list');
  });

  it('🔴 ノートを選んでいれば本文', () => {
    expect(phonePageOf(at(), null)).toBe('note');
  });

  it('🔴 情報は「開いたノート」でだけ出る', () => {
    expect(phonePageOf(at({ selectedLid: 'a' }), 'a')).toBe('info');
    // 🔑 別のノートへ移ったら閉じる ── 閉じる code はどこにも書いていない
    expect(phonePageOf(at({ selectedLid: 'b' }), 'a')).toBe('note');
  });

  /**
   * ⚠ **対照群**:同じ入力で「情報より強い」を消す変異(`viewMode` の判定を外す)を
   * 殺すため、`infoFor` が一致している状態で面を開く。
   * ⚠ ここが無いと「面のときは note」だけ見ることになり、**情報 bit が立っていない
   * 場面**しか通らない(§1「強制する規則は、強制しなければ false になる場面で見る」)。
   */
  it('🔴 本文以外の面は情報より強い ── 面を開くと情報は畳む', () => {
    for (const view of VIEW_MODES.filter((v) => v !== 'detail')) {
      expect(phonePageOf(at({ viewMode: view }), 'a'), view).toBe('pane');
      expect(phonePageOf(at({ viewMode: view, selectedLid: null }), null), view).toBe('pane');
    }
    // 対照群: 本文の面では同じ入力が info になる
    expect(phonePageOf(at({ viewMode: 'detail' }), 'a')).toBe('info');
  });

  /** ⚠ 面の一覧が増えたらここが数える(`detail` 以外は全部「中央が自分の面を出す」)。 */
  it('🔴 面を足しても取りこぼさない ── 全 ViewMode を当てる', () => {
    const seen = new Set<string>();
    for (const view of VIEW_MODES) seen.add(phonePageOf(at({ viewMode: view }), null));
    expect([...seen].sort()).toEqual(['note', 'pane']);
    expect(VIEW_MODES.length).toBeGreaterThanOrEqual(2);
  });
});

describe('phoneBandShown ── 帯を出すか', () => {
  const band = (st: PhoneShape, infoFor: string | null = null): boolean =>
    phoneBandShown(phonePageOf(st, infoFor));

  it('🔴 本文を開いているときだけ出す', () => {
    expect(band(at())).toBe(true);
    // 一覧には出さない(押す先が無い)
    expect(band(at({ selectedLid: null }))).toBe(false);
  });

  it('🔴 面を開いているときは出さない ── 戻る口が 2 本並ばない', () => {
    for (const view of VIEW_MODES.filter((v) => v !== 'detail'))
      expect(band(at({ viewMode: view })), view).toBe(false);
  });

  /**
   * 🔴 **情報ページでは必ず出る** ── 出ないと「← ノート」が画面から消え、
   * 情報ページが行き止まりになる(#609 の型)。⚠ 実装の 1 稿目は帯を中央の面の
   * **中**に置いていたので、まさにこれが起きていた。
   */
  it('🔴 情報ページには必ず帯がある(行き止まりを作らない)', () => {
    const st = at({ selectedLid: 'a' });
    expect(phonePageOf(st, 'a')).toBe('info');
    expect(band(st, 'a')).toBe(true);
  });

  /** ⚠ 全 4 ページを当てる(page を足した人がここで気づく)。 */
  it('🔴 帯を出すのは note と info の 2 つだけ', () => {
    const on = (['list', 'note', 'info', 'pane'] as const).filter((p) => phoneBandShown(p));
    expect([...on]).toEqual(['note', 'info']);
  });
});

describe('型の網羅(空振り防止)', () => {
  it('ViewMode は文字列の集合として実在する', () => {
    const views: readonly ViewMode[] = VIEW_MODES;
    expect(views).toContain('detail');
  });
});
