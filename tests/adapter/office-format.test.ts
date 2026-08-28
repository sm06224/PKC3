/** @vitest-environment happy-dom */
/**
 * 🔴 **この形式は、この Office で保存できるか**(#225)。
 *
 * ## 判定は「形式」だけでは決まらない ── **入っている一式**にもよる
 *
 * LO は非 ODF で保存するとき必ず「標準のファイル形式ではありません」と訊く。
 * その `cui/ui/querydialog.ui` が入っていない一式では例外になり、画面には
 * 「一般的な I/O エラー」しか出ない ── **押すまで分からない**。
 *
 * | | 古い一式(`.ui` が無い) | 直した一式(`.ui` が在る) |
 * |---|---|---|
 * | ODF(`.odt` ほか) | ✅ 保存できる | ✅ 保存できる |
 * | 非 ODF 7 種 | 🔴 「一般的な I/O エラー」 | ✅ 訊かれて、答えると書ける |
 *
 * 実測(2026-08-24、直した一式 `lo-06c7bd033c1d`。自作の文書を同じ腕で):
 * `.rtf` 1,434 → **3,211** / `.doc` 8,704 → **9,216** / `.docx` 1,269 → **5,987** /
 * `.xls` 5,632 → 5,632(**mtime は動く**) / `.xlsx` 5,439 → **7,196** /
 * `.ppt` 459,264 → **460,288** / `.pptx` 7,947 → **11,418**。
 *
 * 🔴 **`.xls` は大きさが動かない** ── BIFF は区画の大きさが決まっているため。
 * ⚠ 大きさだけを見ていたら「保存できない」と読み違えていた。
 *
 * ⚠ `public/office/office-format.js` は **bundle されない素の JS**(`host.html` が
 * `<script src>` で読む)。`readFileSync` + `new Function` で読み込んで当てる ──
 * これをやらないと、この判断は**どの test からも実行されない**。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isOfficeAttachment } from '../../src/features/office/office-entry';

interface Api {
  SAVABLE_EXTS: string[];
  ALIEN_SAVABLE_EXTS: string[];
  ALIEN_DIALOG_MARK: string;
  ALIEN_DIALOG_MARK_OLD: string;
  extOf(name: unknown): string;
  isSavable(name: unknown, alienOk?: unknown): boolean;
  packSavesAlien(metaText: unknown): boolean;
}

function load(): Api {
  const src = readFileSync('public/office/office-format.js', 'utf-8');
  const scope: Record<string, unknown> = {};
  new Function('globalThis', src)(scope);
  const api = scope.PKC3OfficeFormat as Api | undefined;
  expect(api, '素の JS が globalThis へ何も置いていない').toBeTruthy();
  return api!;
}

const api = load();

describe('保存できる形式', () => {
  it('🔴 どの一式でも保存できるのは ODF の 4 つだけ(等値 pin)', () => {
    // ⚠ 等値で pin する ── 「1 件以上ある」では、こっそり増えたのを検出できない。
    //    🔑 **4 つとも実測済み**。増やすには実測が要る(この list に入れる =
    //    user へ「保存できます」と言うことである)
    expect(api.SAVABLE_EXTS).toEqual(['.odt', '.ods', '.odp', '.odg']);
  });

  it('🔴 確認ダイアログを持つ一式でだけ保存できるのは 7 つ(等値 pin)', () => {
    // 🔑 **7 つとも実測済み**(上の docstring の表)。⚠ 足すには実測が要る
    expect(api.ALIEN_SAVABLE_EXTS).toEqual([
      '.rtf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    ]);
  });

  it('ODF はどちらの一式でも保存できる', () => {
    for (const ok of ['a.odt', 'a.ods', 'a.odp', 'a.odg']) {
      expect(api.isSavable(ok, false), `${ok} を保存できないと言っている`).toBe(true);
      expect(api.isSavable(ok, true), `${ok} を保存できないと言っている`).toBe(true);
    }
  });

  it('🔴 古い一式では非 ODF を断る / 直した一式では通す(同じ形式で対にして見る)', () => {
    for (const ng of ['a.rtf', 'a.doc', 'a.docx', 'a.xls', 'a.xlsx', 'a.ppt', 'a.pptx']) {
      expect(api.isSavable(ng, false), `古い一式で ${ng} を保存できると言っている`).toBe(false);
      expect(api.isSavable(ng, true), `直した一式で ${ng} を断っている`).toBe(true);
    }
  });

  it('🔴 引数を落としたら断る側へ倒れる(安全側 ── 対照群つき)', () => {
    // ⚠ ここが逆だと、呼び側が 1 か所渡し忘れただけで**嘘の「保存できます」**になる。
    //    🔑 対照群を同じ it に置く ── 「渡せば通る」ことも一緒に見ないと、
    //    「そもそも常に false」という別の壊れ方と区別できない
    expect(api.isSavable('a.docx'), '引数なしで保存できると言っている').toBe(false);
    expect(api.isSavable('a.docx', undefined), 'undefined で保存できると言っている').toBe(false);
    expect(api.isSavable('a.docx', null), 'null で保存できると言っている').toBe(false);
    // ⚠ 真偽値以外の truthy を真として扱わない(`'false'` は文字列である)
    expect(api.isSavable('a.docx', 'false'), '文字列を真として扱っている').toBe(false);
    expect(api.isSavable('a.docx', 1), '1 を真として扱っている').toBe(false);
    // 対照群 ── ちゃんと渡せば通る
    expect(api.isSavable('a.docx', true), '渡しても通らない').toBe(true);
  });

  it('🔴 直した一式でも、測っていない形式は断る', () => {
    // ⚠ flat ODF(`.fodt` ほか)は 1 枚の XML でパッケージ格納形式ではない ──
    //    分かれ目のどちら側かを**測っていない**ので、真にしてはいけない。
    //    🔑 「できる」と言って失うほうが、「できない」と言って驚かせるより痛い
    for (const unknown of ['a.fodt', 'a.fods', 'a.fodp']) {
      expect(api.isSavable(unknown, true), `${unknown} を測らずに保存できると言っている`).toBe(
        false,
      );
    }
  });

  it('🔴 名前が無い / 拡張子が無いときは断らない(窓の中の新規は ODF になる)', () => {
    // ⚠ ここを false にすると、窓の中で新規に作った文書に「保存できません」と
    //    出る ── **嘘**である(既定は ODF なので保存できる)
    for (const alienOk of [false, true]) {
      expect(api.isSavable('', alienOk)).toBe(true);
      expect(api.isSavable('無題 1', alienOk)).toBe(true);
      expect(api.isSavable(null, alienOk)).toBe(true);
      expect(api.isSavable(undefined, alienOk)).toBe(true);
    }
  });

  it('大文字・前後の空白で取り違えない', () => {
    expect(api.isSavable('  A.ODT  ', false)).toBe(true);
    expect(api.isSavable('A.DOCX', false)).toBe(false);
    expect(api.isSavable('A.DOCX', true)).toBe(true);
    expect(api.extOf('x/y/報告.Odt')).toBe('.odt');
    expect(api.extOf('拡張子なし')).toBe('');
  });
});

/**
 * 🔴 **一式の目録から「非 ODF を保存できるか」を読む**(`packSavesAlien`)。
 *
 * ⚠ ここは**部分一致で書くと必ず壊れる** ── 古い一式にも
 * `vcl/ui/querydialog.ui` / `modules/scalc/ui/recalcquerydialog.ui` /
 * `sfx/ui/safemodequerydialog.ui` が入っており、`querydialog.ui` を含むかで
 * 見ると**常に真**になる(2026-08-24 に実際に踏みかけた)。
 *
 * 🔑 下の断片は**実物の目録から採った**(古い一式 4 つ = 完全一致 0 件 / 部分一致 3 件、
 * 直した一式 = 1 件 / 4 件)。
 */
