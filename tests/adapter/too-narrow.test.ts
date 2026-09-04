/** @vitest-environment happy-dom */
/**
 * 狭すぎる端末への断り書き(user 裁定 2026-09-04、#671 の裁定 2・3)。
 * 実体は `src/adapter/ui/render/too-narrow.ts`。
 *
 * 🔴 守る主張は 3 つで、**どれも「消え方」の話**である:
 *
 * 1. **OK を押したら消える**(user の言葉:「OK 押したらで」)── そして
 *    **押した後は、また狭くしても出ない**。⚠ 出るなら「押しても消えない」のと
 *    体験が同じで、user は消し方を持たないままである
 * 2. **幅が足りるようになったら畳む** ── 1440px の画面で「この画面の幅では
 *    表示が崩れる」と出したままにしない(🔴 画面に嘘を出さない)
 * 3. **器を畳むかどうかは `main.ts` の `paint` が決める** ── ここは自分の
 *    `hidden` だけ触り、変わったときに知らせる(CLAUDE.md §7)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, decl, stripComments, withoutMedia } from '../helpers/css-blocks';
import { TOO_NARROW_OK, TOO_NARROW_TEXT, installTooNarrow } from '../../src/adapter/ui/render/too-narrow';
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
 * 版面と器を建てて配線する。
 * ⚠ **問い合わせごとに別の替え玉**を返す ── 1 本しか返さないと
 *   「スマホ = 対応外」になり、360〜720px という**いちばん普通の幅**が測れない。
 */
function setup(narrowNow = false) {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const media = new FakeMedia(true);
  const narrow = new FakeMedia(narrowNow);
  appPhone.install(root, (q) => (q.includes(`${PHONE_MIN_PX - 1}px`) ? narrow : media));

  const band = document.createElement('div');
  band.hidden = true;
  const text = document.createElement('span');
  const ok = document.createElement('button');
  band.append(text, ok);
  root.append(band);
  const changes: boolean[] = [];
  const off = installTooNarrow({
    band,
    text,
    ok,
    onChange: () => changes.push(!band.hidden),
  });
  return { band, text, ok, changes, narrow, off };
}

afterEach(() => {
  document.body.textContent = '';
  appPhone.install(document.createElement('div'), () => new FakeMedia(false));
});

