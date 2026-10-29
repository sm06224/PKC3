/**
 * 🔴 **ノートのピン留め**(#1377)。左のペインの一覧の**最上段に常時固定する専用エリア**に並べるノート。
 *
 * ## 求められていたこと
 *
 * 日常的に参照するデイリーノートやタスク管理ノートを右クリックで「ピン留め」にすると、更新日時や絞り込みや
 * フォルダの移動に関わらず、一覧の最上段に固定され、いつでも 1 押しで開ける。
 * ⚠ **2 ペインの「ブックマーク」とは別物**(#1377 本文「既存のブックマークとは別に」)── ブックマークは
 *   2 ペインだけの帯で、こちらは左のペインの全ての面で見える固定エリアである。
 *
 * ## ⚠ 決めごと
 *
 * - 🔑 **置き場はコレクション(器)**。`settings` 表の `scope = 'note-pin:<cid>'`(1 ノート 1 行)に持ち、
 *   バックアップ(`container.json` の `notePins`)と別の端末へ運ぶ。端末の記憶(localStorage)ではない。
 *   ノートの本文・更新日時・履歴には一切触れない(frontmatter に書かない ── 書くと履歴が 1 件増え、書き出しに同乗する)。
 * - 🔑 **綴りは lid だけ**(器ごとに持つので、コレクションの id を綴りに入れない)。
 *   旧い版が端末に残した `<コレクションの id>/<lid>` の並び({@link legacyPinLids})は、開いたときに一度だけ取り込んで移す。
 * - 🔴 **置けるなら外せる**(user 指示 2026-08-23)── ピン留めする口(行の右クリック・操作を探す)と外す口
 *   (右クリックの「ピン留めを外す」・操作を探す・エリアの各行の「外す」)は必ず対で置く。
 * - 🔴 **消えたノートのピンは、付け外しのたびに掃除する**({@link deadPinLids})。満杯の判定は**生きているピンだけ**で数える。
 *   (ゴミ箱へ移したノートは一覧に無いので、ピンは外れる。戻したら留め直す。)
 *
 * ⚠ **pure module**。browser API も dispatch も触らない。
 */

/** エリアに出せる上限(生きている分)。⚠ 手違いの検出 ── 超えたら足すのを断る。 */
export const MAX_NOTE_PINS = 20;

/** 保存に持てる総数(掃除前の消えたノートを含む)。 */
export const MAX_NOTE_PINS_STORED = 100;

/** 保存の形(lid の並び)を読む。⚠ どんな壊れ方でも空へ落ちる。 */
export function normalizePinLids(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || x === '' || out.includes(x)) continue;
    out.push(x);
    if (out.length >= MAX_NOTE_PINS_STORED) break;
  }
  return out;
}

/** いま生きているピン(ノートが在るもの)を、留めた順に。 */
export function livePinLids(list: readonly string[], exists: (lid: string) => boolean): string[] {
  return list.filter((lid) => exists(lid));
}

/** 掃除する(ノートが無くなった)ピン。 */
export function deadPinLids(list: readonly string[], exists: (lid: string) => boolean): string[] {
  return list.filter((lid) => !exists(lid));
}

/**
 * 留める / 外すを 1 本で決める(掃除つき)。
 * @returns 新しい並びと、保存側へ頼む掃除の lid。満杯で断ったとき(生きている数で判定)は並びは変わらない。
 */
export function togglePin(
  list: readonly string[],
  lid: string,
  exists: (lid: string) => boolean,
): { list: string[]; prune: string[]; refused: boolean } {
  const prune = deadPinLids(list, exists);
  const kept = list.filter((x) => !prune.includes(x));
  if (kept.includes(lid)) return { list: kept.filter((x) => x !== lid), prune, refused: false };
  if (kept.length >= MAX_NOTE_PINS) return { list: kept, prune, refused: true };
  return { list: [...kept, lid], prune, refused: false };
}

/** 足せない理由(足せるなら `null`)。⚠ 数えるのは生きているピンだけ。 */
export function pinRefusal(
  list: readonly string[],
  lid: string,
  exists: (lid: string) => boolean,
): string | null {
  if (list.includes(lid)) return null;
  if (livePinLids(list, exists).length >= MAX_NOTE_PINS)
    return `ピン留めは ${MAX_NOTE_PINS} 件までです。不要なものを外してからピン留めしてください`;
  return null;
}

/**
 * 旧い版が端末(localStorage `pkc3.note-pins`)に残した `["<cid>/<lid>", …]` から、この器の lid を取り出す。
 * ⚠ 読めない物・他の器の物は返さない(他の器の分は、その器を開いたときに取り込む)。
 */
export function legacyPinLids(raw: string | null, cid: string): string[] {
  if (raw === null || raw === '') return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const x of v) {
      if (typeof x !== 'string') continue;
      const at = x.indexOf('/');
      if (at <= 0 || at === x.length - 1 || x.slice(0, at) !== cid) continue;
      const lid = x.slice(at + 1);
      if (!out.includes(lid)) out.push(lid);
    }
    return out;
  } catch {
    return [];
  }
}

/** 旧い保存から、この器の分を除いた残り(他の器の分は残す)。空になったら `null`(鍵ごと消す)。 */
export function legacyPinsWithout(raw: string | null, cid: string): string | null {
  if (raw === null || raw === '') return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    const rest = v.filter((x): x is string => typeof x === 'string' && !x.startsWith(`${cid}/`));
    return rest.length === 0 ? null : JSON.stringify(rest);
  } catch {
    return null;
  }
}
