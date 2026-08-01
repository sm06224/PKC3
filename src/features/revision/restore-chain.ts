/**
 * 復元チェーンの **TS 参照実装(oracle)**。
 *
 * rust-wasm-strategy §7.1 の順序規律: **TS が正、wasm が従**。
 * - wasm が使えない環境(未 init / 毒 / 未対応)ではこれがそのまま本番経路になる
 * - wasm 版との等価性は parity test が恒久的に守る。食い違ったら **TS を信じる**
 *
 * 「1 つ新しい状態から遡るパッチ」を順に適用するだけ ── 段の意味論は
 * p5c-revision-delta-design を参照。
 */
import { applyLinePatch, type LinePatch } from './line-patch';

/** 復元チェーンの 1 段(新しい側から古い側へ向かう順)。 */
export type ChainStep =
  | { kind: 'full'; body: string }
  | { kind: 'patch'; ops: LinePatch['ops'] };

/**
 * tip(最新状態)から steps を順に遡り、目標の状態を返す。
 * 壊れたパッチは throw(それらしい本文を作らない ── S3 規律)。
 */
export function restoreChain(tipBody: string, steps: readonly ChainStep[]): string {
  let state = tipBody;
  for (const step of steps) {
    state =
      step.kind === 'full'
        ? step.body
        : applyLinePatch(state, { v: 1, ops: step.ops as LinePatch['ops'] });
  }
  return state;
}