describe('出る・消える', () => {
  it('🔴 狭くなったら出る(そして 1 度だけ知らせる)', () => {
    const s = setup();
    expect(s.band.hidden, '対応している幅なのに出ている').toBe(true);
    s.narrow.set(true);
    expect(s.band.hidden, '狭くしても出ない').toBe(false);
    expect(s.text.textContent, '字が入っていない').toBe(TOO_NARROW_TEXT);
    expect(s.changes, '出し入れを知らせていない').toEqual([true]);
  });

  /**
   * 🔴 **畳んだら字も消す。**
   *
   * ⚠ `hidden` は**見た目にしか効かない** ── `textContent` は隠れた子も含むので、
   *   字を置きっぱなしにすると「状態の行に何が出ているか」を見る検査が
   *   **この字に満たされて常に真**になる(CLAUDE.md §1)。
   *   ⚠ 2026-09-04 に実際に踏んだ:対応している幅で「断り書きが出ていない」を
   *   見る smoke が、**隠れたままの字を拾って落ちた**。
   */
  it('🔴 畳んでいる間は、字も押す口も文字を持たない', () => {
    const s = setup();
    expect(s.text.textContent, '畳んでいるのに字が入っている').toBe('');
    expect(s.ok.textContent, '畳んでいるのに押す口の字が入っている').toBe('');
    s.narrow.set(true);
    expect(s.text.textContent, '前提が崩れた(出しても字が入らない)').toBe(TOO_NARROW_TEXT);
    s.narrow.set(false);
    expect(s.text.textContent, '畳んだのに字が残っている').toBe('');
    expect(s.ok.textContent, '畳んだのに押す口の字が残っている').toBe('');
  });

  it('🔴 起動した時点でもう狭ければ、配線した瞬間に出る', () => {
    const s = setup(true);
    expect(s.band.hidden, '細い端末で 1 度も出ない').toBe(false);
  });

  /**
   * 🔴 **user が決めた消し方**(「OK 押したらで」)。
   * ⚠ 直す前は押す口が 1 つも無く、**広げる以外に消す手が無かった**。
   */
  it('🔴 OK を押したら消える', () => {
    const s = setup(true);
    expect(s.band.hidden, '前提が崩れた(出ていない)').toBe(false);
    s.ok.click();
    expect(s.band.hidden, 'OK を押しても消えない').toBe(true);
    expect(s.changes.at(-1), '消したことを知らせていない').toBe(false);
  });

  /**
   * 🔴 **押した後は、また狭くしても出ない。**
   * ⚠ 出るなら「押しても消えない」のと体験が同じである ── user は
   *   窓を掴んでいる間じゅう同じ字を消し続けることになる。
   */
  it('🔴 OK を押した後は、狭め直しても出てこない', () => {
    const s = setup(true);
    s.ok.click();
    s.narrow.set(false);
    s.narrow.set(true);
    expect(s.band.hidden, 'OK を押したのにまた出た').toBe(true);
  });

  /**
   * 🔴 **幅が足りるようになったら畳む**(画面に嘘を出さない)。
   * ⚠ #671 の本文には「幅を広げても**自動では消さない**」と書いていたが、
   *   そのとおりにすると 1440px で「この画面の幅では表示が崩れる」と出たままになる。
   *   🔑 裁定は「**OK でも消せるようにする**」であって「幅で消すのをやめる」ではない、
   *   と読んだ ── 押さずに直した人にまで断り書きを残す理由が無い。
   */
  it('🔴 幅が足りるようになったら畳む', () => {
    const s = setup(true);
    s.narrow.set(false);
    expect(s.band.hidden, '対応している幅で「崩れます」と出したままである').toBe(true);
  });

  /**
   * ⚠ **押していなければ、また狭めると出る**(上の対照群)。
   * 🔑 これが無いと「幅で畳む」を「一度出たら二度と出ない」で代用できてしまう。
   */
  it('🔴 押していなければ、狭め直すとまた出る', () => {
    const s = setup(true);
    s.narrow.set(false);
    s.narrow.set(true);
    expect(s.band.hidden, '押していないのに二度と出ない').toBe(false);
  });

  /** ⚠ 変わっていないのに知らせない(状態の行を無駄に塗り直さない)。 */
  it('⚠ 狭いまま何度知らせが来ても、1 回しか伝えない', () => {
    const s = setup();
    s.narrow.set(true);
    s.narrow.set(true);
    s.narrow.set(true);
    expect(s.changes, '狭いままなのに繰り返し伝えている').toEqual([true]);
  });

  /**
   * 🔴 **版面を張り直すと購読は捨てられる**(#606 → #671 で移した主張。
   * 着地前レビュー B-4 が「移したぶんが置き直されていない」と指摘した当の 1 件)。
   *
   * ⚠ `appPhone.install()` は先頭で `dispose()` を呼び、`narrowSubs` を空にする ──
   *   つまり **`install` を `installTooNarrow` の後で呼ぶと、断り書きは永久に死ぬ**。
   *   いま呼び元は起動の 1 か所だけ(`main.ts` の `appPhone.install` →
   *   `installTooNarrow`)だが、**順番を入れ替える変異を unit でも殺せるように**
   *   ここで pin する。⚠ これが無いと、守る門は smoke の 340px の腕 1 本だけになる。
   */
  it('⚠ 版面を張り直すと購読は捨てられる(配線し直すまで鳴らない)', () => {
    const s = setup();
    const root2 = document.createElement('div');
    root2.setAttribute('data-pkc-slot', 'root');
    document.body.append(root2);
    const media2 = new FakeMedia(true);
    const narrow2 = new FakeMedia(false);
    appPhone.install(root2, (q) => (q.includes(`${PHONE_MIN_PX - 1}px`) ? narrow2 : media2));
    // 🔑 前の見張りを動かしても、捨てられた購読には届かない
    s.narrow.set(true);
    expect(s.band.hidden, '捨てたはずの購読へまだ流している').toBe(true);
    // ⚠ 対照群 ── 張り直した版面の見張りにも、配線し直すまでは繋がっていない
    narrow2.set(true);
    expect(s.band.hidden, '張り直した版面へ勝手に繋がっている').toBe(true);
  });

  /**
   * 🔴 **配線を解いたら鳴らない**(test が次の test へ state を持ち越さない)。
   * ⚠ 押す口の listener も外す ── 外さないと、捨てた器の OK がまだ効く。
   */
  it('⚠ 配線を解いたら、狭くしても出ない', () => {
    const s = setup();
    s.off();
    s.narrow.set(true);
    expect(s.band.hidden, '解いたのに出た').toBe(true);
  });
});

