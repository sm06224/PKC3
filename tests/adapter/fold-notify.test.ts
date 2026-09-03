/** @vitest-environment happy-dom */
/**
 * 「幅が足りないので畳んだ」と「この幅には対応していない」を言う口(#606 / #632 段③)。
 * 実体は `src/adapter/ui/render/fold-notify.ts`。
 *
 * 🔴 守る主張:
 * 1. 口は **1 つ**(`setFoldNotify`)── 段組みも横に並べた枠も対応外もここを通る
 * 2. 🔴 **スマホでは畳みの知らせを言わない** ── あの画面は「幅が足りないから
 *    畳んでいる」のではなく **1 枚ずつ出すのが既定**である。言うと
 *    **起きていないこと**を言うことになり、しかも user にできることが 1 つも無い
 * 3. ⚠ **対応外の 1 行は逆で、スマホより狭いときにだけ鳴る** ── 黙る条件が
 *    正反対なので、片方の条件をもう片方へ流用すると**どちらかが必ず壊れる**
 * 4. 口を外したら購読も外れる(`null` を渡した test が次の test へ state を持ち越さない)
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  TOO_NARROW_TEXT,
  sayFolded,
  setFoldNotify,
} from '../../src/adapter/ui/render/fold-notify';
import { appPhone } from '../../src/adapter/ui/render/phone-layout';
import { PHONE_MIN_PX } from '../../src/features/phone-layout';

/** 幅の見張りの替え玉。⚠ `matches` を手で動かして `change` を撃つ。 */
class FakeMedia {
  matches: boolean;
  private readonly fns: (() => void)[] = [];
  constructor(matches: boolean) {
    this.matches = matches;
  }
  addEventListener(_t: 'change', fn: () => void): void {
    this.fns.push(fn);
  }
  removeEventListener(_t: 'change', fn: () => void): void {
    const i = this.fns.indexOf(fn);
    if (i >= 0) this.fns.splice(i, 1);
  }
  set(v: boolean): void {
    this.matches = v;
    for (const fn of [...this.fns]) fn();
  }
}

/**
 * 版面を建て直す。⚠ **問い合わせごとに別の替え玉**を返す ── 1 本しか返さないと
 * 「スマホ = 対応外」になり、360〜720px という**いちばん普通の幅**が測れない。
 */
function install(phone: boolean, narrowNow = false) {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const media = new FakeMedia(phone);
  const narrow = new FakeMedia(narrowNow);
  appPhone.install(root, (q) => (q.includes(`${PHONE_MIN_PX - 1}px`) ? narrow : media));
  return { media, narrow };
}

afterEach(() => {
  // ⚠ 口も版面も戻す ── 残すと別の file の test が phone のまま / 帯付きで走る
  setFoldNotify(null);
  document.body.textContent = '';
  appPhone.install(document.createElement('div'), () => new FakeMedia(false));
});

