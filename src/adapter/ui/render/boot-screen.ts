/**
 * 🔴 **起動の途中と、起動に失敗したときの画面**(#1087、依頼 73。Gemini の回答「推薦どおり」= 1 は B / 2 は B)。
 *
 * 出どころ:起動の間(データが大きいときや更新の直後は数秒かかる)、画面は真っ白で字が 1 つも無く、
 * 固まったのか待てばよいのか分からなかった。失敗の画面にはボタンが無く、原因の分からない失敗では
 * 英語の詳細がそのまま出ていた。
 *
 * - 起動中:最初から 1 行(「データを開いています…」)。**2 秒を超えたら**理由を足す(すぐ終わる起動では 1 行がちらっと見えるだけ)
 * - 失敗:説明 +「詳細を表示」(押すと詳細が出る)+「読み込み直す」+「バックアップ」(依頼 208。読める範囲を取り出す)。
 *   詳細は `bootFailureText` が末尾に `(詳細: …)` で添える形を切り出す ── 括弧が無い失敗は説明の全文のまま出す
 *
 * ⚠ 起動前なので `root` に素の要素を置くだけ(shell は無い)。`showRootText` と同じく `data-pkc-shell` を外す。
 */

export const BOOT_PROGRESS_TEXT = 'データを開いています…';
export const BOOT_PROGRESS_SLOW_TEXT = 'データが大きいときや、更新の直後は時間がかかります';
/** 理由を足すまでの待ち(ms)。 */
export const BOOT_PROGRESS_SLOW_MS = 2000;

const DETAIL_TAIL = /^([\s\S]*?)\(詳細: ([\s\S]*)\)\s*$/;

/** 起動中の 1 行を出す。2 秒たってもまだこの画面なら理由を足す。 */
export function showBootProgress(root: HTMLElement): void {
  root.removeAttribute('data-pkc-shell');
  root.textContent = '';
  const box = document.createElement('div');
  box.setAttribute('data-pkc-boot-progress', '');
  const line = document.createElement('p');
  line.textContent = BOOT_PROGRESS_TEXT;
  box.append(line);
  root.append(box);
  setTimeout(() => {
    // 別の画面(本体が出た / 失敗 / 別のタブ待ち)へ替わっていたら足さない
    if (!box.isConnected) return;
    const more = document.createElement('p');
    more.setAttribute('data-pkc-boot-progress-slow', '');
    more.textContent = BOOT_PROGRESS_SLOW_TEXT;
    box.append(more);
  }, BOOT_PROGRESS_SLOW_MS);
}

/** 起動に失敗した画面の「バックアップ」の字(#1163 依頼 208)。 */
export const BOOT_BACKUP_LABEL = 'バックアップ';
/** 押す前の説明(ボタンの title)。 */
const BOOT_BACKUP_TITLE = '読める範囲のノートを取り出して、取り込めば戻せる .pkc3-part.zip で保存します';

/**
 * 起動に失敗した画面。`handoff` は説明の後ろに足す案内(ファイルから開いた場合)。
 * `reload` は「読み込み直す」が押されたときの動き(test では差し替える)。
 * @param backup 🔴 **「バックアップ」**(#1163 依頼 208。user 回答 = 再読み込みとバックアップの両方を出す)。
 *   押すと読める範囲のノートを取り出して保存し、結果の 1 行を返す(`boot-rescue.ts`)。⚠ 渡さなければ出さない
 *   (持ち歩ける 1 枚の HTML はファイルそのものが控えなので出さない)。
 * @param working 集めている間に出す字
 */
export function showBootFailure(
  root: HTMLElement,
  text: string,
  handoff = '',
  reload: () => void = () => location.reload(),
  backup?: () => Promise<string>,
  working = '読める分を集めています…',
): void {
  root.removeAttribute('data-pkc-shell');
  root.textContent = '';
  const box = document.createElement('div');
  box.setAttribute('data-pkc-boot-failure', '');
  const m = DETAIL_TAIL.exec(text);
  const lead = m ? (m[1] ?? '').trimEnd() : text;
  const detail = m ? (m[2] ?? '') : null;
  const p = document.createElement('p');
  // 改行(ファイルから開いた場合の案内)を保つ
  p.style.whiteSpace = 'pre-line';
  p.textContent = `${lead}${handoff}`;
  box.append(p);
  if (detail !== null) {
    const d = document.createElement('details');
    const s = document.createElement('summary');
    s.textContent = '詳細を表示';
    const pre = document.createElement('pre');
    pre.setAttribute('data-pkc-boot-failure-detail', '');
    pre.style.whiteSpace = 'pre-wrap';
    pre.textContent = detail;
    d.append(s, pre);
    box.append(d);
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('data-pkc-boot-reload', '');
  btn.textContent = '読み込み直す';
  btn.addEventListener('click', reload);
  box.append(btn);
  if (backup !== undefined) {
    const save = document.createElement('button');
    save.type = 'button';
    save.setAttribute('data-pkc-boot-backup', '');
    save.textContent = BOOT_BACKUP_LABEL;
    save.title = BOOT_BACKUP_TITLE;
    // 結果の 1 行(押すまでは無い)。⚠ 読み上げにも届くよう status にする
    const status = document.createElement('p');
    status.setAttribute('data-pkc-boot-backup-status', '');
    status.setAttribute('role', 'status');
    status.hidden = true;
    save.addEventListener('click', () => {
      // ⚠ 集めている間は押せなくする ── 2 回目で同じ保存領域を 2 本で開き直さない
      save.disabled = true;
      status.hidden = false;
      status.textContent = working;
      void backup()
        .catch(() => '読めた分を書き出せませんでした')
        .then((said) => {
          status.textContent = said;
          save.disabled = false;
        });
    });
    box.append(save, status);
  }
  root.append(box);
}
