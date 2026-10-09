/**
 * 🔴 **章の箱 / コード枠の箱の高さの上限は、viewport ではなく「読む面の器の高さ」とも
 * `min()` を取る**(2026-10-03。実ブラウザの smoke `context-menu.smoke.spec.ts` の
 * 「45 行の章は見出しもボタンも画面に収まり…」が、お知らせを 1 件足した PR で落ちて拾った)。
 *
 * ⚠ 直す前の `calc(var(--pkc-col-h, 100vh) - 300px)` は「読む面の高さは常に viewport − 206px」
 *   という前提で、shell の下の行(起動直後のお知らせのカード / 注意 / 収録中の帯 / タイマー)が
 *   出ている間は成り立たない ── 1280×800 で 5 項目のお知らせが 30vh(237px)まで伸びると
 *   器は 560px、箱 530px は見える 526px に収まらず、見出しの行が貼り付いた帯の下へ隠れた(実測)。
 * 🔑 器の高さは `read-columns.ts` の `exposePaneHeight` が `--pkc-pane-h` として px で下ろす。
 *   ここは **CSS が読んでいること**と**JS が書いていること**の両端を pin する(片方だけでは
 *   「書いているのに誰も読まない / 読んでいるのに誰も書かない」が静かに通る)。
 * ⚠ 「隠れない」こと自体は実ブラウザの smoke が結果で守る ── ここは規則の在処だけ。
 */
/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, stripComments, withoutMedia } from '../helpers/css-blocks';
import {
  PANE_H_VAR,
  exposePaneHeight,
  fitColumnHeight,
  installColumnFit,
  limitDraftInput,
} from '../../src/adapter/ui/render/read-columns';
import { SECTION_BOX_INPUT_FIELD, installSectionBox } from '../../src/adapter/ui/render/section-box';
import { CODE_BOX_INPUT_FIELD, installCodeBox } from '../../src/adapter/ui/render/code-box';

const css = (): string => withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));

describe('章の箱の高さは器の高さにも頭打ちされる(2026-10-03)', () => {
  it.each(["[data-pkc-field='section-draft-input']", "[data-pkc-field='code-draft-input']"])(
    '🔴 %s の max-height は 100vh − 300px と 器 − 110px の min()',
    (sel) => {
      const b = blocksFor(css(), sel);
      expect(b.length, `${sel} の規則が無い(空振り)`).toBeGreaterThan(0);
      const text = b.join('\n');
      const m = /max-height:\s*([^;]+);/.exec(text);
      expect(m, 'max-height が無い').not.toBeNull();
      const v = m![1]!.replace(/\s+/g, ' ');
      expect(v, '100vh − 300px の既定が消えている(下の行が無い日の見た目が変わる)').toContain(
        'calc(var(--pkc-col-h, 100vh) - 300px)',
      );
      expect(v, '器の高さ(--pkc-pane-h)を読んでいない ── お知らせのカードが出ている間、見出しが帯の下へ隠れる').toContain(
        `calc(var(${PANE_H_VAR}, 100vh) - 110px)`,
      );
      expect(v.startsWith('min('), '2 つは min() で結ぶ(小さいほうが効く)').toBe(true);
    },
  );

  it('🔴 予備の値の無い var(--pkc-pane-h) を書かない(宣言ごと捨てられる)', () => {
    const text = css();
    const all = [...text.matchAll(/var\(--pkc-pane-h([^)]*)\)/g)];
    expect(all.length, '--pkc-pane-h を読む所が 1 つも無い(空振り)').toBeGreaterThan(0);
    for (const m of all) expect(m[1], `予備の値の無い var(--pkc-pane-h) が在る: ${m[0]}`).toMatch(/^\s*,/);
  });
});

