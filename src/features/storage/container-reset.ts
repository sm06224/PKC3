/**
 * 🔴 **入れ物ごと捨てて、まっさらにする**(#986 段③。user 裁定 2026-09-16)。
 *
 * ## user が求めたこと(こちらの解釈)
 *
 * DB が壊れたとき、**同じブラウザのまま**「拾う → 捨てる → 戻す」を 1 本で通したい。
 * ⚠ 直す前は**別のブラウザ / 別のプロファイル**でしか戻せなかった。
 * 🔑 そして押したときは、**何が起きるかの説明**と**本当に実行するかの確認**を出すこと。
 *
 * ## 🔴 なぜ `DELETE FROM …` ではないのか
 *
 * このボタンが要る当の場面は「**DB が壊れている**」である。壊れた DB へ SQL を打つと
 * `rc 11` で落ちる(`db-rescue.ts` の実測表:`REINDEX` / `DROP+CREATE INDEX` /
 * `VACUUM INTO` が **12 回とも rc 11**)── つまり
 * **`DELETE` は「使いたいときだけ使えない」道具**である。
 * 🔑 だから **file の層**で捨てる(`wipeStorage` → SAHPool の `wipeFiles`)。
 *
 * ## ⚠ 順番に理由がある
 *
 * 1. **添付の bytes を先に消す** ── ここは IDB なので sqlite が壊れていても消せる。
 *    🔑 先にするのは「**途中で落ちても、まだ元の DB が生きている**」からである
 *    (逆順だと、DB を捨てた後に添付の削除が落ちて**戻せない半端**になる)。
 * 2. **DB を捨てる**。
 * 3. **他のタブへ「読み込み直して」と言う** ── ⚠ これが無いと、古いタブが
 *    **消したはずの中身を後から書き戻す**(いちばん気づけない壊れ方)。
 * 4. **自分も読み込み直す**。
 *
 * ## ⚠ ここで消さない物
 *
 * 設定・見た目・読んだお知らせの印・Office / DuckDB の部品は**残す**
 * (user へそう説明してある)。⚠ 一方で **消えたノート由来の断片**
 * (コピー履歴など)は `forgetLocal` で落とす ── 残すと
 * 「消したはずの本文が、貼り付けの一覧にだけ残る」ことになる。
 */

/** 捨てるのに要る口。⚠ **全部必須**(optional にすると、渡し忘れが黙って通る)。 */
export interface ContainerResetPorts {
  /** IDB に在る添付の key(この入れ物の分だけ)。 */
  listAssetKeys(cid: string): Promise<string[]>;
  /** 添付の bytes を 1 件消す。 */
  deleteAsset(cid: string, assetKey: string): Promise<void>;
  /** DB を file ごと捨てる(worker の `wipeStorage`)。 */
  wipeStorage(): Promise<{ wiped: boolean; note: string | null }>;
  /** 消えたノート由来の物を、この端末から落とす(コピー履歴など)。 */
  forgetLocal(): void;
  /** 他のタブへ「読み込み直して」と伝える。 */
  announceWiped(): void;
}

/** 捨てた結果。⚠ **失敗した数を必ず連れて歩く**(「全部消えた」と読ませない)。 */
export interface ContainerResetReport {
  /** 消せた添付の数。 */
  readonly assets: number;
  /**
   * 🔴 **消せなかった添付の数。**
   * ⚠ 0 でないとき「まっさらになりました」と言ってはいけない ──
   *   bytes がどこかに残っている。
   */
  readonly assetFailures: number;
  /** DB を file ごと捨てたか(`false` = もともとメモリ上だった)。 */
  readonly wiped: boolean;
  /** 捨てられなかったときの理由(`wiped: false` のときだけ入る)。 */
  readonly note: string | null;
}

/**
 * 入れ物を空にする。
 *
 * ⚠ **読み込み直しはここではやらない** ── 呼び側(画面)がやる。
 *   ここでやると、**test がこの関数を 1 度も最後まで走らせられない**
 *   (`location.reload()` は happy-dom でも実ブラウザでも戻ってこない)。
 *
 * @param cid いまの入れ物の id
 */
export async function resetContainer(
  cid: string,
  ports: ContainerResetPorts,
): Promise<ContainerResetReport> {
  let assets = 0;
  let assetFailures = 0;

  /**
   * ⚠ **一覧が引けなくても先へ進む** ── 引けないのは IDB ごと壊れている等だが、
   *   そこで止めると「壊れているときだけ捨てられない」になる(この機能の趣旨と逆)。
   * 🔑 引けなかったことは `assetFailures` では表さない ── **数えられないだけ**で、
   *   「N 件消せなかった」とは別の話である。
   */
  const keys = await ports.listAssetKeys(cid).catch((): string[] => []);

  for (const key of keys) {
    try {
      await ports.deleteAsset(cid, key);
      assets += 1;
    } catch {
      // ⚠ 1 件で止めない ── 残りは消せる。数だけ持って先へ進む
      assetFailures += 1;
    }
  }

  const wipe = await ports.wipeStorage();

  // 🔑 **捨てた後に落とす** ── 先に落とすと、捨てるのが失敗したときに
  //    「中身は在るのに履歴だけ消えた」という半端が残る。
  ports.forgetLocal();
  ports.announceWiped();

  return { assets, assetFailures, wiped: wipe.wiped, note: wipe.note };
}

