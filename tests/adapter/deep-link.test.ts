/**
 * 🔴 **`#pkc?view=…` で開く面を指す**(#300 段②、2026-08-22)。
 *
 * ## user から見た物語
 *
 * 「いつもカレンダーから始めたい」── アドレスの末尾に付け足してブックマークする。
 * ⚠ それを**クエリパラメータの切替**にしてはいけない(user 指示 2026-08-07、不可侵)
 * ── だから**ディープリンク**として足す。
 *
 * ## この test が守る主張
 *
 * ① 面の名前が読めたら、その面で開く
 * ② 🔴 **見ている間は断片を残す** ── 消すと `Ctrl+D` が素の URL を拾い、
 *    **マニュアルが案内しているブックマークが作れない**。`F5` でも面が消える
 * ③ 🔴 **user が自分で離れたら消す** ── 残したままだと、本文を読み始めた後の
 *    読み直し(更新の適用 / 昇格)でその面へ飛ばされる
 * ④ 🔴 **使えない名前を黙って捨てない**。⚠ 断り文には**打つ字**を出す
 *    (画面の呼び名を出すと、user は打てない字で書き直して詰まる)
 * ⑤ ⚠ 開いたままのタブでアドレスへ足したときも効く(`hashchange`)
 * ⑥ ⚠ **対照群** ── 断片が無いふつうの起動では何も撃たず、断片も触らない
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MOVED_MESSAGE,
  NOTE_OPEN_HERE_MESSAGE,
  announceOpenedWindow,
  noteOpenElsewhereMessage,
  connectViewDeepLink,
  currentBaseUrl,
  openableViewNames,
  readViewDeepLink,
  unusableViewMessage,
  type DeepLinkTarget,
  windowTitleFor,
  isPurposeWindow,
  noteOpenedByUs,
} from '../../src/adapter/platform/deep-link';
import { VIEW_MODES, type ViewMode } from '../../src/adapter/state/app-state';
import {
  dropViewFromHash,
  dropViewWindowToken,
  formatViewDeepLink,
  setHashEntry,
} from '../../src/features/link/permalink';

/** 的 + 面の購読 + 断片の購読を 1 つにした試験台。 */
function bench(hash: string) {
  let cleared = 0;
  /** 撃たれたもの。`open:<面>` か `fail`。 */
  const actions: string[] = [];
  let viewListener: ((v: ViewMode) => void) | null = null;
  let hashListener: (() => void) | null = null;
  /** 選んでいるノートが変わったことにする購読(#689 案 B)。 */
  let selectListener: ((containerId: string | null, lid: string | null) => void) | null = null;
  /**
   * ⚠ **本物と同じ意味論にする**(CLAUDE.md §3)── 本物は getter で、
   *   消した後は `view` / `w` を落とした断片を返す。
   *
   * 🔴 **実物の関数を通す**(#689 で直した)── 1 稿目は `''` に落としていたが、
   *   本物の `clearHash` は **`container` / `entry` を残す**(`dropViewFromHash`)。
   *   ⚠ この食い違いのせいで「`Alt+1` で本文へ戻った後も住所が残っている」という
   *   #689 の物語そのものが、**この台では再現できなかった**
   *   ── stub を本物より**強く**作ると、実装の欠陥が台の側で消える。
   */
  /** 住所を元へ戻した回数(#693)。 */
  let restored = 0;
  const target: DeepLinkTarget & { hash: string } = {
    hash,
    clearHash: () => {
      cleared += 1;
      target.hash = dropViewFromHash(target.hash);
    },
    dropToken: () => {
      target.hash = dropViewWindowToken(target.hash);
    },
    /**
     * ⚠ **本物と同じ意味論**(#689 案 B)── 本物は `setHashEntry` を通し、
     *   結果が同じなら `replaceState` を呼ばない。ここでも**実物を通す**
     *   ── 「名乗っていない断片には生やさない」を test 側で書き直すと、
     *   実装と同じ盲点を共有する(CLAUDE.md § 1)。
     */
    setEntry: (containerId, lid) => {
      target.hash = setHashEntry(target.hash, containerId, lid);
    },
    /** 本物は `replaceState` で断片を丸ごと差し替える(#693)── ここも同じ意味論。 */
    restoreHash: (h) => {
      restored += 1;
      target.hash = h;
    },
  };
  let failed: string | null = null;
  /** 連れてきたノート(#300 段③ の直し)。 */
  const selects: Array<{ containerId: string; lid: string }> = [];
  /** 断片が指している面の遷移(`null` = 離れた)。 */
  const holds: Array<ViewMode | null> = [];
  /** 「この窓は付箋か」の遷移(#685 着地前レビュー 🔴1 / ⚠3)。 */
  const noteHolds: boolean[] = [];
  const off = connectViewDeepLink({
    openView: (mode) => actions.push(`open:${mode}`),
    // 🔴 **引っ越した面の受け皿**(#292 段⑤)── 左の列のタブ
    openBrowse: (mode) => actions.push(`browse:${mode}`),
    selectEntry: (containerId, lid) => {
      selects.push({ containerId, lid });
      actions.push(`select:${lid}`);
    },
    onHold: (v) => holds.push(v),
    onHoldEntry: (on) => noteHolds.push(on),
    fail: (m) => {
      failed = m;
      actions.push('fail');
    },
    onViewChange: (fn) => {
      viewListener = fn;
      return () => {
        viewListener = null;
      };
    },
    onHashChange: (fn) => {
      hashListener = fn;
      return () => {
        hashListener = null;
      };
    },
    onSelectedEntry: (fn) => {
      selectListener = fn;
      return () => {
        selectListener = null;
      };
    },
    target,
  });
  return {
    actions,
    failed: () => failed,
    off,
    cleared: () => cleared,
    restored: () => restored,
    hash: () => target.hash,
    /** 面が変わったことにする(アプリ側の購読が呼ぶのと同じ)。 */
    viewBecomes: (v: ViewMode) => viewListener?.(v),
    /** アドレスの断片が書き換わったことにする。 */
    hashBecomes: (h: string) => {
      target.hash = h;
      hashListener?.();
    },
    /** 選んでいるノートが変わったことにする(#689 案 B)。 */
    selectBecomes: (lid: string | null, cid: string | null = 'c1') =>
      selectListener?.(cid, lid),
    subscribed: () => ({
      view: viewListener !== null,
      hash: hashListener !== null,
      select: selectListener !== null,
    }),
    selects,
    holds,
    noteHolds,
  };
}

