/** @vitest-environment happy-dom */
/**
 * 🔴 **書庫(zip)の中を別の窓で見て選ぶ**(#826。user 指摘 2026-09-09
 * 「**zipの一覧をその場の器にするのはなんで？/ 別窓にはできないの？**」)。
 *
 * 守る主張:
 * 1. **掴んだ直後は白紙にしない**(「読んでいます…」が出る)
 * 2. 一覧が並び、フォルダは末尾の `/`、押すと印が付く
 * 3. **0 件では取り出せない**(押しても何も起きない口を作らない)
 * 4. 🔴 **答えは必ず返る** ── 「やめる」でも、**窓ごと閉じられても** `null`
 *    (呼び側が永久に待たない)
 * 5. 🔴 **選んだら窓を閉じる**(取り出した後も選び手が残らない)
 * 6. 窓の名前は**書庫ごとに固定**(2 回押しても 2 枚目を積まない)
 * 7. 配色は**根から写す**(この窓だけ色が違う、を作らない)
 */
import { describe, expect, it, vi } from 'vitest';
import {
  archiveWindowName,
  grabArchiveWindow,
  pickInArchiveWindow,
  type ArchiveWindowRow,
} from '../../src/adapter/platform/archive-window';

/** 別窓の代わり(happy-dom の document を 1 枚借りる ── `asset-window.test.ts` と同じ作法)。 */
function fakeWindow() {
  const doc = document.implementation.createHTMLDocument('');
  const win = {
    closed: false,
    document: doc,
    close(): void {
      this.closed = true;
    },
  };
  return win as unknown as Window & { closed: boolean };
}

const ROWS: readonly ArchiveWindowRow[] = [
  { path: '写真', name: '写真', depth: 0, isDirectory: true, size: '' },
  { path: '写真/海.jpg', name: '海.jpg', depth: 1, isDirectory: false, size: '12 KB' },
  { path: 'memo.txt', name: 'memo.txt', depth: 0, isDirectory: false, size: '30 B' },
];

/** 印から取り出す件数(実物と同じ規則:フォルダはその下を全部数える)。 */
const countFiles = (marks: readonly string[]): number =>
  ROWS.filter((r) => !r.isDirectory && marks.some((m) => r.path === m || r.path.startsWith(`${m}/`)))
    .length;

const toggle = (marks: readonly string[], path: string): string[] => {
  const next = new Set(marks);
  if (!next.delete(path)) next.add(path);
  return [...next];
};

const rowsOf = (win: Window): HTMLButtonElement[] => [
  ...win.document.querySelectorAll<HTMLButtonElement>('[data-pkc-field="archive-window-row"]'),
];
const okOf = (win: Window): HTMLButtonElement =>
  win.document.querySelector<HTMLButtonElement>('[data-pkc-field="archive-window-ok"]')!;
const never = (): Promise<void> => new Promise<void>(() => undefined);

