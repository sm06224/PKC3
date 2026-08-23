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
  announceOpenedWindow,
  connectViewDeepLink,
  currentBaseUrl,
  openableViewNames,
  readViewDeepLink,
  unusableViewMessage,
  type DeepLinkTarget,
} from '../../src/adapter/platform/deep-link';
import { VIEW_MODES, type ViewMode } from '../../src/adapter/state/app-state';
import { dropViewWindowToken, formatViewDeepLink } from '../../src/features/link/permalink';

/** 的 + 面の購読 + 断片の購読を 1 つにした試験台。 */
function bench(hash: string) {
  let cleared = 0;
  /** 撃たれたもの。`open:<面>` か `fail`。 */
  const actions: string[] = [];
  let viewListener: ((v: ViewMode) => void) | null = null;
  let hashListener: (() => void) | null = null;
  /**
   * ⚠ **本物と同じ意味論にする**(CLAUDE.md §3)── 本物は getter で、
   *   消した後は `view` の無い断片を返す。ここでは空に落として同じ形にする。
   */
  const target: DeepLinkTarget & { hash: string } = {
    hash,
    clearHash: () => {
      cleared += 1;
      target.hash = '';
    },
    dropToken: () => {
      target.hash = dropViewWindowToken(target.hash);
    },
  };
  let failed: string | null = null;
  /** 連れてきたノート(#300 段③ の直し)。 */
  const selects: Array<{ containerId: string; lid: string }> = [];
  /** 断片が指している面の遷移(`null` = 離れた)。 */
  const holds: Array<ViewMode | null> = [];
  const off = connectViewDeepLink({
    openView: (mode) => actions.push(`open:${mode}`),
    // 🔴 **引っ越した面の受け皿**(#292 段⑤)── 左の列のタブ
    openBrowse: (mode) => actions.push(`browse:${mode}`),
    selectEntry: (containerId, lid) => {
      selects.push({ containerId, lid });
      actions.push(`select:${lid}`);
    },
    onHold: (v) => holds.push(v),
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
    target,
  });
  return {
    actions,
    failed: () => failed,
    off,
    cleared: () => cleared,
    hash: () => target.hash,
    /** 面が変わったことにする(アプリ側の購読が呼ぶのと同じ)。 */
    viewBecomes: (v: ViewMode) => viewListener?.(v),
    /** アドレスの断片が書き換わったことにする。 */
    hashBecomes: (h: string) => {
      target.hash = h;
      hashListener?.();
    },
    subscribed: () => ({ view: viewListener !== null, hash: hashListener !== null }),
    selects,
    holds,
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
    for (const hash of ['', '#', '#pkc?container=c1&entry=e1', '#other?view=query']) {
      const b = bench(hash);
      expect(b.actions, `${JSON.stringify(hash)} で面を動かした`).toEqual([]);
      expect(b.cleared(), `${JSON.stringify(hash)} で断片を消した`).toBe(0);
    }
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
    expect(b.subscribed()).toEqual({ view: true, hash: true });
    b.off();
    expect(b.subscribed(), '購読が残っている').toEqual({ view: false, hash: false });
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
      target: { hash: '#pkc?view=query', clearHash: () => {}, dropToken: () => {} },
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