describe('一式が非 ODF を保存できるか', () => {
  const P = '"filename":"/instdir/share/config/soffice.cfg';
  /** 古い一式にも在る「囮」3 つ。⚠ これだけでは真になってはいけない。 */
  const DECOYS = [
    `${P}/vcl/ui/querydialog.ui","start":1,"end":2}`,
    `${P}/modules/scalc/ui/recalcquerydialog.ui","start":3,"end":4}`,
    `${P}/sfx/ui/safemodequerydialog.ui","start":5,"end":6}`,
  ].join(',');
  /**
   * 🔴 **本物は 2 通りある**(2026-08-28)。上流が `cui` → `svtools` へ移したので、
   * 手元の一式は**どちらの綴りでもありうる**(一式は IDB に取り置かれるため、
   * 配り直しても入れ替わるまでは古いままである)。
   * ⚠ **どちらか片方だけを真にすると、その反対を持っている人が
   *   「保存できるのにできないと言われる」** ── 実際 2026-08-28 にそうなりかけた。
   */
  const REAL = `${P}/svt/ui/querydialog.ui","start":7,"end":8}`;
  const REAL_OLD = `${P}/cui/ui/querydialog.ui","start":7,"end":8}`;

  it('🔴 囮 3 つだけの目録では偽(部分一致で書いていたら必ず落ちる)', () => {
    expect(api.packSavesAlien(`{"files":[${DECOYS}]}`), '囮に満たされている').toBe(false);
  });

  it('🔴 本物が在れば真 ── 囮と一緒に入っていても読み分ける', () => {
    expect(api.packSavesAlien(`{"files":[${DECOYS},${REAL}]}`), '本物を見落としている').toBe(true);
    // ⚠ 並び順に依存しない
    expect(api.packSavesAlien(`{"files":[${REAL},${DECOYS}]}`)).toBe(true);
  });

  /**
   * 🔴 **古い一式を持っている人を切り捨てない**(2026-08-28)。
   * ⚠ 新しい綴りだけを見るように書き換えると、ここが落ちる ── そして
   *   落ちなければ、**入れ替えていない user が保存できなくなる**。
   */
  it('🔴 古い在り処の一式でも真(取り置かれた一式を切り捨てない)', () => {
    expect(
      api.packSavesAlien(`{"files":[${DECOYS},${REAL_OLD}]}`),
      '古い一式を「保存できない」と言っている',
    ).toBe(true);
  });

  it('⚠ 前にも後ろにも延びた名前に満たされない', () => {
    for (const near of [
      `${P}/cui/ui/xquerydialog.ui","start":1,"end":2}`,
      `${P}/cui/ui/querydialog.ui.bak","start":1,"end":2}`,
      `${P}/modules/swriter/ui/cui/ui/querydialog.uix","start":1,"end":2}`,
    ]) {
      expect(api.packSavesAlien(`{"files":[${near}]}`), `${near} に満たされている`).toBe(false);
    }
  });

  it('読めないものは偽(= 断りを出す側へ倒す)', () => {
    expect(api.packSavesAlien('')).toBe(false);
    expect(api.packSavesAlien(null)).toBe(false);
    expect(api.packSavesAlien(undefined)).toBe(false);
    expect(api.packSavesAlien(123)).toBe(false);
    expect(api.packSavesAlien({})).toBe(false);
  });

  it('🔴 印は「閉じ引用符まで」含む(前置きだけの一致で真にしない)', () => {
    // ⚠ 空振り防止 ── 印そのものが短くなっていないことを見る
    for (const [name, mark] of [
      ['新', api.ALIEN_DIALOG_MARK],
      ['旧', api.ALIEN_DIALOG_MARK_OLD],
    ] as const) {
      expect(mark.endsWith('"'), `${name}: 印が閉じ引用符で終わっていない`).toBe(true);
      expect(mark, `${name}: 印が短くなっている`).toContain('/ui/querydialog.ui');
    }
    // 🔑 **綴りそのものを留める** ── 上流の在り処と、切り捨てない古い在り処
    expect(api.ALIEN_DIALOG_MARK).toContain('/soffice.cfg/svt/ui/querydialog.ui');
    expect(api.ALIEN_DIALOG_MARK_OLD).toContain('/soffice.cfg/cui/ui/querydialog.ui');
  });
});

