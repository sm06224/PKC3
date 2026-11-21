/** @vitest-environment node */
/**
 * 🔴 **質の悪い液晶(ガンマが高く・コントラストが低い)でも、面の境目が見える**(user 指示 2026-11-21)。
 *
 * 画面の物語:`light` / `paper` の地の段差が薄く、ペイン・カード・ボタンの境目が見分けにくかった。
 * 暗い 1px の格子へは戻さず、① 地の明度差を広げる ② ごく薄いヘアライン(`--hairline`)を縁に使う、で直す。
 *
 * 守るもの:
 * 1. 全 12 テーマで、隣り合う層の ΔL*(CIELAB)が**模型の液晶を通した後**で目標以上(模型は `tests/helpers/boundary-model.ts`)
 * 2. 同じ層の組が**素の表示**でも下限以上(模型が無くても段が潰れない)
 * 3. `--hairline` が定義され、中央の紙と標準のボタンに使われ、`gap: 1px` の格子が戻っていない(コメントを剥がして検査)
 *
 * 守っていないもの:実機の液晶の個体差(模型は粗い近似)。見た目は実ブラウザのスクショで確かめた。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEMES } from '../../src/adapter/ui/render/theme';
import { dL, layerPairs, lstar, over, parseColor, poor, themeTokens, toRgb } from '../helpers/boundary-model';

const tokens = readFileSync('src/styles/tokens.css', 'utf8');
const app = readFileSync('src/styles/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** 模型の液晶を通した後の最小 ΔL*。 */
const TARGET_POOR: Record<string, number> = {
  'bg|surface': 3.0, // 机と紙(ペインの境目)。明るいテーマは下で 3.8 に引き上げる
  'surface|surface-2': 2.5, // 紙と見出し帯・追記欄
  'surface|hover': 3,
  'surface|button': 2.4, // 標準のボタンの地(ヘアラインがさらに縁を足す)
  'surface|selected': 4,
};
/** 素の表示での下限(模型なし)。 */
const TARGET_RAW: Record<string, number> = {
  'bg|surface': 2.0,
  'surface|surface-2': 2.5,
  'surface|hover': 5,
  'surface|button': 3.5,
  'surface|selected': 6.5,
};

describe('質の悪い液晶でも境目が見える(ΔL*)', () => {
  it('前提:12 テーマ全部を測っている・模型が差を縮めている(空振り防止)', () => {
    expect(THEMES.length).toBe(12);
    const p = layerPairs(themeTokens(tokens, 'light'))['bg|surface']!;
    // 模型を通すと白に近い 2 色の差は縮む(縮まなければ模型が効いていない)
    expect(dL(poor(p[0]), poor(p[1]))).toBeLessThan(dL(p[0], p[1]));
    expect(dL(p[0], p[1])).toBeGreaterThan(3);
  });

  it.each(THEMES.map((t) => t.id))('%s', (id) => {
    const pairs = layerPairs(themeTokens(tokens, id));
    expect(Object.keys(pairs).sort()).toEqual(Object.keys(TARGET_POOR).sort());
    for (const [name, [a, b]] of Object.entries(pairs)) {
      const raw = dL(a, b);
      const sim = dL(poor(a), poor(b));
      // 明るい地(紙が L*>50)は白に寄って差が潰れやすいので、机と紙の段を厚く取る
      const need = name === 'bg|surface' && lstar(poor(b)) > 70 ? 3.8 : TARGET_POOR[name]!;
      expect(sim, `${id} ${name}: 模型の液晶で ΔL*=${sim.toFixed(2)}(要 ${need})`).toBeGreaterThanOrEqual(need);
      expect(raw, `${id} ${name}: 素で ΔL*=${raw.toFixed(2)}(要 ${TARGET_RAW[name]})`).toBeGreaterThanOrEqual(
        TARGET_RAW[name]!,
      );
    }
  });

  it('色の読み取りが hex / rgb() の両方を解く(ヘルパーの盲点)', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255, 1]);
    expect(parseColor('#e9ebee')).toEqual([233, 235, 238, 1]);
    expect(parseColor('rgb(0 0 0 / 12%)')).toEqual([0, 0, 0, 0.12]);
    expect(over('#000000', 0.5, '#ffffff')).toEqual([127.5, 127.5, 127.5]);
    expect(toRgb('#101010')).toEqual([16, 16, 16]);
  });
});

describe('ヘアライン(縁の細い線)', () => {
  it('--hairline は `--fg` を薄く透かした色(暗い線ではない)', () => {
    const m = /--hairline:\s*color-mix\(in srgb,\s*var\(--fg\)\s*(\d+)%,\s*transparent\)/.exec(tokens);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(8);
    expect(Number(m![1])).toBeLessThanOrEqual(14);
  });

  it('中央の紙と標準のボタンが使う / 他に格子の素地を作らない', () => {
    const center = /\[data-pkc-region='center'\]\s*\{[^}]*\}/.exec(app)![0];
    expect(center).toMatch(/box-shadow:[^;]*0 0 0 1px var\(--hairline\)[^;]*var\(--shadow-sm\)/);
    const button = /\nbutton \{[^}]*\}/.exec(app)![0];
    expect(button).toMatch(/border:\s*1px solid var\(--hairline\)/);
    // 地を透明にして枠を消す型は枠を残さない(主・ゴースト・危険)
    for (const v of ['primary', 'ghost', 'danger']) {
      const rule = new RegExp(`\\nbutton\\[data-pkc-variant='${v}'\\] \\{[^}]*\\}`).exec(app)![0];
      expect(rule, v).toMatch(/border-color:\s*(transparent|var\(--accent\))/);
    }
    // 格子の復活なし
    const shell = /\[data-pkc-region='shell'\]\s*\{[^}]*\}/.exec(app)![0];
    expect(shell).not.toMatch(/gap:\s*1px/);
  });
});