describe('起動時のディープリンク(#300 段②)', () => {
  it('🔴 `#pkc?view=query` でその面が開く', () => {
    const b = bench('#pkc?view=query');
    expect(b.actions, 'その面で開いていない').toEqual(['open:query']);
  });

  /**
   * 🔴 **面の全数を当てる**(組み合わせが有限なら全部当てる ── CLAUDE.md)。
   * ⚠ 面を足したときに「ディープリンクからは開けない面」が黙って生まれるのを止める。
   */
  it('🔴 開ける面は全部ディープリンクで開ける', () => {
    for (const mode of openableViewNames()) {
      const b = bench(`#pkc?view=${mode}`);
      expect(b.actions, `${mode} が開けない`).toEqual([`open:${mode}`]);
    }
    // ⚠ 空振り防止 ── 一覧が空だと上の loop は 0 周で通る
    expect(openableViewNames().length, '開ける面が 1 つも無い').toBeGreaterThan(1);
  });

  /**
   * 🔴 **見ている間は断片が残る**(2026-08-22 に「読んだら消す」から翻した)。
   * ⚠ 消すと、マニュアルが案内している `Ctrl+D` が**素の URL**を拾い、
   *   「**成功した人だけがブックマークを作れない**」形になる。
   */
  it('🔴 その面を見ている間は、断片を消さない(ブックマークが作れる)', () => {
    const b = bench('#pkc?view=query');
    expect(b.cleared(), '開いた時点で断片を消している').toBe(0);
    expect(b.hash(), 'アドレスから字が消えている').toBe('#pkc?view=query');
    // ⚠ 自分が撃った面の通知で消してしまわないこと(いちばん出やすい取り違え)
    b.viewBecomes('query');
    expect(b.cleared(), '自分が開いた面の通知で消している').toBe(0);
  });

  it('🔴 user が別の面へ移ったら、その瞬間に断片を消す', () => {
    const b = bench('#pkc?view=query');
    b.viewBecomes('detail');
    expect(b.cleared(), '離れても断片が残る ── 読み直しでこの面へ飛ばされる').toBe(1);
    expect(b.hash()).toBe('');
    // ⚠ 一度消したら、その後の面の移動で二重に消さない
    b.viewBecomes('dual');
    expect(b.cleared(), '離れるたびに消しにいっている').toBe(1);
  });

  it('🔴 使えない名前は、黙って捨てず理由を出す(打つ字を見せる)', () => {
    const b = bench('#pkc?view=nonsense');
    expect(b.actions, '面を開こうとした(型に無い値が state に入る)').toEqual(['fail']);
    const error = b.failed() ?? '';
    // ⚠ **打ち間違いの綴りをそのまま画面へ通さない**
    expect(error, '外から来た綴りをそのまま出している').not.toContain('nonsense');
    // 🔑 **打てる字**を出す(画面の呼び名を出すと、user は打てない字で書き直す)
    expect(error, 'アドレスに打つ字が出ていない').toContain('query');
    expect(error, '打てない字(画面の呼び名)を出している').not.toContain('カレンダー');
    // ⚠ 使えない名前は残す意味が無いので、その場で消す
    expect(b.cleared(), '断り文が読み直しのたびに出る').toBe(1);
  });

  /**
   * 🔴 **日本語で書いた名前も黙って捨てない**(動線レビューが拾った穴)。
   * ⚠ 初稿は `permalink.ts` の綴り検査で `null` に落としていたので、
   *   `#pkc?view=カレンダー` は**断り文すら出ずに本文が開いた** ──
   *   直前の断り文が「カレンダー」と書いていたので、user は
   *   **絶対に効かない書き方へ誘導されて詰まる**形だった。
   */
  it('🔴 日本語で書いた名前でも理由が出る(打てない字で書き直させない)', () => {
    const b = bench('#pkc?view=カレンダー');
    expect(b.actions, '黙って本文を開いている').toEqual(['fail']);
  });

  it('⚠ 開いたままのタブでアドレスへ足しても効く(hashchange)', () => {
    const b = bench('');
    expect(b.actions, '断片が無いのに何か撃った').toEqual([]);
    b.hashBecomes('#pkc?view=dual');
    expect(b.actions, 'アドレスへ足しても何も起きない').toEqual(['open:dual']);
  });

  it('⚠ 本文の見出しへのリンク(#slug)では何もしない(断片も消さない)', () => {
    const b = bench('#pkc?view=dual');
    b.hashBecomes('#some-heading');
    expect(b.actions, '見出しリンクで面を動かした').toEqual(['open:dual']);
    expect(b.cleared(), '見出しリンクで断片を消した').toBe(0);
  });

  it('⚠ 対照群 ── ふつうの起動では何も撃たず、断片も触らない', () => {
    /**
     * ⚠ **`#pkc?container=…&entry=…` はこの一覧から外した**(#685 段①、2026-09-04)
     *   ── いまはノートを開く(下の describe)。ここに残っていると
     *   **「何も起きない」を守る検査**が、新しい動線と正面から食い違う。
     */
    for (const hash of ['', '#', '#pkc?container=c1', '#pkc?entry=e1', '#other?view=query']) {
      const b = bench(hash);
      expect(b.actions, `${JSON.stringify(hash)} で面を動かした`).toEqual([]);
      expect(b.cleared(), `${JSON.stringify(hash)} で断片を消した`).toBe(0);
    }
  });

  /**
   * 🔴 **面を指していない断片でも、ノートは開く**(#685 段①、2026-09-04)。
   *
   * ⚠ 直す前は**何も起きなかった** ── `#pkc?container=c1&entry=e1` は
   *   PKC Link の仕様(form 3)の形なのに、作る側も読む側も **0 件**だった。
   * 🔑 これが在って初めて「このノートを別の窓で開く」(#685 の裁定 A)が組める ──
   *   窓へ行き先を渡せるのは URL だけである。
   */
  describe('面を指さない断片(#685 段①)', () => {
    it('🔴 container と entry が揃っていれば、そのノートを開く', () => {
      const b = bench('#pkc?container=c1&entry=e1');
      expect(b.actions, 'ノートを開いていない').toEqual(['select:e1']);
      expect(b.selects, '連れてきたノートが違う').toEqual([
        { containerId: 'c1', lid: 'e1' },
      ]);
    });

    /**
     * 🔴 **断片は消さない** ── 面(`view`)と違って、ここは「いまこのノートを
     *   見ている」という**正しい住所**である。消すと栞にできない。
     */
    it('🔴 断片は消さない(栞にできる住所である)', () => {
      const b = bench('#pkc?container=c1&entry=e1');
      /**
       * ⚠ **前提を先に確かめる**(R1 で空振りだと分かった、2026-09-04)──
       *   「消していない」は**何も起きなかった回でも真**になる。開いたことを
       *   見てから消えていないことを見る(CLAUDE.md §1)。
       */
      expect(b.actions, '前提が崩れた(そもそもノートを開いていない)').toEqual(['select:e1']);
      expect(b.cleared(), 'ノートの住所まで消している').toBe(0);
    });

    /**
     * ⚠ **面は動かさない** ── 開くのはノートだけで、いま見ている面はそのまま。
     *   🔑 これが無いと「アドレスを開いたら面まで勝手に変わった」になる。
     */
    it('⚠ 面は動かさない(印も立てない)', () => {
      const b = bench('#pkc?container=c1&entry=e1');
      // ⚠ 上と同じ ── 「動かしていない」は何も起きなかった回でも真である
      expect(b.actions, '前提が崩れた(そもそもノートを開いていない)').toEqual(['select:e1']);
      expect(b.holds, '断片が面を指していることにしている').toEqual([]);
    });

    /**
     * 🔴 **片方だけでは開かない**(対照群)。⚠ `container` を見ないと、
     *   別の container の lid と**偶然一致して無関係なノートを選ぶ**。
     */
    it.each([
      ['container だけ', '#pkc?container=c1'],
      ['entry だけ', '#pkc?entry=e1'],
      ['綴りが違う', '#pkc?container=c1&entry=e 1'],
    ])('🔴 %s では開かない', (_name, hash) => {
      expect(bench(hash).actions, '片方だけで開いた').toEqual([]);
    });

    /**
     * ⚠ **面と併記したときは今までどおり**(ノートが先、面が後)── この段で
     *   壊していないことを見る(上の describe の腕と対である)。
     */
    it('⚠ view と併記したときは、ノートの後に面を開く', () => {
      expect(bench('#pkc?container=c1&entry=e1&view=dual').actions).toEqual([
        'select:e1',
        'open:dual',
      ]);
    });
  });

  /**
   * 🔴 **この窓が「付箋」であることを、窓の側が知る**(#685 着地前レビュー 🔴1 / ⚠3、
   *   2026-09-04)。
   *
   * ⚠ 直す前は `onHold`(面を指したときだけ呼ばれる)しか無かったので、付箋の窓は
   *   **自分が付箋だと知らないまま**立ち上がっていた。その結果 2 つが同時に壊れる:
   *   ① 題名が「PKC3」のまま(何枚並べても見分けられない)
   *   ② follower の帯(「保存は本体タブ経由です」)が出っぱなしで、
   *      状態の行 1 行を占めて**読ませたい文を押し出す**。
   */
  describe('付箋の旗(#685 着地前レビュー)', () => {
    it('🔴 ノートを名指した断片で開いた窓は、自分が付箋だと知る', () => {
      const b = bench('#pkc?container=c1&entry=e1');
      expect(b.actions, '前提が崩れた(ノートを開いていない)').toEqual(['select:e1']);
      expect(b.noteHolds, '付箋だと伝わっていない(題名も帯も直らない)').toEqual([true]);
    });

    /** ⚠ **対照群** ── 面を指す窓は付箋ではない(題名は面の名前が入る)。 */
    it('⚠ 面を指した窓は付箋ではない', () => {
      const b = bench('#pkc?container=c1&entry=e1&view=dual');
      expect(b.actions, '前提が崩れた').toEqual(['select:e1', 'open:dual']);
      expect(b.holds, '面を握っていない').toEqual(['dual']);
      expect(b.noteHolds, '面の窓を付箋と数えた').toEqual([]);
    });

    /** ⚠ **対照群 2** ── 断片が無い窓(ふつうの 1 枚目)も付箋ではない。 */
    it('⚠ 断片の無い窓は付箋ではない', () => {
      expect(bench('').noteHolds, '素の起動を付箋と数えた').toEqual([]);
    });

    /**
     * 🔴 **面へ移ったら付箋ではなくなる** ── 帯も題名も戻る。
     * ⚠ 変わったときだけ伝える(`apply` は面が変わるたび走るので、
     *   毎回伝えると `main.ts` が題名を塗り直し続ける)。
     */
    it('🔴 面を指す断片へ書き換わると、付箋の旗が倒れる', () => {
      const b = bench('#pkc?container=c1&entry=e1');
      expect(b.noteHolds).toEqual([true]);
      b.hashBecomes('#pkc?view=dual');
      expect(b.noteHolds, '付箋の旗が立ったまま面を開いた').toEqual([true, false]);
    });

    it('⚠ 同じ断片で何度 apply しても 1 回しか伝えない', () => {
      const b = bench('#pkc?container=c1&entry=e1');
      b.hashBecomes('#pkc?container=c1&entry=e1');
      expect(b.noteHolds, '同じ状態を繰り返し伝えている').toEqual([true]);
    });
  });

  /**
   * 🔴 **開いたままのタブでアドレスへ足しても開く**(#685 着地前レビュー M4、2026-09-04)。
   *
   * ⚠ `deep-link.ts` の冒頭が明記している動線(「マニュアルはアプリの中に在るので、
   *   user は **PKC を開いたまま**アドレス欄へ足す」)が、段① の枝では
   *   **1 度も走っていなかった** ── `hashBecomes` を使う既存の検査は 2 件とも
   *   `view=` か `#slug` で、`container`+`entry` だけの形は 0 件だった。
   */
  describe('開いたまま貼り付ける(#685 着地前レビュー M4)', () => {
    it('🔴 起動後にアドレスへ足しても、そのノートが開く', () => {
      const b = bench('');
      expect(b.actions, '前提が崩れた(何もしていない起動で撃っている)').toEqual([]);
      b.hashBecomes('#pkc?container=c1&entry=e1');
      expect(b.actions, 'アドレスに足しても何も起きない').toEqual(['select:e1']);
    });

    /** ⚠ **対照群** ── 見出しへ動いただけでは選び直さない(アドレスが動くたび戻される、を止める)。 */
    it('⚠ `#slug` へ動いただけでは選び直さない', () => {
      const b = bench('#pkc?container=c1&entry=e1');
      expect(b.actions).toEqual(['select:e1']);
      b.hashBecomes('#some-heading');
      expect(b.actions, 'ノートを選び直した').toEqual(['select:e1']);
    });
  });

  /**
   * ⚠ 他の key と併記できる。
   * 🔑 **段③ でその「将来」が来た** ── 併記した `container` / `entry` は
   *   「連れてきたノート」として実際に使われる(下の describe)。
   */
  it('⚠ 他の key と併記しても view が読める', () => {
    expect(bench('#pkc?container=c1&entry=e1&view=dual').actions).toEqual([
      'select:e1',
      'open:dual',
    ]);
  });

  /** ⚠ 配線を解いたら、購読が両方外れる(閉じたタブが state を掴み続けない)。 */
  it('⚠ 配線を解くと購読が外れる', () => {
    const b = bench('#pkc?view=help');
    expect(b.subscribed()).toEqual({ view: true, hash: true, select: true });
    b.off();
    expect(b.subscribed(), '購読が残っている').toEqual({
      view: false,
      hash: false,
      select: false,
    });
  });

  /**
   * 🔴 **封印中の面はアドレスからも開けない**(動線レビューが拾った口)。
   * ⚠ 封印は「うっかり復活しないこと」を目的にした仕掛けなので、
   *   ボタンを畳んだのにアドレスからは開ける、では向きが逆である。
   */
  it('🔴 開ける名前の一覧に、封印中の面は入らない', async () => {
    const sealed = await import('../../src/features/sealed');
    const names = openableViewNames();
    for (const v of VIEW_MODES) {
      expect(names.includes(v), `${v} の扱いが封印と食い違う`).toBe(!sealed.isSealedView(v));
    }
  });

  /**
   * ⚠ **空振り防止** ── `readViewDeepLink` が常に `null` を返す実装でも
   *   対照群だけは通る。**読めた側**を直に見る。
   */
  it('⚠ readViewDeepLink は読めた面をそのまま返す', () => {
    const t = (hash: string): DeepLinkTarget => ({
      hash,
      clearHash: () => {},
      dropToken: () => {},
      setEntry: () => {},
      restoreHash: () => {},
    });
    expect(readViewDeepLink(t('#pkc?view=help'))).toEqual({ view: 'help' });
    expect(readViewDeepLink(t('#pkc?view=zzz'))).toEqual({ unusable: true });
    expect(readViewDeepLink(t('#pkc?entry=e1'))).toBeNull();
  });

  /**
   * ⚠ **断り文は状態の行 1 行に出る**(高さ 20px 固定・折り返さない)── 長いと後ろが切れる。
   *
   * 🔑 **字数ではなく「見た目の幅」で測る** ── 全角は半角の 2 倍だからである
   *   (字数で測ると、日本語を足したぶんが過小に出る)。
   * ⚠ 予算 90 単位は、11px の字で約 500px ── 2 枚目のタブでは前に
   *   「複数タブ: このタブの保存は本体タブ経由です — 」が常設で付くので、
   *   900px 級の窓でもそこまでなら 1 行に収まる、という見立てである。
   *   ⚠ **実測ではない**(撮っていない)ので、はみ出す報告が来たらここを下げる。
   */
  it('⚠ 断り文は 1 行に収まる幅で、打つ字が先に来る', () => {
    const msg = unusableViewMessage();
    const width = [...msg].reduce((n, ch) => n + (ch.codePointAt(0)! > 0x2000 ? 2 : 1), 0);
    expect(width, '状態の行(1 行)に対して広すぎる').toBeLessThanOrEqual(90);
    // 🔑 打つ字が前半に在る(狭い窓で切れるのは後ろ)
    expect(msg.indexOf('detail'), '打つ字が後ろに置かれている').toBeLessThan(msg.length / 2);
  });

  /** ⚠ 撃つ先を広げていないこと。 */
  it('⚠ 開く口は 1 回だけ呼ぶ', () => {
    const opened = vi.fn();
    const fail = vi.fn();
    connectViewDeepLink({
      openView: opened,
      fail,
      onViewChange: () => () => {},
      onSelectedEntry: () => () => {},
      target: {
        hash: '#pkc?view=query',
        clearHash: () => {},
        dropToken: () => {},
        setEntry: () => {},
        restoreHash: () => {},
      },
    });
    expect(opened).toHaveBeenCalledTimes(1);
    expect(fail, '同時に理由まで出している').not.toHaveBeenCalled();
  });
});