describe('畳みの知らせ', () => {
  it('🔴 PC の幅では、畳んだ理由を言う', () => {
    install(false);
    const said: string[] = [];
    setFoldNotify((t) => said.push(t));
    sayFolded('幅が足りないので段組みをやめました');
    expect(said, 'PC で畳みの理由を言わない(#606 が直した欠陥が戻っている)').toEqual([
      '幅が足りないので段組みをやめました',
    ]);
  });

  /**
   * 🔴 **この口はスマホでも黙らない**(#632 段③ の着地前レビューで直した)。
   *
   * ⚠ 1 稿目は `sayFolded` の中に `if (appPhone.isPhone()) return;` を置いたが、
   *   **この口を通る知らせは 2 種類あって、黙ってよい理由が片方にしか無い**:
   *   段組みは「1 枚ずつ出すのが既定」なので黙ってよいが、
   *   **横に並べる枠は本当に幅で落ちている**(1 枚あたり約 448px 要る)。
   * 🔴 黙らせると、user が押した「このノートを横に留める」が**無言で効かない**。
   * 🔑 だから黙る判断は**呼び元**(`read-columns.ts`)が持ち、この口は素通しにした。
   *   ⚠ ここでその形を pin しないと、共有の口へ門を戻す変異が**誰にも気づかれない**。
   */
  it('🔴 スマホでも、横に並べる枠を畳んだ理由は言う(押した操作を無言にしない)', () => {
    const s = install(true);
    const said: string[] = [];
    setFoldNotify((t) => said.push(t));
    sayFolded('幅が足りないので、横に並べる枠を 2 枚畳みました');
    expect(said, 'スマホで枠の理由まで黙らせている(押しても何も起きない操作になる)').toEqual([
      '幅が足りないので、横に並べる枠を 2 枚畳みました',
    ]);

    // 🔑 対照群 ── PC の幅でも同じく言う(スマホだけ特別扱いしていない)
    s.media.set(false);
    sayFolded('幅が足りないので、横に並べる枠を 2 枚畳みました');
    expect(said, 'PC で言わなくなった').toHaveLength(2);
  });

  it('⚠ 口が配られていなければ黙る(test や別の窓は帯を持たない)', () => {
    install(false);
    setFoldNotify(null);
    expect(() => sayFolded('畳みました')).not.toThrow();
  });
});