describe('書庫の別窓', () => {
  it('🔴 掴んだ直後は白紙にしない(「読んでいます…」が出る)', () => {
    const win = fakeWindow();
    const got = grabArchiveWindow('資料.zip', 'k1', () => win);
    expect(got).toBe(win);
    expect(
      win.document.querySelector('[data-pkc-field="archive-window-wait"]')?.textContent,
      '掴んだだけの窓が白紙 = 壊れているように見える',
    ).toContain('読んでいます');
    expect(win.document.title).toContain('資料.zip');
  });

  it('掴めなければ null(呼び側がその場の器へ落ちる)', () => {
    expect(grabArchiveWindow('x.zip', 'k1', () => null)).toBeNull();
  });

  it('🔴 窓の名前は書庫ごとに固定(2 枚目を積まない)', () => {
    const seen: string[] = [];
    const win = fakeWindow();
    const open = (_u: string, n: string): Window => {
      seen.push(n);
      return win;
    };
    grabArchiveWindow('a.zip', 'key/one+', open);
    grabArchiveWindow('a.zip', 'key/one+', open);
    expect(seen[0]).toBe(seen[1]);
    // ⚠ 窓の名前に使えない字は落とす
    expect(seen[0]).toBe(archiveWindowName('key/one+'));
    expect(seen[0]).not.toContain('/');
  });

  it('一覧が並ぶ(フォルダは末尾の `/`、ファイルは大きさ付き)', () => {
    const win = fakeWindow();
    grabArchiveWindow('a.zip', 'k', () => win);
    void pickInArchiveWindow(win, {
      rows: ROWS,
      countFiles,
      toggle,
      themeFrom: document.documentElement,
      waitClose: never,
    });
    const texts = rowsOf(win).map((b) => b.textContent);
    expect(texts).toEqual(['写真/', '海.jpg — 12 KB', 'memo.txt — 30 B']);
    // ⚠ 「読んでいます…」は消えている(2 つ並べない)
    expect(win.document.querySelector('[data-pkc-field="archive-window-wait"]')).toBeNull();
  });

  it('🔴 0 件では取り出せない ── 押すと件数が出て、押せるようになる', () => {
    const win = fakeWindow();
    grabArchiveWindow('a.zip', 'k', () => win);
    void pickInArchiveWindow(win, {
      rows: ROWS,
      countFiles,
      toggle,
      themeFrom: document.documentElement,
      waitClose: never,
    });
    expect(okOf(win).disabled, '0 件なのに押せる').toBe(true);
    // 🔑 フォルダを押すと、その下のファイルが入る
    rowsOf(win)[0]!.click();
    expect(okOf(win).disabled).toBe(false);
    expect(okOf(win).textContent).toContain('1 件');
  });

  it('🔴 選ぶと path が返り、窓は閉じる', async () => {
    const win = fakeWindow();
    grabArchiveWindow('a.zip', 'k', () => win);
    const answered = pickInArchiveWindow(win, {
      rows: ROWS,
      countFiles,
      toggle,
      themeFrom: document.documentElement,
      waitClose: never,
    });
    rowsOf(win)[2]!.click();
    okOf(win).click();
    expect(await answered).toEqual(['memo.txt']);
    expect(win.closed, '選んだ後も選び手が残っている').toBe(true);
  });

  it('「やめる」は null', async () => {
    const win = fakeWindow();
    grabArchiveWindow('a.zip', 'k', () => win);
    const answered = pickInArchiveWindow(win, {
      rows: ROWS,
      countFiles,
      toggle,
      themeFrom: document.documentElement,
      waitClose: never,
    });
    win.document
      .querySelector<HTMLButtonElement>('[data-pkc-field="archive-window-cancel"]')!
      .click();
    expect(await answered).toBeNull();
  });

  /** 🔴 これが無いと、窓を閉じた user の操作が**永久に待つ**(黙って消える)。 */
  it('🔴 窓ごと閉じられても答えが返る', async () => {
    const win = fakeWindow();
    grabArchiveWindow('a.zip', 'k', () => win);
    let closed: (() => void) | null = null;
    const answered = pickInArchiveWindow(win, {
      rows: ROWS,
      countFiles,
      toggle,
      themeFrom: document.documentElement,
      waitClose: () =>
        new Promise<void>((r) => {
          closed = r;
        }),
    });
    closed!();
    expect(await answered).toBeNull();
  });

  /**
   * 🔴 **答えは 1 度だけ**(変異試験 A11 が SURVIVED で教えた)。
   *
   * ⚠ 直す前の test は**答えの値**しか見ていなかったので、「1 度だけ」を外しても
   *   緑だった ── `resolve` の 2 回目は Promise が黙って捨てるからである。
   * 🔑 だから**窓を閉じた回数**で見る:選んだ後に窓の閉じが届いても、
   *   `close()` は **1 回**でなければならない(2 度目は既に閉じた窓を叩く)。
   */
  it('🔴 選んだ後に窓の閉じが届いても、閉じるのは 1 度だけ', async () => {
    const win = fakeWindow();
    const closes = vi.spyOn(win, 'close');
    grabArchiveWindow('a.zip', 'k', () => win);
    let closed: (() => void) | null = null;
    const answered = pickInArchiveWindow(win, {
      rows: ROWS,
      countFiles,
      toggle,
      themeFrom: document.documentElement,
      waitClose: () =>
        new Promise<void>((r) => {
          closed = r;
        }),
    });
    rowsOf(win)[2]!.click();
    okOf(win).click();
    expect(await answered).toEqual(['memo.txt']);
    // ⚠ 窓が閉じたことは**後から**届く(poll なので 1 拍遅れる)
    closed!();
    await Promise.resolve();
    expect(closes, '閉じを 2 度撃っている(答えも 2 度出ている)').toHaveBeenCalledTimes(1);
    closes.mockRestore();
  });

  /** ⚠ 待ちが失敗した回も答えを返す(例外で待ちが漏れない)。 */
  it('待ちが転んでも答えが返る', async () => {
    const win = fakeWindow();
    grabArchiveWindow('a.zip', 'k', () => win);
    const answered = pickInArchiveWindow(win, {
      rows: ROWS,
      countFiles,
      toggle,
      themeFrom: document.documentElement,
      waitClose: () => Promise.reject(new Error('x')),
    });
    expect(await answered).toBeNull();
  });

  /**
   * 🔴 **読んでいる間に閉じられた**(大きい書庫ほど起きる)。
   * ⚠ 直す前はそのまま組みにいって落ち、**呼び側の Promise が例外で終わる**
   *   (押した人には何も出ない)。
   */
  it('🔴 読んでいる間に閉じられていたら、組まずに「やめた」を返す', async () => {
    const win = fakeWindow();
    grabArchiveWindow('a.zip', 'k', () => win);
    win.close();
    const answered = pickInArchiveWindow(win, {
      rows: ROWS,
      countFiles,
      toggle,
      themeFrom: document.documentElement,
      waitClose: never,
    });
    expect(await answered).toBeNull();
    // ⚠ 組んでいない(閉じた窓に一覧を積まない)
    expect(rowsOf(win)).toHaveLength(0);
  });

  /**
   * 🔴 **配色は根から写す**(色の表をこの module に持たない)。
   * ⚠ 空振り防止 ── 写す元に値が無ければ何も入らないので、値を入れてから見る。
   */
  it('🔴 配色を根から写す', () => {
    const win = fakeWindow();
    const root = document.documentElement;
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (n: string) => (n === '--bg' ? '#123456' : ''),
    } as unknown as CSSStyleDeclaration);
    grabArchiveWindow('a.zip', 'k', () => win);
    void pickInArchiveWindow(win, {
      rows: ROWS,
      countFiles,
      toggle,
      themeFrom: root,
      waitClose: never,
    });
    expect(win.document.querySelector('style')?.textContent).toContain('--bg:#123456');
    vi.restoreAllMocks();
  });
});