/**
 * 🔴 **別窓へ「読んでいたノート」を連れて行く**(#300 段③ の直し、2026-08-22)。
 *
 * ⚠ 直す前、別窓のカレンダーは `selectedLid === null` で立ち上がっていた ──
 * 帯は「日を押す前に、左の一覧からノートを選んでください」で、**その窓では
 * 日付を付けられない**。user は「カレンダーで日付を付けたい」から押したので、
 * これは動線が**目的の手前で切れている**形である(動線レビュー §1)。
 */
/**
 * 🔴 **引っ越した面の栞を、引っ越し先へ送る**(#292 段⑤、2026-08-23)。
 *
 * ## user から見た物語
 *
 * カレンダーを開いた状態でブックマークしていた。更新して、それを開く。
 * ⇒ 直す前:「画面名は detail / query / … のどれかです」だけが出る。
 *   ⚠ **どこへ移ったかを知っているのは実装した本人だけ**なので、user は探せない。
 * ⇒ いま:**左の列の「予定」が開き、どこへ移ったかが画面の下に出る。**
 *
 * ## ⚠ この describe が在るのは、変異試験が教えたからである
 *
 * 段⑤ の変異試験 N3(`MOVED_VIEWS` から `calendar` を落とす)が **SURVIVED** した
 * ── 引っ越しの機構を見ている unit が **1 件も無かった**。
 * 🔑 実装した当日に test を書かなかった、が原因である(smoke は在ったが、
 *   smoke は `dist` 経由なので変異試験の輪から外れる)。
 */
