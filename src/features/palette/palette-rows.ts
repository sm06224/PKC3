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
 * 🔑 理由は `いまは押せません。` で始まる ── 押せる行の説明とは**字で見分けられる**
 * (test が「理由が空でない」だけを見ると、理由を取り違える変異が生き延びる)。
 *
 * 🔑 **pure module**。DOM も時計も持たない。「いま押せるか」は呼び側が渡す。
 */
import {
  CONTEXT_WHEN,
  IN_FIELD_CONTEXTS,
  KEY_COMMANDS,
  chordLabel,
  onlyWhenSentence,
  type KeyCommand,
  type KeymapBindings,
} from '@features/keymap';
import { sceneOf } from './scene-labels';

/** 押せない行の理由に必ず付く頭。⚠ **押せる行には付かない**(見分けの印)。 */
export const NOT_READY_PREFIX = 'いまは押せません。';

/** 押せない理由が他に無いときの最後の字。⚠ 出てよいのは「説明を持たない命令」だけ(test が全数で見る)。 */
export const GENERIC_NOT_READY = 'いまこの操作のボタンが画面に出ていません';

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
  /**
   * 🔴 **場面の名前**(行の右端に薄く出す。`scene-labels.ts` の表から引く)。
   * ⚠ 表に無い id は空(何も出さない)── 全 id が持つことは test が見る。
   */
  readonly scene?: string;
}

/**
 * 探し語を突き合わせる形へ均す。
 *
 * 🔴 **大文字小文字・全角半角・ひらがなカタカナを潰す**(#1087 K2)── 日本語入力のまま「のーと」「ﾉｰﾄ」「ＳＱＬ」と
 * 打っても、「ノート」「sql」と同じ操作が当たる。NFKC で全角英数・半角カナを均し、カタカナはひらがなへ寄せる。
 * ⚠ **探される側(label / note / alias / id)と探す語の両方**を同じ関数で均す ── 片方だけだと食い違う。
 */
