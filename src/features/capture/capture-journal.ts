/**
 * 🔴 **録音・録画の「途中保存」(ジャーナル)の判断**(#1985 項目 2。user 裁定 2026-11-20)。
 *
 * 収録の bytes はメモリ上にだけ在り、タブが落ちる(クラッシュ・電源断)と 250MB の区切り以後が消える。
 * そこで 1 秒ごとの断片(MediaRecorder の chunk)を**収録専用の IndexedDB**へ足していき、
 * 次の起動で「復元する / 破棄する」を出す。
 *
 * ⚠ `features/` 層 = browser API を持たない。IndexedDB は `@adapter/platform/capture-journal-store.ts`。
 * ⚠ 置き場はアプリのデータ(container)に混ぜない(書き出し・バックアップへ同乗させない。`draft-store.ts` と同じ判断)。
 *
 * ## 規則(設計 doc `durability-oplog-design-2026-09.md` の DB 規則に従う)
 * - **新しい専用 DB**(既存 DB の version を上げない)
 * - **書けなかったら静かに諦める。ただし「守られていない」ことは言う**(録るのは止めない)
 * - **断片は Blob のまま渡す**(`ArrayBuffer` へ写さない = ゼロコピー)
 * - **各区間の最初の断片は書き終わるのを待つ**(WebM の見出しを持つ。無いと区間を再生できない)
 * - **区間を添付にできたら、その区間の控えをすぐ消す**
 */

export type JournalKind = 'audio' | 'screen';

/** 1 回の収録の身元。⚠ 控えの中の「どこへ戻すか」を持つ。 */
export interface JournalMeta {
  readonly id: string;
  readonly kind: JournalKind;
  /** どの保存先(container)の収録か。⚠ 別の保存先の同じ lid へ入れない。省略 = 絞らない。 */
  readonly cid?: string;
  /** 録り始めたときに開いていたノート(`null` = 何も開いていなかった)。 */
  readonly startedLid: string | null;
  /** 始めた時刻(ms)。名前の時刻になる(分かれた本は同じ時刻 + 連番)。 */
  readonly startedAt: number;
}

/** 断片 1 つの控え(中身の Blob は持たない)。 */
export interface JournalChunkInfo {
  readonly rec: string;
  readonly seg: number;
  readonly idx: number;
  /** この区間の始まりからの経過(ms)。 */
  readonly elapsedMs: number;
  readonly size: number;
}

/**
 * 🔴 **控えの合計の上限**(これを超えたら録り続けるが、途中保存だけやめて言う)。
 *
 * 根拠: 保存領域の書込を止める床は 64MB(oplog 設計 doc。「控えのせいでノートが保存できなくなる向きを作らない」)。
 * 動画は 1 区間が最大 250MB(`CAPTURE_PART_BYTES`)で、**区間を添付にする間は同じ bytes が添付側にも載る**。
 * 控えは「いま録っている 1 区間 + 取り込みを待っている 1 区間」= **2 区間ぶん**までに収める(512MB)。
 * それより増えるのは、取り込めない状態が続いている回だけで、そこで控えを増やしても守れる物が増えない。
 */
export const CAPTURE_JOURNAL_CAP_BYTES = 512 * 1024 * 1024;

/** 空きがこれを割ったら途中保存を始めない / やめる(oplog 設計 doc の床と同じ 64MB)。 */
export const CAPTURE_JOURNAL_FREE_FLOOR_BYTES = 64 * 1024 * 1024;

/** 途中保存の状態。`active` 以外は「守られていない」。 */
export type JournalState = 'active' | 'off-cap' | 'off-error' | 'off-space';

/** 収録の帯に足す字(`active` なら空)。⚠ 1 か所(帯・知らせで綴りを分けない)。 */
export function journalBarNote(state: JournalState): string {
  return state === 'active' ? '' : '途中保存できていません';
}

/** 止めたときに 1 度だけ出す知らせ(理由つき)。 */
export function journalOffNotice(state: JournalState): string {
  switch (state) {
    case 'off-cap':
      return '途中保存の量が上限に達したので、途中保存をやめました(録音・録画は続けます。ブラウザが落ちると、ここから先は失われます)';
    case 'off-space':
      return '保存領域の空きが少ないので、途中保存をやめました(録音・録画は続けます。ブラウザが落ちると、ここから先は失われます)';
    case 'off-error':
      return '途中保存に失敗しました(録音・録画は続けます。ブラウザが落ちると、ここから先は失われます)';
    default:
      return '';
  }
}