describe('引っ越した面の栞(#292 段⑤)', () => {
  const t = (hash: string): DeepLinkTarget => ({
    hash,
    clearHash: () => {},
    dropToken: () => {},
    setEntry: () => {},
    restoreHash: () => {},
  });

  /**
   * ⚠ **全数を当てる**(組み合わせが有限なら全部 ── CLAUDE.md)。
   * 🔑 表に足したのに配線しない、を止める。
   */
  it('🔴 引っ越した名前は、引っ越し先を返す(断らない)', () => {
    for (const name of ['calendar', 'kanban']) {
      expect(readViewDeepLink(t(`#pkc?view=${name}`)), `${name} の栞が死んでいる`).toEqual({
        moved: 'schedule',
      });
    }
  });

  /**
   * ⚠ **空振り防止** ── 「何でも `moved` を返す」実装でも上は通る。
   *   生きている面と、そもそも無い名前を対照群に置く。
   */
  it('⚠ 対照群 ── 生きている面はそのまま、知らない名前は断る', () => {
    expect(readViewDeepLink(t('#pkc?view=query'))).toEqual({ view: 'query' });
    expect(readViewDeepLink(t('#pkc?view=zzz'))).toEqual({ unusable: true });
  });

  /**
   * 🔴 **表は `isOpenable` より先に見る。**
   * ⚠ `VIEW_MODES` から名前を消した以上、順番を入れ替えると
   *   **引っ越しの枝に届く前に「使えない名前」として弾かれる**
   *   (= 栞が死ぬ)── だから順番そのものを pin する。
   * 🔑 見る形は「開ける面の一覧に**出ていない**のに、送り先が返ること」である。
   */
  it('🔴 引っ越した名前は開ける面の一覧に出ないが、栞としては生きている', () => {
    for (const name of ['calendar', 'kanban']) {
      expect(openableViewNames(), `${name} が開ける面として残っている`).not.toContain(name);
      expect(readViewDeepLink(t(`#pkc?view=${name}`)), `${name} が断られた`).toHaveProperty(
        'moved',
      );
    }
  });

  it('🔴 左の列のタブを開き、どこへ移ったかを出し、断片は消す', () => {
    const b = bench('#pkc?view=calendar');
    expect(b.actions, '引っ越し先を開いていない').toEqual(['browse:schedule', 'fail']);
    expect(b.failed(), 'どこへ移ったか言っていない').toBe(MOVED_MESSAGE);
    expect(b.failed(), '移った先の名前が文に無い').toContain('予定');
    // ⚠ 断片は残さない(読み直しのたびに同じ案内が出る)
    expect(b.cleared(), '使えない断片が残っている').toBe(1);
    expect(b.hash()).toBe('');
    b.off();
  });

  /**
   * 🔴 **中央の面は 1 ミリも触らない**(引っ越しの理由そのもの)。
   * ⚠ ここで `openView` を撃つと、栞から開いた人だけ**本文が消える**
   *   ── #300 で名指しされた実害が、栞の経路にだけ残ることになる。
   */
  it('🔴 中央の面は開かない(本文を占有しない)', () => {
    const b = bench('#pkc?view=kanban');
    expect(
      b.actions.filter((a) => a.startsWith('open:')),
      '中央の面を開いた(引っ越しの理由と正面から逆)',
    ).toEqual([]);
    b.off();
  });

  /** 🔑 連れてきたノートは、引っ越し先でも選ばれる(段③ と同じ約束)。 */
  it('連れてきたノートは、引っ越し先でも選ぶ', () => {
    const b = bench('#pkc?container=c1&entry=e7&view=calendar');
    expect(b.selects, 'ノートを置いてきた').toEqual([{ containerId: 'c1', lid: 'e7' }]);
    b.off();
  });
});