/**
 * 終わった後に画面へ出す字。
 *
 * ⚠ **「まっさらになりました」だけで終えない** ── 消せなかった添付が在るなら
 *   そう言う(#971 段③ の「拾えた件数を全部と読ませない」と同じ向き)。
 */
export function resetDoneMessage(r: ContainerResetReport): string {
  const head =
    r.assetFailures > 0
      ? `中身を消しました。⚠ ただし添付 ${r.assetFailures} 件は消せませんでした`
      : '中身を消しました';
  const tail = r.wiped
    ? ''
    : r.note !== null
      ? `(${r.note})`
      : '';
  return `${head}${tail}。読み込み直してから、バックアップを取り込んでください。`;
}

/**
 * 🔴 **押しても、まだ何も消えない**(user 裁定 2026-09-16)。
 *
 * user の求め(こちらの解釈):**ボタンは推奨のとおり作ってよい。ただし押したら、
 * 何が起きるかの説明と、本当に実行するかの確認を出すこと。**
 *
 * ⚠ だから 2 枚出す:**この字の窓**(押しても消えない)→ **合言葉を打つ窓**。
 * 🔑 合言葉は**この画面に出す**(ノートの題名にしない ── 壊れた DB では
 *   題名が 1 つも出ないので、**いちばん要る場面で合言葉が読めなくなる**)。
 */
export const RESET_PASSPHRASE = 'すてる';

/** 拾い出しの成果のうち、説明の窓が読む分だけ。 */
export interface ResetRescueSeen {
  readonly entries: number;
  readonly skipped: number;
  readonly empty: number;
  readonly bodyMissing: number;
}

/**
 * 説明の窓に出す字を組む。
 *
 * ⚠ **記法を書かない**(`**` / `` ` ``)── 出るのは `textContent` なので
 *   そのまま記号が見える(お知らせと同じ規律)。改行は `pre-wrap` で効く。
 *
 * @param notes いま**一覧に出ている**件数。⚠ 「在る件数」ではない(下の ⚠ を見よ)
 * @param keeps 消えずに残る物の名前。⚠ **呼び側が定数から組む**
 *   ── ここで「約 93MB」と手で書くと、一式の大きさを変えた日に嘘になる
 * @param rescued この画面で拾って書き出した成果(まだなら `null`)
 */
export function resetExplainMessage(opts: {
  readonly notes: number;
  readonly keeps: readonly string[];
  readonly rescued: ResetRescueSeen | null;
}): string {
  const { notes, keeps, rescued } = opts;
  /**
   * 🔴 **「拾ったか」を真偽で言わない**(#971 段③ と同じ向き)。
   * ⚠ 壊れているときは **0 件のファイル**が書き出せてしまうので、
   *   「書き出し済み」とだけ出すと**いちばん危ない人が安心する**。
   */
  const backup =
    rescued === null
      ? '🔴 この画面では、まだ拾い出していません。先に「拾って、戻せる形で書き出す」を押してください。'
      : `この画面で拾えたのは ${rescued.entries} 件です` +
        (rescued.skipped + rescued.empty + rescued.bodyMissing > 0
          ? `(読めなかった区画 ${rescued.skipped} / 空だった区画 ${rescued.empty} / 本文が読めなかったノート ${rescued.bodyMissing} 件)`
          : '') +
        '。この件数で足りるかを、ご自身で確かめてください。';
  return [
    'この入れ物の中身を、すべて消します。元に戻せません。',
    '',
    '消えるもの',
    `・いま一覧に出ている ${notes} 件のノート(題名・本文・履歴・フォルダ・タグ・付箋・板)`,
    '・添付したファイルの中身',
    // 🔑 **0 件と出ていても「空だ」と読ませない** ── 壊れているときは
    //    一覧そのものが引けていないことがある(見えている数 ≠ 在る数)
    '⚠ 壊れているときは、一覧に出ていない分も一緒に消えます。',
    '',
    '残るもの',
    ...keeps.map((k) => `・${k}`),
    '',
    backup,
    // ⚠ 黙って他のタブを読み込み直さない ── 先に言う
    '⚠ 同じ PKC を開いている他のタブも、読み込み直されます。',
  ].join('\n');
}

/** 合言葉を聞く窓の 1 行。⚠ **合言葉そのものをここに出す**(覚えさせない)。 */
export function resetPassphraseLabel(): string {
  return `消してよければ ${RESET_PASSPHRASE} と打ってください`;
}

/** 打たれた字が合言葉か。⚠ 前後の空白は `promptInApp` が落としている。 */
export function resetPassphraseOk(typed: string | null): boolean {
  return typed === RESET_PASSPHRASE;
}