/**
 * 🔴 **2 つの判定は別物である**(CLAUDE.md「誤差の向きを決めて、両側に使い回さない」)。
 *
 * - `isOfficeAttachment` … 「Office で開くボタンを出すか」= **取りこぼしが痛い**ので広く拾う
 * - `isSavable` … 「保存できると言ってよいか」= **嘘が痛い**ので狭く当てる
 *
 * 🔑 だから **`isSavable` ⊂ `isOfficeAttachment`** でなければならない ──
 * 保存できると言っておいて入口が無い、は矛盾である。
 */
describe('入口の判定との関係', () => {
  it('🔴 保存できると言う形式は、必ず入口も出している(両方の一式で)', () => {
    for (const ext of [...api.SAVABLE_EXTS, ...api.ALIEN_SAVABLE_EXTS]) {
      expect(
        isOfficeAttachment('', `a${ext}`),
        `${ext} は保存できると言っているのに Office の入口が無い`,
      ).toBe(true);
    }
  });

  it('🔴 逆は成り立たない(入口のほうが広い)── 広いことを実際に確かめる', () => {
    // ⚠ 空振り防止 ── 「入口は出すが保存はできない」形式が**実在する**こと。
    //    ここが 0 件なら、2 つの判定を分けた意味がそもそも無い。
    //    🔑 **直した一式でも**広いままであること(`.pptx` などは未実測)
    const wider = ['a.fodt', 'a.fods', 'a.fodp'].filter(
      (n) => isOfficeAttachment('', n) && !api.isSavable(n, true),
    );
    expect(wider.length, '入口と保存の広さが同じ ── 分けた意味が無い').toBeGreaterThan(0);
  });
});