describe('連れてきたノートを選ぶ(#300 段③)', () => {
  it('🔴 `container` と `entry` が揃っていたら、面より先に選ぶ', () => {
    const b = bench('#pkc?container=c1&entry=e7&view=query');
    // 🔑 **順序が主張の一部** ── 面が先だと、開いた瞬間だけ
    //    「ノートを選んでください」が見えてから入れ替わる
    expect(b.actions, 'ノートを選んでいない / 面より後に選んでいる').toEqual([
      'select:e7',
      'open:query',
    ]);
    expect(b.selects).toEqual([{ containerId: 'c1', lid: 'e7' }]);
  });

  /**
   * 🔴 **`container` が無ければ連れて行かない。**
   * ⚠ 別の container の lid を拾うと、**偶然の一致で無関係なノートを選ぶ**
   *   (`SYS_BOOTED` が `cid` を突き合わせているのと同じ理由)。
   */
  it('🔴 `entry` だけでは選ばない(別の container の取り違えを作らない)', () => {
    const b = bench('#pkc?entry=e7&view=query');
    expect(b.actions).toEqual(['open:query']);
    expect(b.selects, 'container を検めずに選んだ').toEqual([]);
  });

  it('⚠ ノートが無い断片は今までどおり(面だけ開く)', () => {
    const b = bench('#pkc?view=query');
    expect(b.actions).toEqual(['open:query']);
  });
});

/**
 * 🔴 **開いた窓が「出ましたよ」と返す**(#300 段③ の直し)。
 *
 * ⚠ 直す前は「PKC が起動時に撒く名乗り」を聞いていたので、**別のタブの起動 /
 * 自タブの昇格 / 待機画面の再接続**で誤爆した ── 誤爆すると「開いた」と読み、
 * 塞がれた user には**退避も理由も出ない = 無言の dead click** になる。
 */
describe('開いた窓の合図(#300 段③)', () => {
  function tgt(hash: string) {
    const t = {
      hash,
      clearHash: () => {
        t.hash = '';
      },
      dropToken: () => {
        t.hash = dropViewWindowToken(t.hash);
      },
      setEntry: (containerId: string | null, lid: string) => {
        t.hash = setHashEntry(t.hash, containerId, lid);
      },
      restoreHash: (h: string) => {
        t.hash = h;
      },
    };
    return t;
  }

  it('🔴 合図を持って開かれた窓は、その合図をそのまま返す', () => {
    const sent: string[] = [];
    const t = tgt('#pkc?view=query&w=tok-1');
    expect(announceOpenedWindow(t, (token) => sent.push(token))).toBe(true);
    expect(sent, '合図を返していない(開いた側が塞がれたと誤読する)').toEqual(['tok-1']);
  });

  /**
   * 🔴 **合図は使ったらアドレスから外す。⚠ ただし `view` は残す。**
   * ⚠ 焼き付くと、ブックマークから開くたびに誰も聞いていない放送を撒く。
   * ⚠ `view` まで落とすと、段② の裁定(見ている間は残す / `F5` で戻る)が壊れる。
   */
  it('🔴 合図だけをアドレスから外す(面は残す)', () => {
    const t = tgt('#pkc?container=c1&entry=e7&view=query&w=tok-1');
    announceOpenedWindow(t, () => {});
    expect(t.hash, '合図が残った / 面まで落とした').toBe(
      '#pkc?container=c1&entry=e7&view=query',
    );
  });

  /** ⚠ **対照群** ── ふつうの起動では何も返さず、アドレスも触らない。 */
  it('⚠ 合図が無ければ何もしない', () => {
    const sent: string[] = [];
    const t = tgt('#pkc?view=query');
    expect(announceOpenedWindow(t, (x) => sent.push(x))).toBe(false);
    expect(sent).toEqual([]);
    expect(t.hash, 'アドレスを触った').toBe('#pkc?view=query');
  });
});

/**
 * 🔴 **「この窓はアプリの窓か」を、握っている間だけ真にする**(#300 段③ の直し)。
 *
 * 🔑 これで題名(タスクバーで見分ける)と `× 閉じる`(窓ごと閉じる)が決まる。
 * ⚠ 離れた窓は**ふつうの PKC** なので、そこで窓を閉じたら本文の作業ごと失う。
 */
describe('アプリの窓であることを伝える(#300 段③)', () => {
  it('🔴 開いたときに握り、user が離れたら手放す', () => {
    const b = bench('#pkc?view=query');
    expect(b.holds, '握ったことを伝えていない').toEqual(['query']);
    b.viewBecomes('detail');
    expect(b.holds, '離れたことを伝えていない(閉じるが窓を閉じ続ける)').toEqual([
      'query',
      null,
    ]);
  });

  /** ⚠ 同じ面に留まっている間は伝え直さない(題名が点滅しない)。 */
  it('⚠ 同じ面のままなら伝え直さない', () => {
    const b = bench('#pkc?view=query');
    b.viewBecomes('query');
    b.viewBecomes('query');
    expect(b.holds).toEqual(['query']);
  });

  it('⚠ 使えない名前では最初から握らない', () => {
    const b = bench('#pkc?view=zzz');
    expect(b.holds, '使えない名前でアプリの窓になった').toEqual([]);
  });
});

