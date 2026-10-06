/** @vitest-environment happy-dom */
/**
 * 🔴 **手が滑りやすい 2 つを切る設定**(#1087。裁定 2026-10-01)
 *   ── 「長いコード枠を最初から畳む」/「本文の `code` を押すとコピーする」。
 *
 * ⚠ 守るのは「設定に在って、映って、押せて、憶える」の 4 つ。`missing-links` と同じく
 *   **既定が入**なので、いちばん強く見るのは**何も選んでいない人で入になっていること**と、
 *   **切が憶えられること**(`!== '0'` を `=== '1'` に書き間違えると、鍵の無い人が切になる)。
 * ⚠ 2 つは**別の鍵・別の欄**である ── 片方を切ってもう片方が動かないことも見る
 *   (同じ store を共有する配線ミスを捕まえる)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsRenderer } from '@adapter/ui/render/settings';
import { CodeCollapseStore } from '@adapter/ui/render/code-collapse';
import { InlineCodeCopyStore } from '@adapter/ui/render/inline-code-copy';
import { bindActions } from '@adapter/ui/actions/binder';
import type { Dispatcher } from '@adapter/state/dispatcher';
import { initialState } from '@adapter/state/app-state';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

function setup(stored: { collapse?: string; copy?: string } = {}) {
  document.body.textContent = '';
  const host = document.createElement('div');
  document.body.append(host);
  const storage = fakeStorage();
  if (stored.collapse !== undefined) storage.map.set('pkc3.code-collapse', stored.collapse);
  if (stored.copy !== undefined) storage.map.set('pkc3.inline-code-copy', stored.copy);
  const collapse = new CodeCollapseStore(storage);
  const copy = new InlineCodeCopyStore(storage);
  // ⚠ 末尾の位置引数(`settings.ts` の constructor の戒め)── `missingLinks`(15 番目)の次の 2 つ
  const args: unknown[] = Array<undefined>(14).fill(undefined);
  args.push(undefined, collapse, copy);
  const r = new (SettingsRenderer as unknown as new (...a: unknown[]) => SettingsRenderer)(
    host,
    ...args,
  );
  r.render(initialState);
  return {
    host,
    collapse,
    copy,
    storage,
    collapseBox: host.querySelector<HTMLInputElement>('[data-pkc-field="code-collapse"]'),
    copyBox: host.querySelector<HTMLInputElement>('[data-pkc-field="inline-code-copy"]'),
  };
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('設定画面に在る(#1087)', () => {
  it('🔴 2 つの checkbox が「編集」の節に在り、既定は入', () => {
    const { host, collapseBox, copyBox } = setup();
    for (const [box, action, field] of [
      [collapseBox, 'set-code-collapse', 'code-collapse'],
      [copyBox, 'set-inline-code-copy', 'inline-code-copy'],
    ] as const) {
      expect(box, `${field} の欄が設定に無い`).not.toBeNull();
      expect(box!.type).toBe('checkbox');
      expect(box!.getAttribute('data-pkc-action'), '押しても受け手に届かない').toBe(action);
      expect(box!.checked, `${field} の既定が切(何も選んでいない人の見え方が変わる)`).toBe(true);
      expect(
        host.querySelector(`[data-pkc-region="settings-edit"] [data-pkc-field="${field}"]`),
        `${field} が「編集」の節の外に在る`,
      ).not.toBeNull();
    }
  });

  it('🔴 画面の字(dt / label / hover)', () => {
    const { collapseBox, copyBox } = setup();
    const dtOf = (box: HTMLElement) => box.closest('dd')!.previousElementSibling!.textContent;
    expect(dtOf(collapseBox!)).toBe('長いコード枠');
    expect(collapseBox!.parentElement!.textContent).toBe(' 長いコード枠を最初から折りたたむ');
    expect(collapseBox!.parentElement!.title).toContain('切ると、最初から字が全部見えます');
    expect(dtOf(copyBox!)).toBe('文中の短いコード');
    expect(copyBox!.parentElement!.textContent).toBe(' 本文の `code` を押すとコピーする');
    expect(copyBox!.parentElement!.title).toContain('切ると、押しても何も起きず');
  });

  it('🔴 切が憶えられ、映る ── 片方だけ切っても、もう片方は入のまま(対照群)', () => {
    const a = setup({ collapse: '0' });
    expect(a.collapseBox!.checked, '切が入に見えている').toBe(false);
    expect(a.copyBox!.checked, '畳みを切ったらコピーまで切れた').toBe(true);
    const b = setup({ copy: '0' });
    expect(b.copyBox!.checked).toBe(false);
    expect(b.collapseBox!.checked, 'コピーを切ったら畳みまで切れた').toBe(true);
  });

  it('🔴 押すと、それぞれの受け手に届く(dead click ではない)── 外したときも', () => {
    const { host, collapseBox, copyBox } = setup();
    const setCodeCollapse = vi.fn();
    const setInlineCodeCopy = vi.fn();
    bindActions(host, { dispatch: vi.fn(), getState: () => initialState } as unknown as Dispatcher, {
      setCodeCollapse,
      setInlineCodeCopy,
    });
    collapseBox!.click(); // 入 → 切
    expect(setCodeCollapse, '押しても受け手が呼ばれない').toHaveBeenCalledWith(false);
    expect(setInlineCodeCopy, '畳みの欄がコピーの受け手を呼んだ').not.toHaveBeenCalled();
    collapseBox!.click();
    expect(setCodeCollapse).toHaveBeenLastCalledWith(true);
    copyBox!.click();
    expect(setInlineCodeCopy).toHaveBeenCalledWith(false);
    expect(setCodeCollapse, 'コピーの欄が畳みの受け手を呼んだ').toHaveBeenCalledTimes(2);
  });
});

describe.each([
  ['CodeCollapseStore', (s: ReturnType<typeof fakeStorage>) => new CodeCollapseStore(s), 'pkc3.code-collapse'],
  ['InlineCodeCopyStore', (s: ReturnType<typeof fakeStorage>) => new InlineCodeCopyStore(s), 'pkc3.inline-code-copy'],
] as const)('%s', (_name, make, key) => {
  it('🔴 鍵が無ければ入 / 書いた切は 0 で残る', () => {
    const storage = fakeStorage();
    const s = make(storage);
    expect(s.enabled()).toBe(true);
    s.setEnabled(false);
    expect(storage.map.get(key)).toBe('0');
    expect(make(storage).enabled()).toBe(false);
    s.setEnabled(true);
    expect(make(storage).enabled()).toBe(true);
  });

  it('保存が例外を投げる端末でも既定は入で、この session では書いた値が効く', () => {
    const boom = {
      getItem: (): string | null => {
        throw new Error('blocked');
      },
      setItem: (): void => {
        throw new Error('blocked');
      },
    };
    const s = make(boom as unknown as ReturnType<typeof fakeStorage>);
    expect(s.enabled()).toBe(true);
    s.setEnabled(false);
    expect(s.enabled()).toBe(false);
  });
});