function shell(): { root: HTMLElement; region: HTMLElement; pane: HTMLElement; input: HTMLElement } {
  const root = document.createElement('div');
  const region = document.createElement('div');
  region.setAttribute('data-pkc-region', 'detail');
  const pane = document.createElement('div');
  pane.setAttribute('data-pkc-view-pane', 'detail');
  pane.setAttribute('data-pkc-detail-mode', 'view');
  // 開いている章の編集箱(`--pkc-pane-h` の唯一の読み手)
  const input = document.createElement('textarea');
  input.setAttribute('data-pkc-field', SECTION_BOX_INPUT_FIELD);
  pane.append(input);
  region.append(pane);
  root.append(region);
  document.body.append(root);
  limitDraftInput(input); // 箱は台帳に載って初めて書かれる(本物の差し込みと同じ道)
  return { root, region, pane, input };
}

describe('器の高さを CSS へ下ろす(exposePaneHeight)', () => {
  /**
   * 🔴 **測るのは器(面の親)、書くのは編集箱そのもの**(#1467 段 3-c)。
   * ⚠ 直す前は器の `style` に書いていた ── 自前の変数は継承されるので、器の値が動くたびに本文の
   *   子孫 4.7 万要素が丸ごとスタイル再計算になり、直後の採寸がそれを払っていた(20,000 行の追記で 2.0 秒)。
   */
  it('🔴 器の clientHeight を px で、器にも面にも書かず、編集箱に書く', () => {
    const { root, region, pane, input } = shell();
    Object.defineProperty(region, 'clientHeight', { value: 560, configurable: true });
    expect(exposePaneHeight(root)).toBe(560);
    expect(input.style.getPropertyValue(PANE_H_VAR), '編集箱に下りていない').toBe('560px');
    // 🔴 器に書くと、継承で本文の全子孫が再計算になる(#1467 段 3-c)
    expect(region.style.getPropertyValue(PANE_H_VAR), '器に書いている(本文全体の再計算を起こす)').toBe('');
    // ⚠ 面にも書かない ── 読む面は中身の高さまで伸びるので、面の高さは器の高さではない(同じく継承で全子孫)
    expect(pane.style.getPropertyValue(PANE_H_VAR)).toBe('');
    root.remove();
  });

  it('🔴 開いたばかりの編集箱には limitDraftInput が同じ値を下ろす(見張りが鳴る前に効く)', () => {
    const { root, region, input } = shell();
    Object.defineProperty(region, 'clientHeight', { value: 480, configurable: true });
    expect(limitDraftInput(input)).toBe(480);
    expect(input.style.getPropertyValue(PANE_H_VAR)).toBe('480px');
    expect(region.style.getPropertyValue(PANE_H_VAR), '器に書いている').toBe('');
    // 器の外の要素には何も書かない(器が見つからない)
    const stray = document.createElement('textarea');
    document.body.append(stray);
    expect(limitDraftInput(stray)).toBeNull();
    expect(stray.style.getPropertyValue(PANE_H_VAR)).toBe('');
    stray.remove();
    root.remove();
  });

  /**
   * 🔴 **開いた瞬間に上限が効く**(見張りの ResizeObserver は次のフレームまで鳴らない)──
   *   章の箱 / コード枠の箱の**本物の差し込み**で、箱に `--pkc-pane-h` が載っている。
   */
  it('🔴 章の箱 / コード枠の箱を差し込んだ瞬間、箱そのものに --pkc-pane-h が載る(器には載らない)', () => {
    const { root, region, pane } = shell();
    pane.querySelector('[data-pkc-field="section-draft-input"]')!.remove(); // shell の箱は使わない
    Object.defineProperty(region, 'clientHeight', { value: 500, configurable: true });
    const host = document.createElement('div');
    for (const n of [0, 2, 4]) {
      const b = document.createElement('div');
      b.className = 'pkc-md-block';
      b.setAttribute('data-pkc-source-line', String(n));
      if (n === 4) b.setAttribute('data-pkc-md-block-kind', 'code');
      b.textContent = `line ${n}`;
      host.append(b);
    }
    pane.append(host);
    const section = installSectionBox(host, { from: 0, to: 3, text: '## 見出し\n本文' });
    expect(section, '前提が崩れている(章の箱が差し込まれていない)').not.toBeNull();
    expect(section!.style.getPropertyValue(PANE_H_VAR), '章の箱に器の高さが下りていない').toBe('500px');
    const code = installCodeBox(host, { line: 4, text: 'const a = 1;' });
    expect(code, '前提が崩れている(コード枠の箱が差し込まれていない)').not.toBeNull();
    expect(code!.style.getPropertyValue(PANE_H_VAR), 'コード枠の箱に器の高さが下りていない').toBe('500px');
    expect(region.style.getPropertyValue(PANE_H_VAR), '器に書いている').toBe('');
    // 🔑 器が後から縮む(お知らせのカード)── 見張りが呼ぶ exposePaneHeight が**両方の本物の箱**へ追随させる
    //    (着地前レビュー B: 台帳からコード枠の箱が抜ける変異 / 1 つしか書かない変異を殺す)
    Object.defineProperty(region, 'clientHeight', { value: 300, configurable: true });
    expect(exposePaneHeight(root)).toBe(300);
    expect(section!.style.getPropertyValue(PANE_H_VAR), '章の箱が器の縮みに追随していない').toBe('300px');
    expect(code!.style.getPropertyValue(PANE_H_VAR), 'コード枠の箱が器の縮みに追随していない').toBe('300px');
    // 閉じた箱には書かない(台帳から落ちる)
    section!.closest('[data-pkc-region]')!.remove();
    Object.defineProperty(region, 'clientHeight', { value: 320, configurable: true });
    expect(exposePaneHeight(root)).toBe(320);
    expect(section!.style.getPropertyValue(PANE_H_VAR), '閉じた箱に書き続けている').toBe('300px');
    expect(code!.style.getPropertyValue(PANE_H_VAR)).toBe('320px');
    root.remove();
  });

  /**
   * 🔴 **CSS で `--pkc-pane-h` を読む箱 = `limitDraftInput` を呼ぶ箱**(着地前レビュー A、parity)。
   * ⚠ 器に書いていた頃は 3 つ目の読み手を CSS に足せば自動で効いたが、箱に書く作りでは差し込み側が
   *   `limitDraftInput` を呼ばない限り効かない(黙って `100vh - 110px` に戻る)。CSS の読み手の集合を
   *   全数で拾い、箱の field 名の集合と等値で比べる。
   */
  it('🔴 CSS で --pkc-pane-h を読む箱の集合 = limitDraftInput を呼ぶ箱の集合(parity)', () => {
    const text = css();
    const readers = new Set<string>();
    // 規則(`選択子 { 宣言 }`)を全部読み、宣言に `var(--pkc-pane-h` を持つ物の選択子を箱の field 名へ落とす
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!m[2]!.includes('var(--pkc-pane-h')) continue;
      for (const sel of m[1]!.split(',')) {
        const f = /\[data-pkc-field=['"]([a-z-]+)['"]\]/.exec(sel.trim());
        expect(f, `読み手の選択子が箱の field 名で書かれていない: ${sel.trim()}`).not.toBeNull();
        readers.add(f![1]!);
      }
    }
    expect(readers.size, '読み手が 1 つも拾えていない(空振り)').toBeGreaterThan(0);
    // 書き手: limitDraftInput を呼ぶ差し込み側の field 名(section-box.ts / code-box.ts が export する正本)
    const writers = new Set([SECTION_BOX_INPUT_FIELD, CODE_BOX_INPUT_FIELD]);
    for (const f of [SECTION_BOX_INPUT_FIELD, CODE_BOX_INPUT_FIELD]) {
      const src = readFileSync(`src/adapter/ui/render/${f === SECTION_BOX_INPUT_FIELD ? 'section-box' : 'code-box'}.ts`, 'utf-8');
      expect(src, `${f} の差し込み側が limitDraftInput を呼んでいない`).toContain('limitDraftInput(ta)');
    }
    expect([...readers].sort(), 'CSS の読み手と、箱に書く側が食い違っている').toEqual([...writers].sort());
  });

  it('採寸できない(0)なら触らない ── 0px にすると箱が消える', () => {
    const { root, region, input } = shell();
    input.style.setProperty(PANE_H_VAR, '560px');
    Object.defineProperty(region, 'clientHeight', { value: 0, configurable: true });
    expect(exposePaneHeight(root)).toBeNull();
    expect(input.style.getPropertyValue(PANE_H_VAR), '0 の回に前の値を消した / 0px を書いた').toBe('560px');
    expect(limitDraftInput(input)).toBeNull();
    expect(input.style.getPropertyValue(PANE_H_VAR)).toBe('560px');
    root.remove();
  });

  it('🔴 fitColumnHeight が段組みの有無に関わらず下ろす(1 段でも / off の経路でも)', () => {
    const { root, region, input } = shell();
    Object.defineProperty(region, 'clientHeight', { value: 420, configurable: true });
    // happy-dom は getBoundingClientRect が 0 なので fitColumnHeight 自体は null(= 段組みの採寸はしない)
    expect(fitColumnHeight(root, document)).toBeNull();
    expect(input.style.getPropertyValue(PANE_H_VAR), '段組みを採れない回に器の高さを下ろしていない').toBe('420px');
    expect(region.style.getPropertyValue(PANE_H_VAR), '器に書いている').toBe('');
    root.remove();
  });

  /**
   * 🔴 **見張りは面だけでなく器(面の親)も観る**(着地後レビュー ⚠5。直す前は原文の字面を pin していた)。
   * ⚠ 長いノートでは面が器より高く、**お知らせのカードが出て器が縮んでも面は 1px も動かない** ──
   *   面だけ観ていると `--pkc-pane-h` が古いまま残り、箱が見える範囲からはみ出す。
   * 🔑 見るのは**結果**:fake の `ResizeObserver` で①器が観られていること ②**器の高さだけ**が変わって
   *   callback が撃たれたとき `--pkc-pane-h` が更新されること(面は動かさない)。
   */
  it('🔴 見張りは面だけでなく器(面の親)も観る ── 器の高さだけが変わっても --pkc-pane-h が追随する', () => {
    const observed: Element[] = [];
    const fires: Array<() => void> = [];
    class FakeRO {
      constructor(cb: () => void) {
        fires.push(cb);
      }
      observe(el: Element): void {
        observed.push(el);
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', FakeRO);
    const { root, region, pane, input } = shell();
    let dispose: (() => void) | null = null;
    try {
      Object.defineProperty(region, 'clientHeight', { value: 560, configurable: true });
      dispose = installColumnFit(root, document);
      expect(observed, '器(面の親)を観ていない').toContain(region);
      // 対照群:面も観ている(器だけ観る形に置き換えても、面の追随は残る)
      expect(observed, '面を観ていない').toContain(pane);
      expect(input.style.getPropertyValue(PANE_H_VAR), '前提:起動直後に器の高さを下ろしている').toBe('560px');
      // 器だけが縮む(面は動かさない)── お知らせのカードが出た日
      Object.defineProperty(region, 'clientHeight', { value: 300, configurable: true });
      expect(fires.length, '前提:ResizeObserver を作っていない').toBeGreaterThan(0);
      for (const f of fires) f();
      expect(input.style.getPropertyValue(PANE_H_VAR), '器が縮んだのに --pkc-pane-h が古いまま').toBe('300px');
      expect(region.style.getPropertyValue(PANE_H_VAR), '器に書いている').toBe('');
    } finally {
      dispose?.();
      vi.unstubAllGlobals();
      root.remove();
    }
  });
});
