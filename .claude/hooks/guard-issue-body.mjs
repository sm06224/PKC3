#!/usr/bin/env node
/**
 * 🔴 issue / PR の「本文」を、コメントのつもりで上書きするのを止める門。
 *
 * ⚠ 2026-08-13 に 2 回、2026-09-21 に 1 回踏んだ(#134 / #145 / #1017)──
 *   `issue_write` の `method: "update"` に `body` を渡すと**本文がまるごと置き換わる**。
 *   GitHub の編集履歴はこの箱から引けないので、**消えた本文は戻せない**。
 *   `.claude/skills/github-tools/SKILL.md` に 2 度書いた戒めが 2 度とも効かなかったので、
 *   3 か所目の文言にせず**門**にした(CLAUDE.md「文言を 3 か所目にせず、機構で止める」)。
 *
 * 🔑 止めるのは「**既に在る issue の本文を置き換える**」呼び出しだけ:
 *   - `method: "create"`(新規起票)は通す ── 本文は新しく書く物なので消える物が無い
 *   - `body` を渡さない `update`(題名 / state / label だけ)は通す
 *
 * 🔑 禁止が解ける条件(= 本当に本文を書き直したいとき):
 *   `PKC3_ALLOW_ISSUE_BODY_UPDATE=1` を立てる。
 *   ⚠ そのときも**先に現在の本文を読んで控える**(`issue_read` → scratchpad へ保存)。
 */
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  if (process.env.PKC3_ALLOW_ISSUE_BODY_UPDATE === '1') process.exit(0);

  let input;
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    process.exit(0); // 読めない入力で作業を止めない(門は「消える操作」だけを見る)
  }

  const name = String(input.tool_name ?? '');
  if (!name.endsWith('issue_write')) process.exit(0);

  const args = input.tool_input ?? {};
  if (args.method !== 'update') process.exit(0);
  if (args.body === undefined || args.body === null) process.exit(0);

  const num = args.issue_number ?? '(番号なし)';
  process.stderr.write(
    [
      `本文の上書きを止めました(issue #${num})。`,
      '',
      'issue_write の method:"update" に body を渡すと、いまの本文がまるごと消えます。',
      'GitHub の編集履歴はこの箱から引けないので、消えた本文は戻せません(2026-09-21 に #1017 で実際に消しました)。',
      '',
      '・コメントを足したいなら → add_issue_comment を使う',
      '・閉じたいなら → ①add_issue_comment で結末 ②issue_write で state だけ(body を渡さない)',
      '・本当に本文を書き直すなら → 先に issue_read で現在の本文を控えてから、',
      '  PKC3_ALLOW_ISSUE_BODY_UPDATE=1 を立てて実行する',
    ].join('\n'),
  );
  process.exit(2);
});