/**
 * 🔴 **いまのアドレスから断片を落とした base**(#300 段③)。
 *
 * ⚠ 守り手が 1 人もいなかった(着地前レビュー 10 の変異 M4)── `location.href`
 * をそのまま返す変異を当てると、**アプリの窓からもう 1 つアプリを開こうとした
 * ときだけ**「別の窓を開けませんでした」に落ちる(本体タブからは再現しない)。
 * ⚠ `document.baseURI` を使ってはいけない理由も同じ(**断片を含む**)。
 */
describe('currentBaseUrl(#300 段③)', () => {
  it('🔴 断片を落とす ── そのまま `formatViewDeepLink` に食える', () => {
    location.hash = '#pkc?view=query&w=tok-1';
    const base = currentBaseUrl();
    expect(base, '断片が残っている').not.toContain('#');
    // 🔑 **空振り防止** ── 断片がそもそも付いていなければ何も検めていない
    expect(location.href, '断片が付いていない(この test は何も検めていない)').toContain('#');
    expect(
      formatViewDeepLink(base, 'query'),
      'アプリの窓から次のアプリを開けない',
    ).toBe(`${base}#pkc?view=query`);
    location.hash = '';
  });
});

/**
 * 🔴 **窓の題名の形は 1 か所**(#300 段③ / #685 着地前レビュー ⚠3、2026-09-04)。
 *
 * ⚠ **タスクバーで見分けるため**に在る ── 直す前、付箋の窓は `onHold` を通らないので
 *   何枚開いても全部「PKC3」だった。付箋は「何枚でも開けます」が売りなので、
 *   この欠陥は**枚数に比例して効く**。
 */
/**
 * 🔴 **2 枚目を止めたときの字に、どの窓かを添える**(#690 I3、2026-09-04)。
 *
 * ⚠ 直す前は「すでに別のウィンドウで開いています」だけ ── 小窓を何枚も並べている人は
 *   タスクバーのどれを探せばよいか分からない。🔑 窓の題名(`windowTitleFor` の形)を
 *   添えれば、**タスクバーに出ている字と同じ字**で探せる。
 */
describe('2 枚目を止めたときの字(#690 I3)', () => {
  it('🔴 別の窓なら、その窓の題名を『題名 — PKC3』の形で添える', () => {
    const m = noteOpenElsewhereMessage('PKC3', 'ふたつめ');
    expect(m, '止めた理由が無い').toContain('すでに別のウィンドウで開いています');
    expect(m, 'どの窓か(題名)が無い').toContain('『ふたつめ — PKC3』');
    // ⚠ 形は `windowTitleFor` と同じ(タスクバーの字でそのまま探せる)
    expect(m).toContain(`『${windowTitleFor('PKC3', 'ふたつめ')}』`);
  });

  it('⚠ 題名の無いノートでは器の名前だけ(頭の欠けた字を出さない)', () => {
    expect(noteOpenElsewhereMessage('PKC3', null)).toContain('『PKC3』');
    expect(noteOpenElsewhereMessage('PKC3', '  ')).toContain('『PKC3』');
    expect(noteOpenElsewhereMessage('PKC3', null), '頭の欠けた字').not.toContain('『 — ');
  });

  /** ⚠ 対照群 ── いま見ている窓がそれなら、探す相手が居ないので題名は添えない。 */
  it('⚠ いま見ているこのウィンドウの字は題名を添えない', () => {
    expect(NOTE_OPEN_HERE_MESSAGE).toBe('このノートは、いま見ているこのウィンドウで開いています');
    expect(NOTE_OPEN_HERE_MESSAGE).not.toContain('『');
  });
});

describe('窓の題名(#685 着地前レビュー ⚠3)', () => {
  it('🔴 名前があれば「名前 — PKC3」', () => {
    expect(windowTitleFor('PKC3', '買い物メモ')).toBe('買い物メモ — PKC3');
  });

  /** ⚠ 名前が無いのは**ふつうの 1 枚目** ── 器の名前だけを出す。 */
  it('⚠ 名前が無ければ器の名前だけ', () => {
    expect(windowTitleFor('PKC3', null)).toBe('PKC3');
  });

  /**
   * 🔴 **空の題名を `null` と同じに扱う** ── 題名の無いノートを付箋にすると
   *   「 — PKC3」という**頭の欠けた字**がタスクバーに並ぶ。
   */
  it.each([
    ['空', ''],
    ['空白だけ', '   '],
  ])('🔴 %s の題名では、頭の欠けた字を出さない', (_name, label) => {
    expect(windowTitleFor('PKC3', label)).toBe('PKC3');
  });
});

/**
 * 🔴 **起動したときのお知らせを、1 つの物のために開いた窓では出さない**
 *   (#685 動線レビュー 欠陥 1 / 着地前レビュー ⚠4、2026-09-04)。
 *
 * ⚠ 切り出した理由は「`main.ts` に条件を書かない」ことなのに、
 *   切り出した先で**誰も見ていなかった**(変異 2 件がそのまま通った)。
 */
describe('1 つの物のために開いた窓か(#685)', () => {
  it('🔴 面を指した窓では出さない', () => {
    expect(isPurposeWindow({ view: 'dual', note: false })).toBe(true);
  });
  it('🔴 付箋でも出さない', () => {
    expect(isPurposeWindow({ view: null, note: true })).toBe(true);
  });
  /** ⚠ **対照群** ── ふつうの 1 枚目では今までどおり出す(「常に止める」実装で緑にしない)。 */
  it('⚠ ふつうの窓では今までどおり出す', () => {
    expect(isPurposeWindow({ view: null, note: false })).toBe(false);
  });
});

/**
 * 🔴 **「断片がノートを名指す」を「この窓は付箋だ」と読み替えない**
 *   (#685 着地前レビュー 🔴1、2026-09-04)。
 *
 * ⚠ その形の URL は **user が写して開く**(マニュアルがやり方まで書いている)。
 *   付箋扱いになると、そのタブでは「別の窓で開く」が**二度と効かない**。
 * 🔑 見分ける印は `w=`(こちらが開いた窓にしか付かず、起動直後に外れる)。
 */