/** 復元できる区間 1 つ。 */
export interface RecoverableSegment {
  readonly rec: string;
  readonly seg: number;
  readonly kind: JournalKind;
  readonly startedLid: string | null;
  readonly startedAt: number;
  /** 使う断片の数(0 番から連続した分)。 */
  readonly chunks: number;
  readonly bytes: number;
  /** 区間の長さ(ms。最後に使う断片の経過)。 */
  readonly elapsedMs: number;
  /** 名前に付ける連番(`null` = 1 本だけ)。 */
  readonly part: number | null;
}

export interface RecoveryPlan {
  readonly segments: readonly RecoverableSegment[];
  /** 復元できない控え(最初の断片が無い区間 / 身元の無い断片)。⚠ 見せずに掃除する対象。 */
  readonly unrestorable: ReadonlyArray<{ readonly rec: string; readonly seg: number }>;
  /** 断片の無い身元(掃除する対象)。 */
  readonly emptyRecs: readonly string[];
}

/**
 * 控えの一覧から、復元の計画を組む(純関数)。
 *
 * - 別のタブが**いま録っている**収録(`isLive`)は出さない(復元を押すと録っている最中の物を奪う)
 * - 区間は **0 番の断片が在る物だけ**復元できる(WebM の見出しが 0 番に在る)
 * - 断片は 0 番から**途切れずに続く分だけ**使う(穴の先は繋げない)
 * - 並びは収録の始まり順 → 区間の番号順
 */
export function planRecovery(
  metas: readonly JournalMeta[],
  infos: readonly JournalChunkInfo[],
  isLive: (rec: string) => boolean,
): RecoveryPlan {
  const metaOf = new Map(metas.map((m) => [m.id, m]));
  const bySeg = new Map<string, JournalChunkInfo[]>();
  for (const c of infos) {
    const k = `${c.rec}\u0000${c.seg}`;
    const arr = bySeg.get(k);
    if (arr === undefined) bySeg.set(k, [c]);
    else arr.push(c);
  }
  const segsOfRec = new Map<string, number>();
  for (const arr of bySeg.values()) {
    const rec = arr[0]!.rec;
    segsOfRec.set(rec, (segsOfRec.get(rec) ?? 0) + 1);
  }
  const segments: RecoverableSegment[] = [];
  const unrestorable: Array<{ rec: string; seg: number }> = [];
  for (const arr of bySeg.values()) {
    const first = arr[0]!;
    if (isLive(first.rec)) continue;
    const meta = metaOf.get(first.rec);
    const sorted = [...arr].sort((a, b) => a.idx - b.idx);
    // 0 番から途切れずに続く分
    let n = 0;
    while (n < sorted.length && sorted[n]!.idx === n) n++;
    if (meta === undefined || n === 0) {
      unrestorable.push({ rec: first.rec, seg: first.seg });
      continue;
    }
    const used = sorted.slice(0, n);
    segments.push({
      rec: meta.id,
      seg: first.seg,
      kind: meta.kind,
      startedLid: meta.startedLid,
      startedAt: meta.startedAt,
      chunks: n,
      bytes: used.reduce((s, c) => s + c.size, 0),
      elapsedMs: used[n - 1]!.elapsedMs,
      part: first.seg > 0 || (segsOfRec.get(first.rec) ?? 0) > 1 ? first.seg + 1 : null,
    });
  }
  segments.sort((a, b) => a.startedAt - b.startedAt || a.rec.localeCompare(b.rec) || a.seg - b.seg);
  const withChunks = new Set(infos.map((c) => c.rec));
  const emptyRecs = metas.filter((m) => !withChunks.has(m.id) && !isLive(m.id)).map((m) => m.id);
  return { segments, unrestorable, emptyRecs };
}

/** 状態の行の字(復元できる物が在るときだけ出す)。 */
export function recoveryLine(count: number): string {
  return count > 0 ? `途中で終わった録音・録画が ${count} 件あります` : '';
}

/** システムのメッセージに残す文(中身の題名・ノート名を入れない)。 */
export function recoveryMessage(count: number): string {
  return `前回、録音・録画が途中で終わりました(${count} 区間)。画面下の「途中で終わった録音・録画」を押すと、復元する・破棄するを選べます`;
}

/** 復元の確認の文。 */
export function recoveryAsk(segments: readonly RecoverableSegment[]): string {
  const recs = new Set(segments.map((s) => s.rec)).size;
  return `途中で終わった録音・録画が ${recs} 件(${segments.length} 区間)残っています。復元すると、録り始めたノートに添付として入れます(そのノートが無いときは、添付だけを作ります)。`;
}