describe('字', () => {
  /**
   * 🔴 **user 裁定の言葉そのまま**。
   *
   * > 「この画面の幅では表示が崩れることがあります。横向きにすると直ります」
   *
   * ⚠ 前の字(「この幅には対応していません ── 360px 以上でお使いください」)は
   *   **スマホに窓が無い**ので「別の端末を使え」としか読めなかった。
   */
  it('🔴 いまできる一手(横向き)を名指しする', () => {
    expect(TOO_NARROW_TEXT, '何が起きるか書いていない').toContain('崩れる');
    expect(TOO_NARROW_TEXT, 'いまできる一手を書いていない').toContain('横向き');
    /**
     * 🔴 **「対応していません」に戻していない**(裁定 2 の眼目)。
     * ⚠ この 1 行が無いと、前の字へ戻す変異が全部の assert を通り抜ける。
     */
    expect(TOO_NARROW_TEXT, '前の字(できることが無い言い方)に戻っている').not.toContain(
      '対応していません',
    );
  });

  /**
   * ⚠ **字の長さも主張である** ── 状態の行はいちばん狭い画面(340px)にも出る。
   * 🔑 実測(340px・11px):33 字は `20 / 20` で収まり、43 字は `25 / 20` ではみ出した。
   *   ⚠ ただし**押す口が並ぶぶん、字だけのときより狭い** ── はみ出しそのものは
   *   実ブラウザで見る(`tests/smoke/phone.smoke.spec.ts` の 340px の腕)。
   */
  /**
   * 🔴 **地の色に埋もれさせない**(着地前レビュー M4、2026-09-04)。
   * ⚠ 親の状態の行は `color: var(--muted)`(薄い灰)である ── 断り書きは
   *   **いちばん狭い画面へ向けた、いちばん読ませたい 1 行**なので地の色で出す。
   *   規則を消すと親の薄い色を継ぐが、unit も smoke も見ていなかった。
   */
  it('🔴 断り書きの字は、状態の行の薄い色に埋もれない', () => {
    // ⚠ **注釈を先に剥ぐ** ── `decl` は `(?:^|;)` で始まりを見るので、
    //    宣言の直前に `*/` が在ると 1 件も当たらない(1 稿目で踏んだ)。
    const css = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));
    const band = blocksFor(css, `[data-pkc-field='too-narrow-text']`).join(' ');
    expect(band, '字の色を決めていない(親の薄い灰を継ぐ)').toMatch(decl('color', 'var\\(--fg'));
    // ⚠ 空振り防止 ── 親は薄い色のままである(親を変えて満たしていない)
    const status = blocksFor(css, `[data-pkc-region='status']`).join(' ');
    expect(status, '親の色が薄くない(この検査は何も守っていない)').toMatch(
      decl('color', 'var\\(--muted'),
    );
  });

  it('⚠ 短く保つ(340px の帯に押す口ごと収める)', () => {
    expect(TOO_NARROW_TEXT.length, '長すぎて 340px の帯からはみ出す').toBeLessThanOrEqual(33);
    expect(TOO_NARROW_OK, '押す口の字が長い(帯を押し広げる)').toHaveLength(2);
  });
});