describe('この窓はこちらが開いたものか(#685 着地前レビュー 🔴1)', () => {
  function store(seed: Record<string, string> = {}) {
    const m = new Map(Object.entries(seed));
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      seen: () => [...m.keys()],
    };
  }

  it('🔴 合図を持って起動したら、こちらが開いた窓である', () => {
    const s = store();
    expect(noteOpenedByUs(true, s)).toBe(true);
    expect(s.seen(), '控えていない(F5 で忘れる)').toEqual(['pkc3.opened-by-us']);
  });

  /** 🔴 **F5 を跨いでも保つ** ── 合図は起動直後にアドレスから外れる。 */
  it('🔴 一度こちらが開いた窓なら、読み直しても付箋のまま', () => {
    expect(noteOpenedByUs(false, store({ 'pkc3.opened-by-us': '1' }))).toBe(true);
  });

  /**
   * 🔴 **user が写した URL は付箋ではない**(この検査が本体)。
   * ⚠ 落ちると、そのタブで「別の窓で開く」が二度と効かなくなる。
   */
  it('🔴 写した URL で開いたふつうのタブは、付箋ではない', () => {
    expect(noteOpenedByUs(false, store())).toBe(false);
  });

  /** ⚠ 使えない箱(privacy 設定 / file://)では、その回の合図だけで決める。 */
  it('⚠ 控える場所が無くても落ちない', () => {
    expect(noteOpenedByUs(true, null)).toBe(true);
    expect(noteOpenedByUs(false, null)).toBe(false);
    const throwing = {
      getItem: () => {
        throw new Error('使えない');
      },
      setItem: () => {
        throw new Error('使えない');
      },
    };
    expect(() => noteOpenedByUs(true, throwing), '控えられない箱で落ちた').not.toThrow();
    expect(noteOpenedByUs(true, throwing)).toBe(true);
  });
});

/**
 * 🔴 **住所は、いま見ているノートへ追随する**(#689 案 B、2026-09-04)。
 *
 * ## user から見た物語(直す前)
 *
 * 1. 付箋を開く ⇒ アドレスは `#pkc?container=c1&entry=e1&w=…`
 * 2. `Alt+1` で本文へ戻る ⇒ `#pkc?container=c1&entry=e1`(住所は**わざと残す**)
 * 3. その窓で 30 分作業して、別のノートを開く ⇒ **アドレスは変わらない**
 * 4. `F5` ⇒ **30 分前のノートへ戻される**。`Ctrl+D` の栞もそちらを指す
 *
 * 🔑 面は「離れたら消す」、ノートは「**移った先へ書き換える**」── 非対称なのは、
 *   ノートには「離れる」が無いからである(必ずどれかを見ている)。
 */
describe('住所の追随(#689 案 B)', () => {
  it('🔴 別のノートを選ぶと、アドレスがそのノートを指す', () => {
    const b = bench('#pkc?container=c1&entry=e1');
    expect(b.selects, '前提が崩れた(連れてきたノートを選んでいない)').toEqual([
      { containerId: 'c1', lid: 'e1' },
    ]);
    b.selectBecomes('e2');
    expect(b.hash(), '住所が古いノートを指したまま').toBe('#pkc?container=c1&entry=e2');
    /**
     * 🔴 **毎回動く**(#689 着地前レビュー SM3)── 1 回だけ追随して固まる変異は、
     *   1 件しか押さない台では**生き延びる**。⚠ user から見た症状は
     *   「2 件目までは付いてくるのに、3 件目から固まる」= **#689 が半分だけ戻る**。
     */
    b.selectBecomes('e3');
    expect(b.hash(), '2 件目から住所が固まった').toBe('#pkc?container=c1&entry=e3');
  });

  /**
   * 🔴 **別の PKC の入れ物なら、住所に触らない**(動線レビュー 欠陥 1)。
   *
   * ⚠ もらったリンクを開いたタブでは、読む側が `cid` 違いで**断る**ので
   *   ノートは選ばれない。そこで自分のノートを選ぶと、1 稿目は住所を
   *   `container=他人 & entry=自分の lid` という**どこも指さない形**にしていた。
   * ⚠ しかも**もらったリンクの原文が上書きされて消える**ので、
   *   「開かないんだけど」と送り主に返す材料まで失われる。
   */
  it('🔴 もらった別 PKC のリンクは、1 バイトも書き換えない', () => {
    const b = bench('#pkc?container=other&entry=e1');
    b.selectBecomes('mine', 'c1');
    expect(b.hash(), 'よその入れ物の住所を書き換えた').toBe('#pkc?container=other&entry=e1');
  });

  /**
   * ⚠ **対照群 1** ── 何も選んでいない回(boot の途中 / 削除の直後)は触らない。
   *   ここで消すと**栞ごと消える**。
   */
  it('⚠ 何も選んでいない回は、住所を触らない', () => {
    const b = bench('#pkc?container=c1&entry=e1');
    b.selectBecomes(null);
    expect(b.hash(), '選んでいないのに住所を書き換えた').toBe('#pkc?container=c1&entry=e1');
  });

  /**
   * 🔴 **対照群 2** ── 名乗っていない窓(ふつうに開いた本体のタブ)には
   *   住所を生やさない。生やすと**全 user のアドレスが操作のたびに伸びる**。
   */
  it('🔴 名乗っていない窓のアドレスは伸びない', () => {
    const b = bench('');
    b.selectBecomes('e2');
    expect(b.hash(), '素のタブに住所が生えた').toBe('');
  });

  /**
   * 🔴 **面の窓でも追随する** ── `view=` を持っていても、見ているノートが
   *   移るのは同じである。⚠ 面の字は道連れにしない。
   */
  it('🔴 面の窓では、面を残したまま住所だけ動く', () => {
    const b = bench('#pkc?container=c1&entry=e1&view=dual');
    expect(b.actions, '前提が崩れた(面が開いていない)').toEqual(['select:e1', 'open:dual']);
    b.selectBecomes('e2');
    expect(b.hash()).toBe('#pkc?container=c1&entry=e2&view=dual');
  });

  /**
   * ⚠ **面を離れた後も効く** ── `Alt+1` で本文へ戻ると `clearHash` が走って
   *   `view` / `w` が落ちるが、住所は残る。⚠ #689 の物語はまさにこの後である。
   */
  it('⚠ 面を離れた後も、住所は追随し続ける', () => {
    const b = bench('#pkc?container=c1&entry=e1&view=dual&w=tok1');
    b.viewBecomes('detail');
    expect(b.hash(), '前提が崩れた(面と合図が落ちていない)').toBe('#pkc?container=c1&entry=e1');
    b.selectBecomes('e2');
    expect(b.hash()).toBe('#pkc?container=c1&entry=e2');
  });

  /** ⚠ 配線を解いたら、住所も動かなくなる(閉じたタブが state を掴み続けない)。 */
  it('⚠ 配線を解くと追随も止まる', () => {
    const b = bench('#pkc?container=c1&entry=e1');
    b.off();
    b.selectBecomes('e2');
    expect(b.hash(), '解いた後も住所を書き換えた').toBe('#pkc?container=c1&entry=e1');
  });
});

