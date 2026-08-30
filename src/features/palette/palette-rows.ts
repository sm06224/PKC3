/**
 * 🔴 **操作を名前で探す**(#425 段①)── 一覧を組む純関数。
 *
 * ## なぜ要るか
 *
 * 書ける記法も、押せる操作も在るのに、**綴りや置き場所を覚えている人しか使えない**。
 * 書式の帯は 14 個で横に長く、これ以上ボタンを増やせない ── だから
 * 「**名前で呼ぶ**」口を 1 つ作る(PKC2 は 60 個をここから呼べていた)。
 *
 * ## 🔴 一覧を新しく作らない(CLAUDE.md §7)
 *
 * 出るのは `KEY_COMMANDS` **そのもの**である。⚠ パレット用の配列を別に持つと、
 * 鍵の一覧・ヘルプ・パレットで**別の答え**が出る ── PKC2 はヘルプの一覧を
 * 手書きの配列で持っていたため実装と 2 件ズレた(`keymap-panel.ts` 冒頭の記録)。
 *
 * ## 🔴 押せないものも出す。ただし**理由を必ず添える**
 *
 * ⚠ 隠すと「無い」と読まれる(user は探すのをやめる)。⚠ 出したまま黙って
 * 無反応にすると dead click になる。だから**出して、なぜ今は押せないかを書く**。
 * 🔑 理由は `いまは押せません ── ` で始まる ── 押せる行の説明とは**字で見分けられる**
 * (test が「理由が空でない」だけを見ると、理由を取り違える変異が生き延びる)。
 *
 * 🔑 **pure module**。DOM も時計も持たない。「いま押せるか」は呼び側が渡す。
 */
import {
  CONTEXT_LABELS,
  KEY_COMMANDS,
  chordLabel,
  type KeyCommand,
  type KeymapBindings,
} from '@features/keymap';

/** 押せない行の理由に必ず付く頭。⚠ **押せる行には付かない**(見分けの印)。 */
export const NOT_READY_PREFIX = 'いまは押せません ── ';

/** 一覧の 1 行。 */
export interface PaletteRow {
  readonly id: string;
  /** 画面に出る名前(`KEY_COMMANDS` の `label`)。 */
  readonly label: string;
  /** いま割り当たっている鍵(表示用の字。複数可)。⚠ 「次はこれで呼べる」が伝わる。 */
  readonly keys: readonly string[];
  /** いま実行できるか。 */
  readonly ready: boolean;
  /**
   * 1 行の説明。押せないときは **必ず `NOT_READY_PREFIX` で始まる**。
   * 押せるときは `note`(無ければ空)。
   */
  readonly why: string;
}

/**
 * 探し語を突き合わせる形へ均す。
 *
 * ⚠ **大文字小文字だけ**を潰す ── 日本語には大小が無いので、これで
 * 「Mod+E」「mod+e」の両方が当たり、`ノート` はそのまま当たる。
 * ⚠ かなカナや全角半角までは潰さない(#425 段①の範囲外 ── 潰すなら
 * **その正規化を 1 か所に置いてから**でないと、探す欄と食い違う)。
 */
function fold(s: string): string {
  return s.toLowerCase();
}

/**
 * 当たり方。⚠ **小さいほど上**。名前の頭で当たったものを最優先にする ──
 * 「ノ」と打った人が探しているのは「**ノ**ートを作る」であって、
 * 説明文のどこかに「ノート」を含む別の操作ではない。
 */
function rankOf(cmd: KeyCommand, q: string): number | null {
  if (q === '') return 0;
  const label = fold(cmd.label);
  if (label.startsWith(q)) return 0;
  if (label.includes(q)) return 1;
  if (fold(cmd.note ?? '').includes(q)) return 2;
  // ⚠ id も探せる(`open-help` のような綴りを覚えている人のため)
  if (fold(cmd.id).includes(q)) return 3;
  return null;
}

/**
 * なぜ押せないか。
 *
 * 🔑 **理由は 2 種類しかない**:
 *  ① **その面にいない**(`contexts` が `global` を含まない)── 編集中だけの操作など
 *  ② **今その口が画面に無い**(ノートを選んでいない / 帯が出ていない)
 * ⚠ ②の実際の条件は**コマンドが自分で `note` に書いている**
 *   (「ノートを選んでいるときだけ効きます」)── だからそれを引く。
 *   ここで書き直すと、`note` と理由の**2 つの答え**ができる(§7)。
 */
function reasonOf(cmd: KeyCommand): string {
  if (!cmd.contexts.includes('global')) {
    const where = cmd.contexts.map((c) => CONTEXT_LABELS[c]).join(' / ');
    return `${NOT_READY_PREFIX}${where}にいるときだけ効きます`;
  }
  const note = cmd.note ?? '';
  return note === '' ? `${NOT_READY_PREFIX}いまこの操作のボタンが画面に出ていません` : `${NOT_READY_PREFIX}${note}`;
}

/**
 * 一覧を組む。
 *
 * @param query 探し語(空なら全部)
 * @param bindings いまの割当(`resolveBindings` の結果)
 * @param ready **いま実行できる**コマンドの id。⚠ 呼び側(adapter)が画面を見て決める
 * @param mac 鍵の字を mac 風(⌘ / ⌥)にするか
 *
 * 🔑 **押せるものが先**。⚠ 押せないものを混ぜて並べると、
 *   絞り込んだ結果の 1 行目が押せない行になり、**Enter が空振りする**。
 */
export function paletteRows(
  query: string,
  bindings: KeymapBindings,
  ready: ReadonlySet<string>,
  mac = false,
): readonly PaletteRow[] {
  const q = fold(query.trim());
  const hits: { row: PaletteRow; rank: number; order: number }[] = [];
  for (const [order, cmd] of KEY_COMMANDS.entries()) {
    const rank = rankOf(cmd, q);
    if (rank === null) continue;
    const ok = ready.has(cmd.id);
    hits.push({
      rank,
      order,
      row: {
        id: cmd.id,
        label: cmd.label,
        keys: (bindings[cmd.id] ?? cmd.defaults).map((b) => chordLabel(b, mac)),
        ready: ok,
        why: ok ? (cmd.note ?? '') : reasonOf(cmd),
      },
    });
  }
  hits.sort(
    (a, b) =>
      Number(b.row.ready) - Number(a.row.ready) || a.rank - b.rank || a.order - b.order,
  );
  return hits.map((h) => h.row);
}
