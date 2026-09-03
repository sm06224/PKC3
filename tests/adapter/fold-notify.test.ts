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
    sayFolded('幅が足りないので、横に並べる枠を 2 枚畳みました');
    expect(said, 'PC で畳みの理由を言わない(#606 が直した欠陥が戻っている)').toEqual([
      '幅が足りないので、横に並べる枠を 2 枚畳みました',
    ]);
  });

  /**
   * 🔴 **スマホでは黙る**(#632 段③)。⚠ 対照群を**同じ it に置く** ── 置かないと
   *   「口を配り忘れていて黙っていた」と区別が付かない(§1「別の理由で緑」)。
   */
  it('🔴 スマホでは、畳んだ理由を言わない(起きていないことを言わない)', () => {
    const s = install(true);
    const said: string[] = [];
    setFoldNotify((t) => said.push(t));
    sayFolded('幅が足りないので、横に並べる枠を 2 枚畳みました');
    expect(said, 'スマホで畳みの理由を言っている').toEqual([]);

    // 🔑 対照群 ── 同じ口・同じ文で、PC の幅に戻せば言う(口は生きている)
    s.media.set(false);
    sayFolded('幅が足りないので、横に並べる枠を 2 枚畳みました');
    expect(said, '口が死んでいた(上の空振りは黙ったからではない)').toHaveLength(1);
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

  it('⚠ 文言は「対応していない」と「360px 以上」を両方言う(何をすればよいか書く)', () => {
    expect(TOO_NARROW_TEXT, '何が起きているか書いていない').toContain('対応していません');
    expect(TOO_NARROW_TEXT, `${PHONE_MIN_PX}px 以上、と書いていない`).toContain(
      `${PHONE_MIN_PX}px`,
    );
    expect(TOO_NARROW_TEXT, '画面を止めないことを書いていない').toContain('止めません');
  });
});
