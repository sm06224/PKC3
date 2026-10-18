/**
 * 🔴 **取り込んだ後にパソコン側で変わったファイルを、もう一度押したとき ── 確かめたうえで「取り込み直す」**
 * (台帳 #1852 N1 / 依頼 97-2 A。Gemini 回答 = 推薦どおり)。
 *
 * ## 何が起きていたか
 *
 * パソコンのフォルダから取り込んだ Markdown を外のエディタで直して、同じ行をもう一度押すと「取り込んだ後にパソコン側で変わっています」と
 * 出るだけだった。外で直した内容を PKC3 に取り込む道が無く、「元ファイルへ書き戻す」を押すと外の変更を消す側にしか進めなかった。
 *
 * ## 決めごと
 *
 * - 🔑 押したら**聞く**(ノートの中身を置き換えるので)。「取り込み直す」を選んだときだけ、ファイルの今の中身をノートの本文にする。
 * - 🔑 **前の中身は履歴に残る**(書き込みは履歴を 1 件積む書き方 ── 画面の下の「元に戻す」で戻せる)。
 * - ⚠ 読めなかったときは、ノートに触らず**理由を言う**。⚠ 置き換え先のノートが消えていたら、何もしない(effect が理由を出す)。
 * - 判断はここに置く。`main.ts` はどの unit からも実行されないので、そちらには口を渡すだけにする(CLAUDE.md §2)。
 */
export interface ReimportItem {
  readonly lid: string;
  /** 押したファイルの名前(確認の字に出す)。 */
  readonly name: string;
}

export interface ReimportDeps {
  /** 確認の器(アプリ自身の `<dialog>`)。`true` = 取り込み直す。 */
  readonly confirm: (
    message: string,
    opts: { okLabel: string; cancelLabel: string; danger: boolean },
  ) => Promise<boolean>;
  /** ファイルの今の中身を読む(取り込みと同じ読み方)。読めなければ例外。 */
  readonly readText: (lid: string) => Promise<string>;
  /** ノートの題名(確認の字に出す)。`null` = ノートがもう無い。 */
  readonly titleOf: (lid: string) => string | null;
  /** 本文を置き換える要求を撃つ(`REIMPORT_BODY`)。 */
  readonly replace: (lid: string, body: string) => void;
  /** 取り込み時の更新時刻を、いまの値に憶え直す(次の押し直しで「変わっています」と言わない)。 */
  readonly refreshModified: (lid: string) => Promise<void>;
  /** 画面の下の 1 行。 */
  readonly say: (text: string) => void;
}

/** 「取り込み直す」の確認の字。⚠ 画面に出る字なので 1 か所に置く。 */
export function reimportQuestion(title: string, name: string): string {
  return (
    `「${title}」は、取り込んだ後にパソコン側のファイル「${name}」が変わっています。` +
    'ファイルの今の中身をノートに取り込み直しますか。今のノートの中身は履歴に残ります(画面の下の「元に戻す」で戻せます)。'
  );
}

export const REIMPORT_OK_LABEL = '取り込み直す';
export const REIMPORT_CANCEL_LABEL = 'このままにする';
export const REIMPORT_UNREADABLE = 'ファイルの今の中身を読めなかったので、ノートはそのままです';

/**
 * 変わっていたファイルの先頭の 1 件について、取り込み直すかを聞いて、答えが「はい」なら置き換える。
 * @returns 置き換えを頼んだか(聞いて断られた・読めなかった・ノートが無いときは `false`)
 */
export async function offerReimport(deps: ReimportDeps, item: ReimportItem): Promise<boolean> {
  const title = deps.titleOf(item.lid);
  if (title === null) return false;
  const yes = await deps.confirm(reimportQuestion(title, item.name), {
    okLabel: REIMPORT_OK_LABEL,
    cancelLabel: REIMPORT_CANCEL_LABEL,
    danger: false,
  });
  if (!yes) return false;
  let body: string;
  try {
    body = await deps.readText(item.lid);
  } catch {
    deps.say(REIMPORT_UNREADABLE);
    return false;
  }
  // ⚠ 答えを待つ間にノートが消えていたら置き換えない(消えたノートを作り直さない)
  if (deps.titleOf(item.lid) === null) return false;
  deps.replace(item.lid, body);
  await deps.refreshModified(item.lid);
  return true;
}
