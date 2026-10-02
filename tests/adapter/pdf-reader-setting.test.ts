/**
 * 「PDF を PKC の画面で開く」の設定(#275 段①)── 既定は**切**、入にした人だけ。
 *
 * 守るもの:①何も選んでいない人は切(= 見え方が変わらない)②入 → 保存 → 読み直しで入 ③保存が読めない端末では
 * 控えが効く(`store-fallback.test.ts` の一覧にも載せてある)④画面(設定)の checkbox が store と対で動く。
 */
import { describe, expect, it } from 'vitest';
import { PdfReaderStore } from '../../src/adapter/ui/render/pdf-reader-setting';

function mem(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? (data[k] as string) : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe('PdfReaderStore', () => {
  it('何も選んでいなければ切', () => {
    expect(new PdfReaderStore(mem()).enabled()).toBe(false);
  });

  it('入にすると保存され、別の store で読み直しても入(対照: 切に戻すと切)', () => {
    const m = mem();
    new PdfReaderStore(m).setEnabled(true);
    expect(m.data['pkc3.pdf-reader']).toBe('1');
    expect(new PdfReaderStore(m).enabled()).toBe(true);
    new PdfReaderStore(m).setEnabled(false);
    expect(m.data['pkc3.pdf-reader']).toBe('0');
    expect(new PdfReaderStore(m).enabled()).toBe(false);
  });

  it('読むたびに保存を見る(別のタブの変更に追随する)', () => {
    const m = mem();
    const s = new PdfReaderStore(m);
    expect(s.enabled()).toBe(false);
    m.data['pkc3.pdf-reader'] = '1';
    expect(s.enabled()).toBe(true);
  });

  it('保存が読めない・書けない端末でも落ちず、この session では効く', () => {
    const broken: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const s = new PdfReaderStore(broken);
    expect(s.enabled()).toBe(false);
    s.setEnabled(true);
    expect(s.enabled()).toBe(true);
  });
});
