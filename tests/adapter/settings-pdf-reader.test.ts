/** @vitest-environment happy-dom */
/**
 * 🔴 **「PDF を PKC の画面で開く」の設定**(#275 段①。裁定: 選んだ人だけ・**既定は切**)。
 *
 * ⚠ 守るのは「設定に在って、映って、押せて、憶える」の 4 つ。`code-collapse` などと逆に**既定が切**なので、
 *   いちばん強く見るのは**何も選んでいない人で切になっていること**(= 今までのブラウザ内蔵の窓のまま)と、
 *   **入が憶えられること**。⚠ 見え方の規則(「押した印に見た目の規則が在るか」)は checkbox の `checked` を
 *   ブラウザが描くので CSS の受け皿は要らない ── 他の入切と同じ器である。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsRenderer } from '@adapter/ui/render/settings';
import { PdfReaderStore } from '@adapter/ui/render/pdf-reader-setting';
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

function setup(stored?: string) {
  document.body.textContent = '';
  const host = document.createElement('div');
  document.body.append(host);
  const storage = fakeStorage();
  if (stored !== undefined) storage.map.set('pkc3.pdf-reader', stored);
  const store = new PdfReaderStore(storage);
  // ⚠ 末尾の位置引数(`settings.ts` の constructor の戒め)── `vacuum`(20 番目、#999)の次
  const args: unknown[] = Array<undefined>(20).fill(undefined);
  args.push(store);
  const r = new (SettingsRenderer as unknown as new (...a: unknown[]) => SettingsRenderer)(host, ...args);
  r.render(initialState);
  return { host, store, storage, box: host.querySelector<HTMLInputElement>('[data-pkc-field="pdf-reader"]') };
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('設定画面に在る(#275)', () => {
  it('🔴 checkbox が「編集」の節に在り、既定は切(何も選んでいない人の窓は変わらない)', () => {
    const { host, box } = setup();
    expect(box, 'pdf-reader の欄が設定に無い').not.toBeNull();
    expect(box!.type).toBe('checkbox');
    expect(box!.getAttribute('data-pkc-action'), '押しても受け手に届かない').toBe('set-pdf-reader');
    expect(box!.checked, '既定が入(見え方が勝手に変わる)').toBe(false);
    expect(host.querySelector('[data-pkc-region="settings-edit"] [data-pkc-field="pdf-reader"]')).not.toBeNull();
  });

  it('🔴 画面の字(dt / label / hover)── 内部の部品名を出さない', () => {
    const { box } = setup();
    expect(box!.closest('dd')!.previousElementSibling!.textContent).toBe('PDF');
    expect(box!.parentElement!.textContent).toBe(' PDF を PKC3 の画面で開く(字を選んでノートへ引用できる)');
    const title = box!.parentElement!.title;
    expect(title).toContain('ノートへ引用する');
    expect(title).toContain('オフにすると、ブラウザ内蔵の表示で開きます');
    for (const banned of ['pdf.js', 'pdfjs', 'worker', 'textLayer', '壊れ']) {
      expect(`${box!.parentElement!.textContent}${title}`.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it('🔴 入が憶えられ、映る(対照: 鍵が無ければ切)', () => {
    expect(setup('1').box!.checked, '入が切に見えている').toBe(true);
    expect(setup('0').box!.checked).toBe(false);
    expect(setup().box!.checked).toBe(false);
  });

  it('🔴 押すと、受け手に届く(dead click ではない)── 入れたときも外したときも', () => {
    const { host, box } = setup();
    const setPdfReader = vi.fn();
    bindActions(host, { dispatch: vi.fn(), getState: () => initialState } as unknown as Dispatcher, {
      setPdfReader,
    });
    box!.click();
    expect(setPdfReader, '押しても受け手が呼ばれない').toHaveBeenCalledWith(true);
    box!.click();
    expect(setPdfReader).toHaveBeenLastCalledWith(false);
  });
});
