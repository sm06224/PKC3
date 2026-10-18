/**
 * ペインの大きさを user が決める(#497)。**pure** ── 保存も DOM も触らない。
 *
 * > user 指示 2026-08-27:「**この枠のサイズは可変にし、ユーザーが変更できるように
 * > して欲しい。追記メインで使う場合はわくを大きくしたいとか、閲覧メインで使う時は
 * > 消したいとかあると思う。リサイズニーズは、両サイドペインも一緒だと思う**」
 *
 * ## 🔑 3 か所を 1 つの表で持つ
 *
 * 掴む所も、鍵の効き方も、覚え方も**同じ 1 つの機構**にする(CLAUDE.md §7 ──
 * 3 か所で別々に書くと、必ずどこかだけ挙動が違う)。違うのは**この表の値だけ**:
 *
 * | 面 | 何が変わるか | 掴む帯の位置 | 広げる向き |
 * |---|---|---|---|
 * | `sidebar` | 列の幅 | 面の**右** | →(右へ引くと広い) |
 * | `inspector` | 列の幅 | 面の**左** | ←(左へ引くと広い) |
 * | `append` | 追記欄の高さ | 欄の**上** | ↑(上へ引くと高い) |
 *
 * ## 🔴 下限より小さくしたら「畳む」
 *
 * user の言葉は「**消したい**」である。⚠ 幅 0 の列を残すと、掴む所まで消えて
 * **二度と戻せない**(2026-08-23「片道の操作を作らない」)── だから 0 にはせず、
 * 既存の**畳む機構**(`pane-visibility`)へ渡す。帯は shell の列なので**残る**。
 * 🔑 このとき**大きさは覚えたまま**にする ── 戻したときに元の幅で開く。
 */

/** 大きさを user が決められる面。⚠ 中央(本文)は入れない ── 1 画面完結の本体である。 */
export const SIZED_PANES = ['sidebar', 'inspector', 'append'] as const;

export type SizedPaneId = (typeof SIZED_PANES)[number];

export interface PaneSizeSpec {
  /** `x` = 幅(grid の列)/ `y` = 高さ(追記欄)。 */
  readonly axis: 'x' | 'y';
  /**
   * 掴む帯を**正の向き**へ動かしたとき、面は広がるか(`1`)狭まるか(`-1`)。
   * ⚠ 帯が面の**どちら側に在るか**で決まる ── 右の面は左へ引くと広がる。
   */
  readonly grow: 1 | -1;
  /** これより小さくしたら**畳む**(0 にはしない ── 上の 🔴)。 */
  readonly min: number;
  /** 上限。⚠ 画面が狭いときの上限は CSS 側(`clamp` の `vw`)が別に持つ。 */
  readonly max: number;
  /** 鍵 1 回ぶん(矢印キー)。⚠ 掴めない人が同じことをできる口。 */
  readonly step: number;
}

export const PANE_SIZE_SPECS: Readonly<Record<SizedPaneId, PaneSizeSpec>> = {
  sidebar: { axis: 'x', grow: 1, min: 120, max: 640, step: 16 },
  inspector: { axis: 'x', grow: -1, min: 140, max: 640, step: 16 },
  append: { axis: 'y', grow: -1, min: 40, max: 480, step: 16 },
};

export function isSizedPaneId(v: string): v is SizedPaneId {
  return (SIZED_PANES as readonly string[]).includes(v);
}

/** 覚えている大きさ。⚠ **無い = 既定**(0 ではない)── 触っていない面は CSS の既定で出す。 */
export type PaneSizes = Partial<Record<SizedPaneId, number>>;

/**
 * 上限だけ当てて丸める。⚠ **下限は当てない** ── 下限より小さい値は
 * 「畳む」の合図であって、丸めて潰すと**その合図が消える**(`resizeOutcome` が読む)。
 */
export function roundPaneSize(id: SizedPaneId, px: number): number {
  if (!Number.isFinite(px)) return 0;
  return Math.round(Math.max(0, Math.min(PANE_SIZE_SPECS[id].max, px)));
}

/** 掴む帯を動かした結果。⚠ **1 か所で決める**(掴みも鍵も、ここを通す)。 */
export type ResizeOutcome =
  | { kind: 'size'; px: number }
  /** 下限を割った ── 畳む(大きさは覚えたまま)。 */
  | { kind: 'collapse' };

/**
 * 開始時の大きさと、帯を動かした量から、次の姿を決める。
 *
 * @param startPx 掴んだ時点の大きさ(px)
 * @param deltaPx 帯の移動量(x なら右が正 / y なら下が正)
 */
export function resizeOutcome(
  id: SizedPaneId,
  startPx: number,
  deltaPx: number,
): ResizeOutcome {
  const spec = PANE_SIZE_SPECS[id];
  const raw = startPx + spec.grow * deltaPx;
  if (raw < spec.min) return { kind: 'collapse' };
  return { kind: 'size', px: roundPaneSize(id, raw) };
}