/**
 * 🔴 **目次・脚注で飛んでも、付箋の住所と身元を残す**(#693 案 A、2026-09-04)。
 *
 * ## 物語
 *
 * 付箋(`#pkc?container=…&entry=…` で開いた窓)で `:::toc` の見出しや脚注の数字を
 * 押す。目次・脚注のリンクは素の `<a href="#…">` なので、ブラウザが断片を
 * **`#midashi-1` に丸ごと入れ替える** → `hashchange`。
 * ⚠ 直す前はここで `apply` が「ノートを名指していない」と読んで
 * `holdEntry(false)` を撃ち、**題名が「PKC3」に戻る / 「複数タブ」の帯が復活する /
 * 同じノートの 2 枚目が開く / `F5` でノートが出ない / 住所の追随が止まる**が
 * 1 度の押下で全部起きていた。
 *
 * 🔑 直した後:飛びはそのまま、**飛んだ後で住所だけ元へ戻し、旗は降ろさない**。
 * ⚠ 本体の窓(付箋でない)では今までどおり(見出し id のアンカー #658 を壊さない)。
 */
describe('目次・脚注で飛んでも住所と身元を残す(#693 案 A)', () => {
  it('🔴 付箋で見出しへ飛んでも、旗は降りず住所は元へ戻る', () => {
    const b = bench('#pkc?container=c1&entry=e1');
    expect(b.noteHolds, '前提が崩れた(付箋の旗が立っていない)').toEqual([true]);
    b.hashBecomes('#midashi-1');
    expect(b.noteHolds, '見出しへ飛んだだけで付箋の旗が降りた(題名と帯が壊れる)').toEqual([true]);
    expect(b.hash(), '住所が見出し id のまま(F5 でノートが出ない)').toBe(
      '#pkc?container=c1&entry=e1',
    );
    expect(b.restored(), '戻す口を通っていない(別の理由で住所が合っている)').toBe(1);
    // ⚠ 飛びの後に `apply` を通していない ── 通すと選び直しが走る(#685 M4 の対照群と同じ)
    expect(b.actions, '見出しへ飛んだだけでノートを選び直した').toEqual(['select:e1']);
  });

  /**
   * 🔴 **戻す先は「いま見ているノート」**(#689 の追随と繋がっていること)。
   * ⚠ 開いたときの住所を戻すと、ノートを移った後の飛びで**最初のノート**へ
   *   住所が巻き戻る ── `F5` が 30 分前のノートへ戻る #689 の再来になる。
   */
  it('🔴 ノートを移った後に飛んだら、戻る先は移った先の住所', () => {
    const b = bench('#pkc?container=c1&entry=e1');
    b.selectBecomes('e2');
    expect(b.hash(), '前提が崩れた(追随していない)').toBe('#pkc?container=c1&entry=e2');
    b.hashBecomes('#midashi-1');
    expect(b.hash(), '最初のノートの住所へ巻き戻った').toBe('#pkc?container=c1&entry=e2');
    expect(b.noteHolds).toEqual([true]);
  });

  /** ⚠ 2 度目・3 度目も同じ(1 回だけ戻して固まる変異を殺す)。 */
  it('⚠ 何度飛んでも毎回戻る', () => {
    const b = bench('#pkc?container=c1&entry=e1');
    b.hashBecomes('#midashi-1');
    b.hashBecomes('#midashi-2');
    b.hashBecomes('#fn-1');
    expect(b.restored(), '2 回目から戻らなくなった').toBe(3);
    expect(b.hash()).toBe('#pkc?container=c1&entry=e1');
    expect(b.noteHolds).toEqual([true]);
  });

  /**
   * ⚠ **対照群 1** ── 付箋でない窓(断片の無い本体のタブ)では今までどおり。
   *   見出し id のアンカーリンク(#658)を壊さない ── 住所は `#midashi-1` のまま。
   */
  it('⚠ 本体の窓では住所を触らない(見出しのアンカーは今までどおり)', () => {
    const b = bench('');
    b.hashBecomes('#midashi-1');
    expect(b.hash(), '付箋でないのに住所を書き換えた').toBe('#midashi-1');
    expect(b.restored()).toBe(0);
    expect(b.noteHolds, '素の窓で付箋の旗が動いた').toEqual([]);
  });

  /**
   * ⚠ **対照群 2** ── PKC の断片へ書き換わったときは、今までどおり `apply` を通す
   *   (面を指し直せば旗が倒れる ── 「付箋の旗」の describe と同じ主張)。
   *   ⚠ ここを「戻す」に巻き込むと、**面へ移る正しい書き換えまで巻き戻す**。
   */
  it('⚠ 面を指す断片へ書き換わったら、戻さずに面へ移る', () => {
    const b = bench('#pkc?container=c1&entry=e1');
    b.hashBecomes('#pkc?view=dual');
    expect(b.restored(), '面への書き換えを巻き戻した').toBe(0);
    expect(b.noteHolds, '面を指したのに付箋の旗が立ったまま').toEqual([true, false]);
    expect(b.actions).toEqual(['select:e1', 'open:dual']);
  });

  /**
   * ⚠ **対照群 3** ── 旗が倒れた後(面を指し直した後)の飛びは戻さない。
   *   戻す先は控えてあるが、**もう付箋ではない**(#685 の「面を指す断片へ書き換わると
   *   付箋の旗が倒れる」)。⚠ この 1 件が無いと、`heldEntry` の門を外す変異が生き延びる
   *   (2026-09-04 の変異試験 M1 で実測 ── 本体の窓は `entryHash === null` に救われていた)。
   */
  it('⚠ 付箋でなくなった後の飛びは戻さない(旗が倒れたら住所も握らない)', () => {
    const b = bench('#pkc?container=c1&entry=e1');
    b.hashBecomes('#pkc?view=dual');
    expect(b.noteHolds, '前提が崩れた(面を指しても旗が倒れていない)').toEqual([true, false]);
    b.hashBecomes('#midashi-1');
    expect(b.hash(), '付箋でなくなった窓で古い住所へ巻き戻した').toBe('#midashi-1');
    expect(b.restored()).toBe(0);
  });

  /** ⚠ 空の断片(user が消した)は「飛び先」ではないので、戻さず今までどおり旗が倒れる。 */
  it('⚠ 断片を空にしたら戻さない(飛びではなく「消した」)', () => {
    const b = bench('#pkc?container=c1&entry=e1');
    b.hashBecomes('');
    expect(b.restored()).toBe(0);
    expect(b.noteHolds).toEqual([true, false]);
  });

  /** ⚠ 配線を解いた後の `hashchange` は誰も受けない(閉じたタブが住所を書かない)。 */
  it('⚠ 配線を解いたら戻さない', () => {
    const b = bench('#pkc?container=c1&entry=e1');
    b.off();
    b.hashBecomes('#midashi-1');
    expect(b.hash()).toBe('#midashi-1');
    expect(b.restored()).toBe(0);
  });
});
