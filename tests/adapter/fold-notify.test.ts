/** @vitest-environment happy-dom */
/**
 * 「幅が足りないので畳んだ」を言う口(#606)。実体は
 * `src/adapter/ui/render/fold-notify.ts`。
 *
 * 🔴 守る主張:
 * 1. 口は **1 つ**(`setFoldNotify`)── 段組みも横に並べた枠もここを通る
 * 2. 🔴 **スマホでは畳みの知らせを言わない** ── あの画面は「幅が足りないから
 *    畳んでいる」のではなく **1 枚ずつ出すのが既定**である。言うと
 *    **起きていないこと**を言うことになり、しかも user にできることが 1 つも無い
 * 3. ⚠ **横に並べる枠のほうは、スマホでも言う** ── そちらは本当に幅で落ちている
 *
 * ⚠ **対応外の幅の断り書きは、もうここを通らない**(user 裁定 2026-09-04、#671)──
 *   「OK 押したら消える」= 押せる物が要るので器から違う。移した先の test は
 *   `tests/adapter/too-narrow.test.ts`。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sayFolded, setFoldNotify } from '../../src/adapter/ui/render/fold-notify';
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
   * 🔴 黙らせると、user が押した「このノートをスタックに載せる」が**無言で効かない**。
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
