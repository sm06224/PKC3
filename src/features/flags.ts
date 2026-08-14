/**
 * 🔴 **フラグの登記所**(P11。user 指示 2026-08-07)。
 *
 * > 「**設定はユーザーに開放されたもの、フラグは開発者とパワーユーザーに開放された
 * > もので予算は 15 個まで、それ以上は設定値で正式リリースさせる**」
 *
 * ## 設定(settings)との違い ── ここが本題
 *
 * | | 設定(settings) | フラグ(flags) |
 * |---|---|---|
 * | 誰のもの | **user** | **開発者・パワーユーザー** |
 * | 約束 | 正式仕様。**消さない** | **いつか畳む**(`foldWhen` に条件を書く) |
 * | 数 | 必要なだけ | 🔴 **15 個まで** |
 * | 置き場 | `settings.ts`(配色 / 外部の画像 …) | ここ |
 *
 * 🔑 **「15 個を超えたら設定へ昇格させる」が予算の意味**である。昇格とは
 * 「flag を消して settings に項目を足す」ことで、**コードの移動でしか表現できない** ──
 * だから `promoteTo` のような field は持たせない。代わりに **`foldWhen` を必須**にして、
 * 「**いつ畳むか書けないものは flag にできない**」を機構で強制する。
 *
 * ## CI が見張っていること(`tests/flag-budget.test.ts`)
 *
 * この file が在るより**先に** test が書かれている(パスを名指しで予約済み):
 *
 * - 宣言の総数が **15 以下**
 * - 各宣言が **`foldWhen: '…'`(非空)** を持つ
 * - **この file 以外が `flags` 表を DML で触っていない**
 * - `CLAUDE.md` の「flags は最大 N 個」と定数が一致
 *
 * ⚠ **綴りを変えない。** `defineFlag('name', { … foldWhen: '…' })` の形は
 * test の正規表現と噛み合っている(`tests/flag-budget.test.ts:61,66`)。
 *
 * ## ⚠ この module は **pure**(browser API を使わない)
 *
 * 層規約(`features` は純関数)に従い、**値の出どころは呼び手が渡す**。
 * 保存(localStorage)と URL の読み取りは `adapter/platform/flag-store.ts` の仕事。
 * ⚠ ここに `localStorage` を書くと層を破るうえ、test / worker から使えなくなる。
 */

/**
 * 🔴 **予算**(user 指示 2026-07-30「flags は最大 15 個」)。
 * ⚠ `tests/flag-budget.test.ts` が **CLAUDE.md の記述と一致するか**を見張っている ──
 *   ここだけ変えても落ちる(散文と定数のどちらが正本か分からなくなるのを防ぐ)。
 */
export const FLAG_BUDGET = 15;

/** flag の宣言。⚠ `foldWhen` は**必須**(畳む条件を書けないものは flag にしない)。 */
export interface FlagSpec {
  /** 既定値。⚠ **既定は必ず「今の挙動」**にする(入れた瞬間に何も変わらない)。 */
  readonly default: boolean;
  /**
   * 🔴 **いつ畳むか**。散文で書く(例: 「ライブエディタが既定 ON になったら」)。
   * ⚠ これが書けないものは flag ではなく設定である。CI が非空を要求する。
   */
  readonly foldWhen: string;
  /** 画面に出す 1 行の説明(パワーユーザーが読む)。 */
  readonly summary: string;
  /**
   * 🔴 **起動前に効いている必要がある**(user 指示 2026-08-07)。
   *
   * ワーカーを作るかどうかのように、**boot の途中で 1 度だけ読まれる**ものは、
   * 切り替えても今の画面には効かない。この印が付いた flag は、フラグ画面が
   * **パラメータ付きで再起動**させる ── user に URL を手で打たせない。
   * ⚠ 「URL でしか変えられない」を残すと、それが**抜け穴**になる。
   */
  readonly needsRestart?: boolean;
}

export interface Flag extends FlagSpec {
  readonly name: string;
}

const REGISTRY = new Map<string, Flag>();

