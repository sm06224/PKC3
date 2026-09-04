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
    let closed = false;
    const ch: Broadcaster = {
      onmessage: null,
      postMessage: (data) => {
        /**
         * 🔴 **閉じた後は投げる**(#685 着地前レビュー ⚠6、2026-09-04)。
         * ⚠ 1 稿目は「自分には配らない」だけ真似ていたので、**閉じた後の意味論**が
         *   本物より甘かった ── だから「閉じたのに配れる」も「閉じた後に名乗ると
         *   落ちる」も、この台では**永久に見えなかった**(CLAUDE.md §3)。
         * ⚠ 実物の `BroadcastChannel` は `close()` 後の `postMessage` で
         *   `InvalidStateError` を投げる(Node でも同じ)。
         */
        if (closed) throw new DOMException('closed', 'InvalidStateError');
        for (const other of [...live]) if (other !== ch) other.onmessage?.({ data } as MessageEvent);
      },
      close: () => {
        closed = true;
        const i = live.indexOf(ch);
        if (i >= 0) live.splice(i, 1);
      },
    };
    live.push(ch);
    return ch;
  };
}

function win(
  make: () => Broadcaster,
  id: string,
  over: { now?: () => number; answerMs?: number } = {},
): { reg: NoteRegistry; raised: () => number; crash: () => void } {
  let raised = 0;
  const ch = make();
  const reg = createNoteRegistry({ channel: ch, id, onRaise: () => (raised += 1), ...over });
  // ⚠ **消える窓を模す** ── `close()` と違い、GONE を 1 通も出さずに居なくなる
  //    (クラッシュ / OS kill / タブ破棄。`pagehide` は飛ばない)
  return { reg, raised: () => raised, crash: () => ch.close() };
}