describe('対応外の幅の 1 行', () => {
  /**
   * 🔴 **黙る条件は畳みと正反対である** ── スマホより**狭い**ときにだけ鳴る。
   * ⚠ それでも**帯の口は 1 つ**にする(#606:口が 2 つある限り、片方を配線し
   *   忘れても誰も気づかない)。
   */
  it('🔴 対応外の幅になったら、同じ口から 1 行出る', () => {
    const s = install(true);
    const said: string[] = [];
    setFoldNotify((t) => said.push(t));
    expect(said, '対応している幅なのに言った').toEqual([]);
    s.narrow.set(true);
    expect(said, '対応外になっても言わない').toEqual([TOO_NARROW_TEXT]);
  });

  /**
   * 🔴 **広げたら消える**(着地前の動線レビューで直した)。
   *
   * ⚠ 1 稿目は「狭くなった」しか伝えなかったので、**窓を広げても字が残った** ──
   *   対応している幅で「対応していません」と書いてある = **画面が嘘をつく**うえ、
   *   状態の行は 1 行しか無いので**本当に読ませたい文を押し出す**
   *   (#300 段④ が常設バッジを外したのと同じ形)。
   * ⚠ **空文字を配る**のが消し方である(`showStatus('')` が帯の枠を畳む)。
   */
  it('🔴 対応する幅へ戻したら、その行が消える', () => {
    const s = install(true);
    const said: string[] = [];
    setFoldNotify((t) => said.push(t));
    s.narrow.set(true);
    expect(said, '前提が崩れた(狭くしても出ていない)').toEqual([TOO_NARROW_TEXT]);
    s.narrow.set(false);
    expect(said, '広げても消えない(対応している幅で「対応していません」と出たまま)').toEqual([
      TOO_NARROW_TEXT,
      '',
    ]);
  });

  /**
   * 🔴 **同じ値は続けて伝えない**(user 裁定 ⑥「1 度だけ」)。
   * ⚠ 「消せるようにした」ことで**毎回言う**側へ倒れていないかを見る ──
   *   狭いままの `change` は何度来ても 1 回しか言わない。
   */
  it('🔴 狭いまま何度知らせが来ても、字は 1 回しか出ない', () => {
    const s = install(true);
    const said: string[] = [];
    setFoldNotify((t) => said.push(t));
    s.narrow.set(true);
    s.narrow.set(true);
    s.narrow.set(true);
    expect(said, '狭いままなのに繰り返し言っている(帯が知らせで埋まる)').toEqual([
      TOO_NARROW_TEXT,
    ]);
  });

  /** ⚠ 対照群 ── 広い窓で立ち上げた回に、**帯を勝手に消しに行かない**。 */
  it('🔴 広い窓で口を繋いだだけでは、何も配らない', () => {
    install(true);
    const said: string[] = [];
    setFoldNotify((t) => said.push(t));
    expect(said, '何も言っていないのに帯を触っている(別の知らせを消す)').toEqual([]);
  });

  /**
   * 🔴 **版面を張り直したら購読は捨てられる**(着地前レビュー 4)。
   * ⚠ `install()` は先頭で `dispose()` を呼ぶので `narrowSubs` は空になる ──
   *   つまり **`install` を `setFoldNotify` の後で呼ぶと、この 1 行は永久に死ぬ**。
   *   いま呼び元は起動の 1 か所だけだが、順番を入れ替える変異を
   *   unit でも殺せるようにここで pin する。
   */
  it('⚠ 版面を張り直すと購読は捨てられる(口を配り直すまで鳴らない)', () => {
    install(true);
    const said: string[] = [];
    setFoldNotify((t) => said.push(t));
    install(true, true); // 張り直す ── 前の購読は捨てられる
    expect(said, '捨てたはずの購読へまだ流している').toEqual([]);
    setFoldNotify((t) => said.push(t)); // 配り直せば鳴る(対照群)
    expect(said, '配り直しても鳴らない').toEqual([TOO_NARROW_TEXT]);
  });

  it('🔴 起動した時点でもう狭ければ、口を繋いだ瞬間に出る', () => {
    install(true, true);
    const said: string[] = [];
    setFoldNotify((t) => said.push(t));
    expect(said, '細い端末で 1 度も言わない').toEqual([TOO_NARROW_TEXT]);
  });

  /**
   * 🔴 **口を差し替えたら、前の口には流れない**。
   * ⚠ これが無いと、`setFoldNotify` を呼ぶたびに購読が積まれ、
   *   **同じ知らせが呼んだ回数だけ**出る(帯が埋まる)。
   */
  it('🔴 口を差し替えたら、古い口へは流れない', () => {
    const s = install(true);
    const old: string[] = [];
    const now: string[] = [];
    setFoldNotify((t) => old.push(t));
    setFoldNotify((t) => now.push(t));
    s.narrow.set(true);
    expect(old, '古い口へまだ流している').toEqual([]);
    expect(now, '新しい口へ流れていない').toEqual([TOO_NARROW_TEXT]);
  });

  /**
   * ⚠ **字の長さも主張である**(着地前レビュー)── 状態の行は `height: 20px` 固定で
   *   `overflow` を持たないので、収まらない字は**画面の外へ落ちる**。
   *   実測(340px・11px):「(画面は止めません)」を足すと `scrollHeight 25 / 20`、
   *   外すと `20 / 20`。🔑 **いちばん狭い画面へ向けた字は、その画面で測る**
   *   (実ブラウザの腕は `tests/smoke/phone.smoke.spec.ts` の 340px に在る)。
   */
  it('⚠ 文言は「対応していない」と「360px 以上」を言い、短く保つ', () => {
    expect(TOO_NARROW_TEXT, '何が起きているか書いていない').toContain('対応していません');
    expect(TOO_NARROW_TEXT, `${PHONE_MIN_PX}px 以上、と書いていない`).toContain(
      `${PHONE_MIN_PX}px`,
    );
    /**
     * ⚠ **実測した長さで留める** ── 340px・11px の帯で、**33 字は `20 / 20` で収まり、
     *   43 字は `25 / 20` ではみ出した**。あいだは測っていないので、
     *   通ったのを見た **33** を上限にする(伸ばすなら測り直してからにする)。
     * 🔑 はみ出しそのものは実ブラウザで見る(`phone.smoke.spec.ts` の 340px の腕)。
     */
    expect(TOO_NARROW_TEXT.length, '長すぎて 340px の帯からはみ出す').toBeLessThanOrEqual(33);
  });
});