/**
 * flag を宣言する。⚠ **module 読み込み時に 1 度だけ**呼ぶ(下の宣言群)。
 * ⚠ 同じ名前を 2 度宣言したら**その場で落とす** ── 後勝ちで静かに上書きすると、
 *   どちらが効いているか誰にも分からなくなる。
 */
export function defineFlag(name: string, spec: FlagSpec): Flag {
  if (REGISTRY.has(name)) throw new Error(`flag が二重に宣言されている: ${name}`);
  const flag: Flag = { name, ...spec };
  REGISTRY.set(name, flag);
  return flag;
}

/** 宣言されている flag を宣言順に返す(画面が一覧に使う)。 */
export function registeredFlags(): readonly Flag[] {
  return [...REGISTRY.values()];
}

export function findFlag(name: string): Flag | null {
  return REGISTRY.get(name) ?? null;
}

/**
 * 🔴 **いま効いている値を解く**(pure)。
 *
 * 優先順位は **URL > 保存値 > 既定**。
 * ⚠ URL を最優先にするのは、**保存値が壊れていても素の状態へ戻せる**ようにするため
 * (パワーユーザーが自分で抜け出せない状態を作らない)。
 * ⚠ 知らない名前は**黙って捨てる** ── 退役した flag の保存値が残っていても、
 *   一覧にも解決結果にも出さない。
 */
export function resolveFlags(
  stored: Readonly<Record<string, boolean>>,
  fromUrl: Readonly<Record<string, boolean>> = {},
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of REGISTRY.values()) {
    out[f.name] = fromUrl[f.name] ?? stored[f.name] ?? f.default;
  }
  return out;
}

/**
 * 保存すべき値だけを残す(既定と同じものは**書かない**)。
 * ⚠ 既定値まで書くと、**あとで既定を変えたときに古い user だけ取り残される**。
 */
export function prunedForStorage(
  values: Readonly<Record<string, boolean>>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of REGISTRY.values()) {
    const v = values[f.name];
    if (v !== undefined && v !== f.default) out[f.name] = v;
  }
  return out;
}

// ── 宣言 ────────────────────────────────────────────────
//
// ⚠ **予算 15。** 足す前に「これは設定ではないか」を問う ──
//   user が使うものは設定、開発者が試すものが flag である。
// ⚠ **既定は必ず「今の挙動」**にする(入れた瞬間に何も変わらない)。
//
// 🔴 **URL の切替は全部ここに在る**(user 指示 2026-08-07。不可侵)──
//    「クエリパラメータを抜け穴にしてはいけない」。かつて
//    `?pkc-md-inline` / `?pkc-asset-inline` / `?pkc-live` は
//    「計測用だから枠を食わない」として宣言の外に居たが、**それが抜け穴だった**。

/**
 * 本文の描画をワーカーに出さず、その場でやる。
 * ⚠ **起動時に 1 度だけ読まれる**(ワーカーを作るかどうか)ので再起動が要る。
 */
export const FLAG_MD_INLINE = defineFlag('render.markdownInline', {
  default: false,
  foldWhen: 'ワーカー経路が計測の必要なく十分に速いと確認できたら',
  summary: '本文の描画をワーカーに出さず、その場で行う(計測・切り分け用)',
  needsRestart: true,
});

/** 添付の処理を同期経路にする。⚠ 同上、起動時に 1 度だけ読まれる。 */
export const FLAG_ASSET_INLINE = defineFlag('asset.inline', {
  default: false,
  foldWhen: 'ワーカー経路が計測の必要なく十分に速いと確認できたら',
  summary: '添付の処理をワーカーに出さず、その場で行う(計測・切り分け用)',
  needsRestart: true,
});

// 🔴 `editor.live` は 2026-08-14 に**退役**した(user 裁定 2026-08-08
//    「既定でONかつ設定で2ペイン編集はできるようにする」)。foldWhen
//    「既定 ON にできたら」が成就し、設定 `pkc3.editor-mode` へ昇格(既定 live)。
//    保存に残る残骸は `resolveFlags` が捨てる(上の「知らない名前は黙って捨てる」)。
//    ⚠ flag として再宣言しない ── `tests/features/flags.test.ts` が落とす。
