/**
 * 🔴 **ノートのピン留め**(#1377)。左の列の一覧の**最上段に常時固定する専用エリア**に並べるノート。
 *
 * ## 求められていたこと
 *
 * 日常的に参照するデイリーノートやタスク管理ノートを右クリックで「ピン留め」にすると、更新日時や絞り込みや
 * フォルダの移動に関わらず、一覧の最上段に固定され、いつでも 1 押しで開ける。
 * ⚠ **2 ペインの「ブックマーク」とは別物**(#1377 本文「既存のブックマークとは別に」)── ブックマークは
 *   2 ペインだけの帯で、こちらは左の列の全ての面で見える固定エリアである。
 *
 * ## ⚠ 決めごと
 *
 * - 🔑 **綴りは `<コレクションの id>/<lid>`**。端末の保存(コレクションをまたいで 1 つ)に持つので、
 *   コレクションの id を入れないと別のコレクションのピンが混ざる(2 ペインのブックマークと同じ理由)。
 * - 🔴 **置けるなら外せる**(user 指示 2026-08-23)── ピン留めする口(行の右クリック)と外す口
 *   (右クリックの「ピン留めを外す」と、エリアの各行の ×)は必ず対で置く。
 * - ⚠ **保存から落とす操作は無い**(足す / 外すの相手以外)。消えたノート・別のコレクションのノートは
 *   エリアに出さないだけで保存には残る(ゴミ箱から戻せば、また並ぶ)。保存の総数だけは
 *   {@link MAX_NOTE_PINS_STORED} で止める。
 * - ノートの本文(frontmatter)には**書かない** ── 並べ方はノートの内容ではなく、見る人の道具である。
 *   書くと更新日時が動き、履歴が 1 件増え、書き出しに同乗する。
 *
 * ⚠ **pure module**。browser API も dispatch も触らない。
 */

/** エリアに出せる上限(このコレクションの生きている分)。⚠ 手違いの検出 ── 超えたら足すのを断る。 */
export const MAX_NOTE_PINS = 20;

/** 保存に持てる総数(他のコレクション・消えたノートを含む)。 */
export const MAX_NOTE_PINS_STORED = 100;

/** ピンの綴り。 */
export const notePinKey = (cid: string, lid: string): string => `${cid}/${lid}`;

/** 綴りを分ける(区切りは最初の `/` ── コレクションの id に `/` は無い前提)。読めなければ `null`。 */
export function notePinRefOf(key: string): { cid: string; lid: string } | null {
  const at = key.indexOf('/');
  if (at <= 0 || at === key.length - 1) return null;
  return { cid: key.slice(0, at), lid: key.slice(at + 1) };
}

/** 保存の形を読む。⚠ どんな壊れ方でも空へ落ちる(ピンが読めないだけで面が死なない)。 */
export function decodeNotePins(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const x of v) {
      if (typeof x !== 'string' || notePinRefOf(x) === null || out.includes(x)) continue;
      out.push(x);
      if (out.length >= MAX_NOTE_PINS_STORED) break;
    }
    return out;
  } catch {
    return [];
  }
}

export const encodeNotePins = (list: readonly string[]): string => JSON.stringify([...list]);

/**
 * このコレクションで生きているピンの lid(ピン留めした順)。
 * ⚠ 消えたノート・別のコレクションの分は返さない(保存からは落とさない)。
 */
export function livePinLids(
  list: readonly string[],
  cid: string | null,
  exists: (lid: string) => boolean,
): string[] {
  if (cid === null) return [];
  const out: string[] = [];
  for (const key of list) {
    const ref = notePinRefOf(key);
    if (ref === null || ref.cid !== cid || !exists(ref.lid)) continue;
    out.push(ref.lid);
  }
  return out;
}

/**
 * ピン留めする / 外すを 1 本で決める。
 * @returns 変わらないとき(満杯で断った)は同じ中身の配列
 */
export function togglePin(list: readonly string[], key: string, liveCount: number): string[] {
  if (list.includes(key)) return list.filter((x) => x !== key);
  if (liveCount >= MAX_NOTE_PINS || list.length >= MAX_NOTE_PINS_STORED) return [...list];
  return [...list, key];
}

/** 足せない理由(足せるなら `null`)。⚠ 満杯で黙って増えない、を作らない。 */
export function pinRefusal(list: readonly string[], liveCount: number, key: string): string | null {
  if (list.includes(key)) return null;
  if (liveCount >= MAX_NOTE_PINS) return `ピン留めは ${MAX_NOTE_PINS} 件までです。不要なものを外してからピン留めしてください`;
  if (list.length >= MAX_NOTE_PINS_STORED)
    return 'この端末のピン留めの記録がいっぱいです。不要なものを外してからピン留めしてください';
  return null;
}