function fold(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/**
 * 当たり方。⚠ **小さいほど上**。名前の頭で当たったものを最優先にする ──
 * 「ノ」と打った人が探しているのは「**ノ**ートを作る」であって、
 * 説明文のどこかに「ノート」を含む別の操作ではない。
 */
function rankOf(cmd: KeyCommand, q: string): number | null {
  if (q === '') return 0;
  /**
   * 🔴 **空白で区切った語は、全部が当たる行だけ残す**(#1087 の見直し 2026-10-13)── 直す前は打った字全体を 1 つの塊として
   *   探したので、「予定 書き出し」のように離れた 2 語を打つと何も当たらなかった。順位は、いちばん遠い当たり方に合わせる。
   * ⚠ 1 語のときは今までどおり(下の 1 語の判定をそのまま使う)。
   */
  const words = q.split(/\s+/).filter((w) => w !== '');
  if (words.length > 1) {
    let worst = 0;
    for (const w of words) {
      const r = rankOf(cmd, w);
      if (r === null) return null;
      worst = Math.max(worst, r);
    }
    return worst;
  }
  const label = fold(cmd.label);
  if (label.startsWith(q)) return 0;
  if (label.includes(q)) return 1;
  if (fold(cmd.note ?? '').includes(q)) return 2;
  /**
   * 🔑 **画面に出ない呼び名の揺れも探せる**(#690 I5 / #1017 段⑤-2)。
   * ⚠ `alias` は `note` と違って**描画されない**(§6.1 の名前の規則は
   *   画面の字が対象。旧称は画面から消えても、探す欄では今までどおり当たる)。
   */
  if (fold(cmd.alias ?? '').includes(q)) return 2;
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
function reasonOf(
  cmd: KeyCommand,
  blocked: string | null,
  /** 🔴 本文の欄が要る操作への案内の字(#1206 D3)。⚠ 渡されたときだけ使う。 */
  editorHint: string | null = null,
  /**
   * 🔴 **本文の欄などに居るまま開いた「操作を探す」か**(#1087 の見直し 2026-10-14)。
   * ⚠ 居るのに「2 ペインの編集にいるときだけ効きます」と言うと、**いまその場に居る user には嘘**になる。
   *   欄の中の操作は一覧からは実行できず、欄の中でキーを押して使う ── だからその押し方を言う。
   */
  fromField = false,
  /** その操作の、欄の中で押すキーの字(`chordLabel` 済み)。 */
  keys: readonly string[] = [],
): string {
  /*
   * 🔴 **そのボタンが持っている理由を最優先で使う**(#791 ④)。
   *
   * ⚠ 直す前はここが `cmd.note`(**静的な字**)しか見ておらず、
   *   ①出口(保存 / キャンセル)を言わない ②**保存に失敗している保護中でも
   *   「編集中は効きません」と出る**(#516 が直したはずの形)という 2 つを踏んでいた。
   * 🔑 理由は**画面のボタンが持っている**ので、そこから引く ── phase をここで
   *   読み直すと、同じ問いに答える口が 2 つになる(CLAUDE.md §7)。
   */
  if (blocked !== null && blocked !== '') return `${NOT_READY_PREFIX}${blocked}`;
  if (editorHint !== null) return `${NOT_READY_PREFIX}${editorHint}`;
  if (!cmd.contexts.includes('global')) {
    if (fromField && keys.length > 0 && cmd.contexts.every((c) => IN_FIELD_CONTEXTS.has(c))) {
      const where = cmd.contexts.map((c) => CONTEXT_WHEN[c]).join('、または');
      return `${NOT_READY_PREFIX}${where}に、${keys.join(' か ')} を押して使う操作です`;
    }
    return `${NOT_READY_PREFIX}${onlyWhenSentence(cmd.contexts)}`;
  }
  // 🔑 条件で押せなくなる操作は、`note`(何をする操作か)ではなく `whyNot`(なぜ今は押せないか)を言う
  if (cmd.whyNot !== undefined) return `${NOT_READY_PREFIX}${cmd.whyNot}`;
  const note = cmd.note ?? '';
  return note === '' ? `${NOT_READY_PREFIX}${GENERIC_NOT_READY}` : `${NOT_READY_PREFIX}${note}`;
}

/**
 * 一覧を組む。
 *
 * @param query 探し語(空なら全部)
 * @param bindings いまの割当(`resolveBindings` の結果)
 * @param ready **いま実行できる**コマンドの id。⚠ 呼び側(adapter)が画面を見て決める
 * @param mac 鍵の字を mac 風(⌘ / ⌥)にするか
 * @param blockedReason 🔴 **そのボタンがいま持っている「押せない理由」**を引く関数
 *   (#791 ④。user 裁定 2026-09-08)。⚠ 呼び側(adapter)が渡す ── この層は
 *   `AppState` を知らないので、ここで phase を読むと**判定が 2 か所**になる(§7)。
 *   ⚠ 返らないとき(`null`)は今までどおり `note` を使う ── `note` は
 *   「履歴が無い」のような **phase と関係のない理由**を持っている
 *
 * 🔑 **押せるものが先**。⚠ 押せないものを混ぜて並べると、
 *   絞り込んだ結果の 1 行目が押せない行になり、**Enter が空振りする**。
 */
export function paletteRows(
  query: string,
  bindings: KeymapBindings,
  ready: ReadonlySet<string>,
  mac = false,
  blockedReason: (id: string) => string | null = () => null,
  /**
   * 🔴 **「本文の欄が要る操作」か**(#1206 D3)。⚠ 渡すのは**左の `>` の一覧だけ**
   *   (本文の欄が無い所から開いた面)── 押せない理由を「いまの文脈」ではなく
   *   **「どこから呼べるか」**で言う。渡さない(= 本文の欄から開いたパレット)ときは今までの理由。
   */
  needsEditorField?: (id: string) => boolean,
  /** 🔴 本文の欄などに居るまま開いたか(#1087 の見直し 2026-10-14)。欄の中の操作の理由が「その場で押すキー」になる。 */
  fromField = false,
): readonly PaletteRow[] {
  const q = fold(query.trim());
  const editorHintText = (): string => {
    const own = KEY_COMMANDS.find((c) => c.id === 'open-palette');
    const chord = (bindings['open-palette'] ?? own?.defaults ?? [])
      .map((b) => chordLabel(b, mac))
      .join(' / ');
    // ⚠ キーを全部外している人には、空のキーを挟まない(「本文の欄で  の…」と文が欠けた。#1087 の見直し 2026-10-13)
    if (chord === '') return '本文の欄で『操作を探す』を開くと呼べます';
    return `本文の欄で ${chord} の『操作を探す』から呼べます`;
  };
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
        scene: sceneOf(cmd.id) ?? '',
        why: ok ? (cmd.note ?? '') : reasonOf(
              cmd,
              blockedReason(cmd.id),
              needsEditorField?.(cmd.id) === true ? editorHintText() : null,
              fromField,
              (bindings[cmd.id] ?? cmd.defaults).map((b) => chordLabel(b, mac)),
            ),
      },
    });
  }
  hits.sort(
    (a, b) =>
      Number(b.row.ready) - Number(a.row.ready) || a.rank - b.rank || a.order - b.order,
  );
  return hits.map((h) => h.row);
}
