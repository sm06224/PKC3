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
  connectViewDeepLink,
  openableViewNames,
  readViewDeepLink,
  unusableViewMessage,
  type DeepLinkTarget,
} from '../../src/adapter/platform/deep-link';
import { VIEW_MODES, type ViewMode } from '../../src/adapter/state/app-state';

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
  };
  let failed: string | null = null;
  const off = connectViewDeepLink({
    openView: (mode) => actions.push(`open:${mode}`),
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
  };
}

describe('起動時のディープリンク(#300 段②)', () => {
  it('🔴 `#pkc?view=calendar` でカレンダーの面が開く', () => {
    const b = bench('#pkc?view=calendar');
    expect(b.actions, 'その面で開いていない').toEqual(['open:calendar']);
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
    const b = bench('#pkc?view=kanban');
    expect(b.cleared(), '開いた時点で断片を消している').toBe(0);
    expect(b.hash(), 'アドレスから字が消えている').toBe('#pkc?view=kanban');
    // ⚠ 自分が撃った面の通知で消してしまわないこと(いちばん出やすい取り違え)
    b.viewBecomes('kanban');
    expect(b.cleared(), '自分が開いた面の通知で消している').toBe(0);
  });

  it('🔴 user が別の面へ移ったら、その瞬間に断片を消す', () => {
    const b = bench('#pkc?view=kanban');
    b.viewBecomes('detail');
    expect(b.cleared(), '離れても断片が残る ── 読み直しでこの面へ飛ばされる').toBe(1);
    expect(b.hash()).toBe('');
    // ⚠ 一度消したら、その後の面の移動で二重に消さない
    b.viewBecomes('calendar');
    expect(b.cleared(), '離れるたびに消しにいっている').toBe(1);
  });

  it('🔴 使えない名前は、黙って捨てず理由を出す(打つ字を見せる)', () => {
    const b = bench('#pkc?view=nonsense');
    expect(b.actions, '面を開こうとした(型に無い値が state に入る)').toEqual(['fail']);
    const error = b.failed() ?? '';
    // ⚠ **打ち間違いの綴りをそのまま画面へ通さない**
    expect(error, '外から来た綴りをそのまま出している').not.toContain('nonsense');
    // 🔑 **打てる字**を出す(画面の呼び名を出すと、user は打てない字で書き直す)
    expect(error, 'アドレスに打つ字が出ていない').toContain('calendar');
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
    for (const hash of ['', '#', '#pkc?container=c1&entry=e1', '#other?view=calendar']) {
      const b = bench(hash);
      expect(b.actions, `${JSON.stringify(hash)} で面を動かした`).toEqual([]);
      expect(b.cleared(), `${JSON.stringify(hash)} で断片を消した`).toBe(0);
    }
  });

  /** ⚠ 他の key と併記できる(将来「このノートを 2 ペインで」を組めるように)。 */
  it('⚠ 他の key と併記しても view が読める', () => {
    expect(bench('#pkc?container=c1&entry=e1&view=dual').actions).toEqual(['open:dual']);
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
    const t = (hash: string): DeepLinkTarget => ({ hash, clearHash: () => {} });
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
      target: { hash: '#pkc?view=query', clearHash: () => {} },
    });
    expect(opened).toHaveBeenCalledTimes(1);
    expect(fail, '同時に理由まで出している').not.toHaveBeenCalled();
  });
});
