/**
 * 🔴 **アプリの一覧でグループを畳む**(#857 段④)── 意味論の側。
 *
 * 🔴 守る主張:
 * 1. 壊れた保存で**起動を止めない**(読めない字は空)
 * 2. **名前の無いグループは畳めない**(見出しが無い = 開く口が画面から消える)
 * 3. 🔴 **絞り込み中は畳みを無視する** ── 絞った結果が畳んだ群の中に在ると、
 *    打ったのに何も出ないように見える(「無い」と「畳んである」の区別が付かない)
 */
import { describe, expect, it } from 'vitest';
import {
  decodeFolded,
  encodeFolded,
  isFolded,
  toggleFolded,
} from '../../src/features/launcher/group-fold';

describe('グループの畳み(#857 段④)', () => {
  it('🔴 往復する(書いたものが読み戻る)', () => {
    expect(decodeFolded(encodeFolded(['資料', '道具']))).toEqual(['資料', '道具']);
  });

  it('🔴 壊れた保存で起動を止めない(読めない字は空)', () => {
    for (const raw of [null, '', '{', 'null', '3', '"資料"', '{"a":1}'])
      expect(decodeFolded(raw), `読めない字で落ちた: ${String(raw)}`).toEqual([]);
    // ⚠ 中身の型が違う物だけ捨てる(残りは活かす ── 全部捨てると畳みが丸ごと消える)
    expect(decodeFolded('["資料",1,null,"","道具"]')).toEqual(['資料', '道具']);
    // ⚠ 重複は落とす(保存が壊れていても、判定は 1 名 1 回で足りる)
    expect(decodeFolded('["資料","資料"]')).toEqual(['資料']);
  });

  it('🔴 押すたびに畳む / 開く', () => {
    expect(toggleFolded([], '資料')).toEqual(['資料']);
    expect(toggleFolded(['資料'], '資料')).toEqual([]);
    // ⚠ 他の群は巻き込まない
    expect(toggleFolded(['資料', '道具'], '資料')).toEqual(['道具']);
  });

  it('🔴 名前の無いグループは畳めない(開く口が画面から消えるため)', () => {
    expect(toggleFolded([], '')).toEqual([]);
    expect(isFolded([''], '', false), '名前の無い群を畳んだ扱いにした').toBe(false);
  });

  it('🔴 絞り込み中は畳みを無視する(打ったのに何も出ない、を作らない)', () => {
    expect(isFolded(['資料'], '資料', false), '前提が崩れている').toBe(true);
    expect(isFolded(['資料'], '資料', true), '絞り込み中なのに隠した').toBe(false);
    // ⚠ 対照群 ── 畳んでいない群は、絞り込みの有無に関わらず出る
    expect(isFolded(['資料'], '道具', false)).toBe(false);
  });
});
