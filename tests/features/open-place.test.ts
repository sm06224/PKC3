/**
 * 「別の窓 / この画面」の意味論(#826)。
 *
 * ⚠ 守る主張は 2 つだけ:①**既定は別の窓**(裁定「アプリの基本は別窓」)
 * ②**知らない綴りは既定へ落ちる**(壊れた保存で起動不能にしない)。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPEN_PLACE,
  isOpenPlace,
  OPEN_PLACES,
  type OpenPlace,
} from '../../src/features/open-place';

describe('開く場所', () => {
  it('🔴 既定は別の窓(裁定「アプリの基本は別窓」)', () => {
    expect(DEFAULT_OPEN_PLACE).toBe('window');
  });

  /** ⚠ **1 つ目が既定**でないと、選択肢を見ただけでは既定が分からない。 */
  it('選択肢の 1 つ目が既定である', () => {
    expect(OPEN_PLACES[0].id).toBe(DEFAULT_OPEN_PLACE);
  });

  /** 🔑 **どちらも消さない** ── 片方だけにすると、塞がれた user の行き場が無くなる。 */
  it('別の窓と この画面 の 2 つがある', () => {
    expect(OPEN_PLACES.map((p) => p.id)).toEqual(['window', 'here']);
  });

  it('名前は空でない(設定画面にそのまま出る)', () => {
    for (const p of OPEN_PLACES) expect(p.label.length).toBeGreaterThan(0);
  });

  it.each([['window'], ['here']])('%s は受ける', (id) => {
    expect(isOpenPlace(id as string)).toBe(true);
  });

  it.each([[''], ['popup'], ['WINDOW'], ['here ']])('%s は受けない', (id) => {
    expect(isOpenPlace(id as string)).toBe(false);
  });

  /** ⚠ 型の側でも 2 つに閉じていること(綴りを足したら test も足す)。 */
  it('型は 2 つに閉じている', () => {
    const all: OpenPlace[] = ['window', 'here'];
    expect(new Set(all).size).toBe(OPEN_PLACES.length);
  });
});