describe('付箋の台帳(#685、user 裁定 2026-09-04)', () => {
  it('🔴 付箋が名乗ると、別の窓から見える', () => {
    const make = bus();
    const a = win(make, 'A');
    const b = win(make, 'B');
    expect(b.reg.whereIs('e1'), '前提が崩れた(まだ誰も名乗っていない)').toBe(null);
    a.reg.announce('e1');
    expect(b.reg.whereIs('e1'), '付箋が居るのに 2 枚目を開こうとする').toBe('other');
    // ⚠ **対照群** ── 名乗っていないノートは今までどおり開く
    expect(b.reg.whereIs('e2'), '違うノートまで止めている').toBe(null);
  });

  /**
   * 🔴 **自分が出しているノートは `'self'`**(#685 動線レビュー 欠陥 3、2026-09-04)。
   *
   * ⚠ 直す前は「別の窓が居るか」だけを返していたので、**付箋の中から同じノートに
   *   「別の窓で開く」を押すと 2 枚目が開いた** ── お知らせにもマニュアルにも
   *   「2 枚目を作りません」と条件なしで書いたのに、押した場所で約束が変わっていた。
   * 🔑 呼び側は `'self'` と `'other'` で**出す字を変える**(前に出す相手が居ないので)。
   */
  it('🔴 自分が出しているノートは self と答える', () => {
    const make = bus();
    const a = win(make, 'A');
    expect(a.reg.whereIs('e1'), '前提が崩れた(まだ名乗っていない)').toBe(null);
    a.reg.announce('e1');
    expect(a.reg.whereIs('e1'), '自分の付箋を「どこにも無い」と答えた(2 枚目が開く)').toBe('self');
    // ⚠ **対照群** ── 出していないノートは今までどおり開ける
    expect(a.reg.whereIs('e2'), '違うノートまで止めている').toBe(null);
  });

  it('🔴 自分の id を騙る便りは数えない', () => {
    const make = bus();
    const a = win(make, 'A');
    const raw = make();
    raw.postMessage({ tag: 'note-window-here', id: 'A', lid: 'e1' });
    expect(a.reg.whereIs('e1'), '自分の id の便りで自分が止まっている').toBe(null);
    // ⚠ **対照群** ── 別の id なら数える(「何も数えない」実装で緑にしない)
    raw.postMessage({ tag: 'note-window-here', id: 'Z', lid: 'e2' });
    expect(a.reg.whereIs('e2'), '別の窓の名乗りまで捨てている').toBe('other');
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
    expect(late.reg.whereIs('e1'), '点呼していない(先に居る付箋が見えない)').toBe('other');
  });

  it('🔴 閉じたら台帳から消える(次は開ける)', () => {
    const make = bus();
    const a = win(make, 'A');
    const b = win(make, 'B');
    a.reg.announce('e1');
    expect(b.reg.whereIs('e1'), '前提が崩れた').toBe('other');
    a.reg.close();
    expect(b.reg.whereIs('e1'), '閉じた付箋がいつまでも残る(二度と開けない)').toBe(null);
  });

  it('🔴 付箋でなくなったら消える', () => {
    const make = bus();
    const a = win(make, 'A');
    const b = win(make, 'B');
    a.reg.announce('e1');
    a.reg.announce(null);
    expect(b.reg.whereIs('e1'), '面へ移った窓が付箋のまま数えられている').toBe(null);
  });

  /** 🔴 **1 つの窓が出す付箋は 1 件** ── 前の行を外さないと、閉じたノートが残る。 */
  it('🔴 別のノートへ移ると、前のノートは空く', () => {
    const make = bus();
    const a = win(make, 'A');
    const b = win(make, 'B');
    a.reg.announce('e1');
    a.reg.announce('e2');
    expect(b.reg.whereIs('e1'), '前のノートが台帳に残っている').toBe(null);
    expect(b.reg.whereIs('e2'), '移った先が載っていない').toBe('other');
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
    // ⚠ 自分が出している物は、放送路が無くても分かる(そこは台帳ではない)
    expect(reg.whereIs('e1'), '自分の付箋すら分からなくなっている').toBe('self');
    // 🔴 **別の窓のことは分からない** ── だから今までどおり 2 枚目が開く(壊れる方向ではない)
    expect(reg.whereIs('e2')).toBe(null);
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
    expect(a.reg.whereIs('e1'), '知らない便りで台帳が埋まった').toBe(null);
  });

  /**
   * 🔴 **閉じた路へ名乗っても落ちない**(#685 着地前レビュー ⚠2、2026-09-04)。
   *
   * ⚠ 台帳への名乗りは **state listener から呼ばれる**(`main.ts` の `announceNote`)。
   *   `Dispatcher` の listener 呼び出しに try/catch は無いので、投げると
   *   **その `dispatch` の `DomainEvent` が丸ごと落ちる**(= 保存の副作用が消える)。
   * ⚠ `pagehide` は **bfcache へ入るときにも飛ぶ**(この repo の実測)ので、
   *   閉じた後に名乗る場面は**実際に起こりうる**。
   */
  it('🔴 閉じた路へ名乗っても落ちない(dispatch を巻き込まない)', () => {
    const make = bus();
    const ch = make();
    const reg = createNoteRegistry({ channel: ch, id: 'A', onRaise: vi.fn() });
    reg.close();
    // ⚠ **前提を確かめる** ── 台が本物と同じに投げること(甘い台なら以降は空振り)
    expect(() => ch.postMessage({ tag: 'x', id: 'A' }), '台が本物より甘い(閉じても投げない)').toThrow();
    expect(() => reg.announce('e1'), '閉じた路へ名乗って落ちた').not.toThrow();
    expect(() => reg.raise('e1'), '閉じた路へ頼んで落ちた').not.toThrow();
  });

  /** 🔴 **閉じたら答えも捨てる** ── 残すと、戻ってきた窓が古い台帳で断り続ける。 */
  it('🔴 閉じたら台帳の答えも捨てる', () => {
    const make = bus();
    const a = win(make, 'A');
    const b = win(make, 'B');
    a.reg.announce('e1');
    expect(b.reg.whereIs('e1'), '前提が崩れた').toBe('other');
    b.reg.close();
    expect(b.reg.whereIs('e1'), '閉じた後も古い答えを返している').toBe(null);
  });

  /**
   * 🔴 **離れるときは放送路を閉じない**(bfcache で戻ってくる)。
   * ⚠ 閉じてしまうと、戻ってきた窓は名乗れず、以後ずっと台帳に載らない。
   */
  it('🔴 leave の後も、戻ってきたら名乗り直せる', () => {
    const make = bus();
    const a = win(make, 'A');
    const b = win(make, 'B');
    a.reg.announce('e1');
    a.reg.leave();
    expect(b.reg.whereIs('e1'), '離れたのに台帳に残っている').toBe(null);
    // 🔑 戻ってきた(bfcache 復帰)── 同じ lid でも名乗り直せる
    a.reg.announce('e1');
    expect(b.reg.whereIs('e1'), '戻ってきたのに名乗れない(放送路を閉じている)').toBe('other');
  });

  /**
   * 🔴 **これから開く 1 枚を先に取っておく**(#685 着地前レビュー ⚠7)。
   * ⚠ 付箋が名乗るのは boot の後なので、**押した直後の数百 ms は台帳が空**である。
   *   塞がれたと思って 2 度押すと、同じノートの窓が 2 枚開いていた。
   */
  describe('これから開く 1 枚(着地前レビュー ⚠7)', () => {
    it('🔴 取っておくと、2 度目は開かない', () => {
      const make = bus();
      const a = win(make, 'A');
      expect(a.reg.whereIs('e1'), '前提が崩れた').toBe(null);
      a.reg.reserve('e1');
      expect(a.reg.whereIs('e1'), '2 度押しで 2 枚開く').toBe('other');
    });

    it('🔴 開けなかったら外す(次の 1 押しで開ける)', () => {
      const make = bus();
      const a = win(make, 'A');
      a.reg.reserve('e1');
      a.reg.release('e1');
      expect(a.reg.whereIs('e1'), '開けなかったのに取ったまま').toBe(null);
    });

    it('🔴 本物が名乗ったら、見込みは台帳に置き換わる', () => {
      const make = bus();
      const a = win(make, 'A');
      const b = win(make, 'B');
      a.reg.reserve('e1');
      b.reg.announce('e1');
      expect(a.reg.whereIs('e1')).toBe('other');
      // 🔑 その窓が閉じたら、見込みごと消えて開けるようになる
      b.reg.leave();
      expect(a.reg.whereIs('e1'), '窓が閉じたのに見込みが残っている(二度と開けない)').toBe(null);
    });

    /**
     * 🔴 **どちらも呼ばれなかったときは、時間で外れる**(crash の保険)。
     * ⚠ 外れないと、そのノートは**二度と窓で開けない**。
     */
    it('🔴 時間が経てば見込みは自然に外れる', () => {
      const make = bus();
      let clock = 1000;
      const reg = createNoteRegistry({
        channel: make(),
        id: 'A',
        onRaise: vi.fn(),
        now: () => clock,
        reserveMs: 500,
      });
      reg.reserve('e1');
      expect(reg.whereIs('e1'), '前提が崩れた').toBe('other');
      clock += 499;
      expect(reg.whereIs('e1'), '早すぎる時点で外れている').toBe('other');
      clock += 2;
      expect(reg.whereIs('e1'), '時間が経っても外れない(二度と開けない)').toBe(null);
    });
  });

  /**
   * 🔴 **消えた窓のせいで、そのノートが二度と開けなくならない**
   *   (#685 着地前レビュー、2026-09-04)。
   *
   * ⚠ 付箋の窓が `pagehide` を出さずに消えると(クラッシュ / OS kill / タブ破棄)、
   *   台帳に行が残り続ける。⚠ そのとき `raise` は誰にも届かないので
   *   **窓も出てこない** ── 断り文(「すでに別のウィンドウで開いています」)が
   *   **嘘になる**うえ、逃げ道は本体の読み直しだけだった。
   * 🔑 `raise` のときに点呼も打ち、答えが無ければ行を捨てる。
   *   ⚠ **時計は回さない**(常駐の定期実行を作らない)── 次に聞かれたときに判る。
   */
  describe('消えた窓の後始末(着地前レビュー)', () => {
    it('🔴 答えない窓の行は、次に聞かれたときに捨てる', () => {
      const make = bus();
      let clock = 1000;
      const a = win(make, 'A', { now: () => clock, answerMs: 500 });
      const b = win(make, 'B', { now: () => clock, answerMs: 500 });
      b.reg.announce('e1');
      expect(a.reg.whereIs('e1'), '前提が崩れた').toBe('other');
      b.crash(); // ⚠ GONE を出さずに消える
      a.reg.raise('e1'); // 押した ── ここで生死も聞く
      expect(a.reg.whereIs('e1'), '聞いた直後に捨てている(生きている窓を消す)').toBe('other');
      clock += 501;
      expect(a.reg.whereIs('e1'), '消えた窓のせいで二度と開けない').toBe(null);
    });

    /**
     * ⚠ **対照群** ── 生きている窓は答えるので、いつまでも `'other'` のまま。
     * ⚠ これが無いと「時間が経てば全部捨てる」実装でも緑になる。
     */
    it('⚠ 生きている窓は、時間が経っても捨てない', () => {
      const make = bus();
      let clock = 1000;
      const a = win(make, 'A', { now: () => clock, answerMs: 500 });
      const b = win(make, 'B', { now: () => clock, answerMs: 500 });
      b.reg.announce('e1');
      a.reg.raise('e1');
      expect(b.raised(), '前提が崩れた(頼めていない)').toBe(1);
      clock += 5000;
      expect(a.reg.whereIs('e1'), '生きている窓の行を捨てた(2 枚目が開く)').toBe('other');
    });
  });
});