/**
 * 鍵 1 回ぶん動かす。⚠ **掴みと同じ関数を通す** ── 通さないと、鍵でだけ
 * 畳めない / 上限が違う、という食い違いが静かに生まれる(§7)。
 *
 * @param steps 正 = 帯を右/下へ(= 掴んで動かすのと同じ向き)
 */
export function nudgeOutcome(id: SizedPaneId, startPx: number, steps: number): ResizeOutcome {
  return resizeOutcome(id, startPx, steps * PANE_SIZE_SPECS[id].step);
}

/**
 * 保存の形。⚠ **既定のままの面は書かない**(空の値を残すと、既定を変えたときに
 * 古い保存が居座る)。⚠ 並びは `SIZED_PANES` の順に正規化する ── 同じ状態が
 * 2 通りの文字列になると、保存の比較が効かない(`pane-visibility` と同じ作法)。
 */
export function encodePaneSizes(sizes: PaneSizes): string {
  return SIZED_PANES.filter((id) => typeof sizes[id] === 'number')
    .map((id) => `${id}:${roundPaneSize(id, sizes[id] as number)}`)
    .join(' ');
}

/**
 * 🔴 **保存の値として受ける大きさか**(#1087 D7)── 有限で、**その面の下限以上**。
 * ⚠ 下限を割った値は捨てる(`sidebar:5` が 5px の左の列に、`inspector:0.4` が 0px になるのを防ぐ)。
 *   下限を割った操作は「畳む」で、大きさは**書かずに**前の値を覚えたまま(`resizeOutcome`)── 保存に来ない値である。
 * 🔑 下限は `PANE_SIZE_SPECS` の `min`(掴み・鍵と同じ定数)── 2 つ目の表を持たない。
 */
function isStoredPaneSize(id: SizedPaneId, px: number): boolean {
  return Number.isFinite(px) && px >= PANE_SIZE_SPECS[id].min;
}

/**
 * 保存の字がペインの幅として読めるか(設定ファイルの下見用 ── `decodePaneSizes` と同じ読み方)。
 * ⚠ 1 つでも `名前:正の数` に読めない部分が在る字は読めない扱い(`decodePaneSizes` は黙って捨てる)。
 */
export function isPaneSizes(raw: string): boolean {
  const parts = raw.split(/\s+/).filter((t) => t !== '');
  if (parts.length === 0) return false;
  return parts.every((part) => {
    const at = part.indexOf(':');
    if (at < 0 || !isSizedPaneId(part.slice(0, at))) return false;
    return isStoredPaneSize(part.slice(0, at) as SizedPaneId, Number(part.slice(at + 1)));
  });
}

/**
 * ⚠ 知らない名前・数でない値・下限を割る値(0 以下を含む)は**捨てる** ── 面の名前が変わった後の
 * 古い保存で画面が壊れない(`decodeHidden` と同じ向き)。
 */
export function decodePaneSizes(raw: string | null | undefined): PaneSizes {
  const out: PaneSizes = {};
  if (!raw) return out;
  for (const part of raw.split(/\s+/)) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const id = part.slice(0, at);
    if (!isSizedPaneId(id)) continue;
    const px = Number(part.slice(at + 1));
    if (!isStoredPaneSize(id, px)) continue;
    out[id] = roundPaneSize(id, px);
  }
  return out;
}

/**
 * CSS へ渡す値。🔑 **`clamp` で自分を制限させる** ── こうすると画面幅が変わっても
 * JS が測り直さなくてよい(`resize` を聞く口を 1 つ増やさずに済む)。
 * ⚠ 上限の `vw` / `vh` は**画面が狭いときの保険**であって、上の `max` とは別物である
 * (`max` は「user がここまで広げられる」、こちらは「画面からはみ出さない」)。
 */
export function paneSizeCss(id: SizedPaneId, px: number): string {
  const unit = PANE_SIZE_SPECS[id].axis === 'x' ? PANE_WIDTH_CAP : '60vh';
  return `clamp(0px, ${roundPaneSize(id, px)}px, ${unit})`;
}

/**
 * 🔴 **左右の列の幅の上限 ── 中央の本文に最低 480px 残す**(台帳 #1852 束 S1、依頼 350)。
 * 広い画面で両方を最大にした幅を、狭い画面(1100〜1400px)で開いても、本文が潰れない。
 * `(100vw - 500px) / 2` = 左右が同じ幅で分け合ったときに本文が 480px 残る値
 * (500 = 本文 480 + 掴む帯 8×2 + 隙間 1×4)。⚠ **覚えた幅は書き換えない** ── 画面が広がれば元の幅に戻る。
 * ⚠ `max(240px, …)` は、もっと狭い画面で上限が 0 に向かわないための床(その幅は下の 45vw が先に効く)。
 */
export const PANE_WIDTH_CAP = 'min(45vw, max(240px, calc((100vw - 500px) / 2)))';

/** 画面へ書く変数名。⚠ 1 か所で綴る(CSS と JS が別々に綴ると静かに外れる)。 */
export function paneSizeVar(id: SizedPaneId): string {
  return `--pkc-pane-${id}`;
}
