/**
 * 🔴 **同じノートの付箋を 2 枚作らない**(#685、user 裁定 2026-09-04)。
 *
 * > 「**開いている窓が前に出る**(2 枚目は作らない)。違うノートなら今までどおり増える」
 *
 * ## ⚠ ここでしか見られないもの
 *
 * 実測(2026-09-04)で **`noopener` を付けると窓の名前は無視される**と分かったので、
 * 「使い回す」をブラウザに任せられない ── だから台帳を自前で持つ。
 * 🔑 **本物どうしを繋ぐ**(CLAUDE.md §7)── 片側だけの台で見ると、
 * 綴りの食い違いが**両方緑のまま**通る。ここでは実物の台帳を 2〜3 個建て、
 * **間に立つ放送路は「そのまま流す通り道」**にしてある(封筒を 1 バイトも作らない)。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createNoteRegistry,
  type NoteRegistry,
} from '../../src/adapter/platform/note-window-registry';
import type { Broadcaster } from '../../src/adapter/platform/storage/store-proxy';

/**
 * 差し替えの放送路。
 * ⚠ **本物と同じ意味論にする**(CLAUDE.md §3)── `BroadcastChannel` は
 *   **自分には配らない**。ここで配ると「自分の名乗りで自分が止まる」欠陥を見逃す。
 */
function bus(): () => Broadcaster {
  const live: Broadcaster[] = [];
  return () => {
    const ch: Broadcaster = {
      onmessage: null,
      postMessage: (data) => {
        for (const other of [...live]) if (other !== ch) other.onmessage?.({ data } as MessageEvent);
      },
      close: () => {
        const i = live.indexOf(ch);
        if (i >= 0) live.splice(i, 1);
      },
    };
    live.push(ch);
    return ch;
  };
}

function win(make: () => Broadcaster, id: string): { reg: NoteRegistry; raised: () => number } {
  let raised = 0;
  const reg = createNoteRegistry({ channel: make(), id, onRaise: () => (raised += 1) });
  return { reg, raised: () => raised };
}

