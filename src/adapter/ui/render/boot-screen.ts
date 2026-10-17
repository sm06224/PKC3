/**
 * 🔴 **起動の途中と、起動に失敗したときの画面**(#1087、依頼 73。Gemini の回答「推薦どおり」= 1 は B / 2 は B)。
 *
 * 出どころ:起動の間(データが大きいときや更新の直後は数秒かかる)、画面は真っ白で字が 1 つも無く、
 * 固まったのか待てばよいのか分からなかった。失敗の画面にはボタンが無く、原因の分からない失敗では
 * 英語の詳細がそのまま出ていた。
 *
 * - 起動中:最初から 1 行(「データを開いています…」)。**2 秒を超えたら**理由を足す(すぐ終わる起動では 1 行がちらっと見えるだけ)
 * - 失敗:説明 +「詳細を表示」(押すと詳細が出る)+「読み込み直す」。
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

/**
 * 起動に失敗した画面。`handoff` は説明の後ろに足す案内(ファイルから開いた場合)。
 * `reload` は「読み込み直す」が押されたときの動き(test では差し替える)。
 */
export function showBootFailure(
  root: HTMLElement,
  text: string,
  handoff = '',
  reload: () => void = () => location.reload(),
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
  root.append(box);
}
