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
 * ⚠ 知らない名前・数でない値・0 以下は**捨てる** ── 面の名前が変わった後の
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
    if (!Number.isFinite(px) || px <= 0) continue;
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
  const unit = PANE_SIZE_SPECS[id].axis === 'x' ? '45vw' : '60vh';
  return `clamp(0px, ${roundPaneSize(id, px)}px, ${unit})`;
}

/** 画面へ書く変数名。⚠ 1 か所で綴る(CSS と JS が別々に綴ると静かに外れる)。 */
export function paneSizeVar(id: SizedPaneId): string {
  return `--pkc-pane-${id}`;
}