describe('付箋の台帳(#685、user 裁定 2026-09-04)', () => {
  it('🔴 付箋が名乗ると、別の窓から見える', () => {
    const make = bus();
    const a = win(make, 'A');
    const b = win(make, 'B');
    expect(b.reg.has('e1'), '前提が崩れた(まだ誰も名乗っていない)').toBe(false);
    a.reg.announce('e1');
    expect(b.reg.has('e1'), '付箋が居るのに 2 枚目を開こうとする').toBe(true);
    // ⚠ **対照群** ── 名乗っていないノートは今までどおり開く
    expect(b.reg.has('e2'), '違うノートまで止めている').toBe(false);
  });

  /**
   * 🔴 **自分の名乗りで自分を止めない** ── 止めると、付箋の中で
   *   「別の窓で開く」を押したときに**何も起きない**(無言の dead click)。
   *
   * ⚠ **2 通りで見る**(2026-09-04、変異試験が SURVIVED で教えた):
   *   ① 放送路は**自分には配らない**ので、ふつうに名乗っただけでは
   *      `w.id === 自分` の枝を**1 度も通らない**(CLAUDE.md §2)
   *   ② だから**自分の id を騙る便り**を外から流して、その枝を実際に走らせる
   */
  it('🔴 自分の名乗りは自分を止めない(放送路は自分に配らない)', () => {
    const make = bus();
    const a = win(make, 'A');
    a.reg.announce('e1');
    expect(a.reg.has('e1'), '自分の付箋で自分が止まっている').toBe(false);
  });

  it('🔴 自分の id を騙る便りは数えない', () => {
    const make = bus();
    const a = win(make, 'A');
    const raw = make();
    raw.postMessage({ tag: 'note-window-here', id: 'A', lid: 'e1' });
    expect(a.reg.has('e1'), '自分の id の便りで自分が止まっている').toBe(false);
    // ⚠ **対照群** ── 別の id なら数える(「何も数えない」実装で緑にしない)
    raw.postMessage({ tag: 'note-window-here', id: 'Z', lid: 'e2' });
    expect(a.reg.has('e2'), '別の窓の名乗りまで捨てている').toBe(true);
  });

  /**
   * 🔴 **後から建った窓も、点呼で知る** ── これが無いと、本体を読み直した
   *   だけで「2 枚目を作らない」が効かなくなる。
   */
  it('🔴 後から建った窓も、先に居る付箋を知る', () => {
    const make = bus();
    const a = win(make, 'A');
    a.reg.announce('e1');
    const late = win(make, 'C');
    expect(late.reg.has('e1'), '点呼していない(先に居る付箋が見えない)').toBe(true);
  });

  it('🔴 閉じたら台帳から消える(次は開ける)', () => {
    const make = bus();
    const a = win(make, 'A');
    const b = win(make, 'B');
    a.reg.announce('e1');
    expect(b.reg.has('e1'), '前提が崩れた').toBe(true);
    a.reg.close();
    expect(b.reg.has('e1'), '閉じた付箋がいつまでも残る(二度と開けない)').toBe(false);
  });

  it('🔴 付箋でなくなったら消える', () => {
    const make = bus();
    const a = win(make, 'A');
    const b = win(make, 'B');
    a.reg.announce('e1');
    a.reg.announce(null);
    expect(b.reg.has('e1'), '面へ移った窓が付箋のまま数えられている').toBe(false);
  });

  /** 🔴 **1 つの窓が出す付箋は 1 件** ── 前の行を外さないと、閉じたノートが残る。 */
  it('🔴 別のノートへ移ると、前のノートは空く', () => {
    const make = bus();
    const a = win(make, 'A');
    const b = win(make, 'B');
    a.reg.announce('e1');
    a.reg.announce('e2');
    expect(b.reg.has('e1'), '前のノートが台帳に残っている').toBe(false);
    expect(b.reg.has('e2'), '移った先が載っていない').toBe(true);
  });

  /** 🔴 **「前に出て」は当の窓だけに届く**(無関係な窓を手前に出さない)。 */
  it('🔴 前に出るよう頼まれるのは、その付箋の窓だけ', () => {
    const make = bus();
    const a = win(make, 'A');
    const b = win(make, 'B');
    const c = win(make, 'C');
    a.reg.announce('e1');
    b.reg.raise('e1');
    expect(a.raised(), 'その付箋の窓が呼ばれていない').toBe(1);
    expect(c.raised(), '無関係な窓まで手前に出している').toBe(0);
    expect(b.raised(), '頼んだ側が自分を呼んでいる').toBe(0);
  });

  it('⚠ 居ないノートに頼んでも何も起きない', () => {
    const make = bus();
    const a = win(make, 'A');
    const b = win(make, 'B');
    b.reg.raise('e9');
    expect(a.raised()).toBe(0);
  });

  /**
   * ⚠ **放送路が無い箱では、今までどおり 2 枚目が開く**(壊れる方向へ倒れない)。
   * ⚠ ここを `true` に倒すと、古いブラウザで**付箋が 1 枚も開けなくなる**。
   */
  it('⚠ 放送路が無ければ台帳は空(付箋は今までどおり開く)', () => {
    const reg = createNoteRegistry({ channel: null, id: 'A', onRaise: vi.fn() });
    reg.announce('e1');
    expect(reg.has('e1')).toBe(false);
    expect(() => {
      reg.raise('e1');
      reg.close();
    }, '放送路が無いと例外で落ちる').not.toThrow();
  });

  /** ⚠ 綴りの違う便りは黙って捨てる(別の物がこの路に乗っても取り違えない)。 */
  it('⚠ 知らない便りは無視する', () => {
    const make = bus();
    const a = win(make, 'A');
    const raw = make();
    raw.postMessage({ tag: 'なにか', id: 'Z', lid: 'e1' });
    raw.postMessage(null);
    raw.postMessage('文字列');
    expect(a.reg.has('e1'), '知らない便りで台帳が埋まった').toBe(false);
  });
});
