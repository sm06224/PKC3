/**
 * 🔴 **組み込みのサンプルテンプレート**(#2002 段 2)── 「テンプレートから作る」の一覧に、自分のテンプレートの後ろへ並ぶ。
 *
 * > user の物語:回帰テストの記録・当番の引き継ぎ・仮説の検証 ── 毎回同じ項目を打つ定型のノートを、
 * > 入力欄(` ```yaml form `)と表(` ```csv name=… `)つきで、選ぶだけで作りたい。
 *
 * 🔑 **置き場所の裁定**: コードに持つ**読み取り専用の定数**とし、DB には置かない。
 * - user の一覧・フォルダ・検索・バックアップに**混ざりようがない**(保存しないので `system` 領域のノートを増やす必要もない)
 * - 双方向: 選ぶと**ふつうのノート(複製)**ができる。複製を直しても消しても、サンプルは 1 バイトも動かない
 * - 作られるノートは**新しい種類も新しい本文の形も持たない**(全 body = PKC-Markdown。` ```yaml form ` と ` ```csv ` の囲みだけ)
 *
 * ⚠ 定義(囲み)は**複製側がそれぞれ持つ**(後でサンプルが変わっても、作った記録ノートは変わらない ── 裁定 1)。
 * ⚠ 本文は `insertSnippet` を通して作る(日付の差し込みを 2 か所に書かない)。囲みの中は値にされない(`fillSnippetVars`)。
 * pure。
 */

export interface SampleTemplate {
  readonly id: string;
  /** 一覧の字と、作るノートの題名。 */
  readonly title: string;
  /** 一覧の字(題名の後ろ)。 */
  readonly summary: string;
  readonly body: string;
}

/** 一覧の行の値の頭。⚠ 自分のテンプレートのノートの lid とぶつからないよう、値に付ける。 */
export const SAMPLE_VALUE_PREFIX = 'sample:';

const QA_BODY = [
  '# 回帰テストの実施記録',
  '',
  'リリース前の回帰テストを 1 回ごとに記録します。作成日: ${date}',
  '',
  '1. 下の入力欄に、今回の実施内容を入れます。',
  '2. 「表に追加」を押すと、その下の表に 1 行たまります(入力欄はそのまま次の記録に使えます)。',
  '3. 入力欄の項目は、下の定義を書き換えると、このノートだけ変わります。',
  '',
  '```yaml form',
  'title: 回帰テストの実施',
  'table: 実施記録',
  'fields:',
  '  - name: 実施日時',
  '    type: datetime',
  '  - name: ビルド',
  '    type: text',
  '    required: true',
  '    placeholder: 例 1.4.2-rc1',
  '  - name: 担当者',
  '    type: text',
  '    required: true',
  '  - name: 対象範囲',
  '    type: checkbox-group',
  '    options: [認証, 編集, 書き出し, 取り込み, 検索]',
  '  - name: 結果',
  '    type: radio',
  '    options: [合格, 条件付き合格, 不合格]',
  '    required: true',
  '  - name: 重大な不具合',
  '    type: select',
  '    options: [なし, 軽微, 重大]',
  '  - name: 再テストの件数',
  '    type: number',
  '  - name: 要再確認',
  '    type: checkbox',
  '  - name: 所見',
  '    type: textarea',
  '```',
  '',
  '## 実施記録',
  '',
  '```csv name=実施記録',
  '実施日時,ビルド,担当者,対象範囲,結果,重大な不具合,再テストの件数,要再確認,所見',
  '```',
  '',
].join('\n');

const HANDOFF_BODY = [
  '# 当番の引き継ぎ',
  '',
  '当番の交代のたびに、次の人へ渡すことを残します。作成日: ${date}',
  '',
  '1. 交代の直前に、下の入力欄へ状況を入れます。',
  '2. 「表に追加」を押すと、引き継ぎ履歴の表に 1 行たまります。',
  '3. 次の当番は、表の最後の行を読めば、いま何が起きているか分かります。',
  '',
  '```yaml form',
  'title: 引き継ぎ',
  'table: 引き継ぎ履歴',
  'fields:',
  '  - name: 引き継ぎ日時',
  '    type: datetime',
  '  - name: 渡す人',
  '    type: text',
  '    required: true',
  '  - name: 受ける人',
  '    type: text',
  '    required: true',
  '  - name: 状況',
  '    type: radio',
  '    options: [平常, 注意, 障害対応中]',
  '    required: true',
  '  - name: 影響する範囲',
  '    type: checkbox-group',
  '    options: [画面, API, バッチ, データベース, 外部連携]',
  '  - name: 顧客への影響',
  '    type: checkbox',
  '  - name: 次の確認期限',
  '    type: date',
  '  - name: 見込み時間',
  '    type: number',
  '    placeholder: 復旧までの時間',
  '  - name: 申し送り',
  '    type: textarea',
  '```',
  '',
  '## 引き継ぎ履歴',
  '',
  '```csv name=引き継ぎ履歴',
  '引き継ぎ日時,渡す人,受ける人,状況,影響する範囲,顧客への影響,次の確認期限,見込み時間,申し送り',
  '```',
  '',
].join('\n');

const DISCOVERY_BODY = [
  '# 仮説と検証の記録',
  '',
  '「こうではないか」を 1 件ずつ書き出し、確かめた結果を残します。作成日: ${date}',
  '',
  '1. 下の入力欄に、仮説と確かめ方を入れます。',
  '2. 「表に追加」を押すと、仮説一覧の表に 1 行たまります。',
  '3. 結果が出たら、表の該当の行を読み込んで「判定」を直し、「表の行を更新」で書き戻します。',
  '',
  '```yaml form',
  'title: 仮説',
  'table: 仮説一覧',
  'fields:',
  '  - name: 仮説',
  '    type: textarea',
  '    required: true',
  '    placeholder: 誰の、どんな困りごとを、何で解決できるか',
  '  - name: 対象の利用者',
  '    type: text',
  '    required: true',
  '  - name: 確信度',
  '    type: number',
  '    placeholder: 0 から 100',
  '  - name: 優先度',
  '    type: radio',
  '    options: [高, 中, 低]',
  '  - name: 確かめ方',
  '    type: checkbox-group',
  '    options: [インタビュー, アンケート, 試作, 数字の分析]',
  '  - name: 判定の期日',
  '    type: date',
  '  - name: 判定',
  '    type: select',
  '    options: [未判定, 支持された, 否定された, 保留]',
  '  - name: 次の一手を決めた',
  '    type: checkbox',
  '```',
  '',
  '## 仮説一覧',
  '',
  '```csv name=仮説一覧',
  '仮説,対象の利用者,確信度,優先度,確かめ方,判定の期日,判定,次の一手を決めた',
  '```',
  '',
].join('\n');

export const SAMPLE_TEMPLATES: readonly SampleTemplate[] = [
  { id: 'qa-regression', title: '回帰テストの実施記録', summary: '実施のたびに表へ 1 行', body: QA_BODY },
  { id: 'ops-handoff', title: '当番の引き継ぎ', summary: '交代のたびに表へ 1 行', body: HANDOFF_BODY },
  { id: 'product-discovery', title: '仮説と検証の記録', summary: '仮説ごとに表へ 1 行', body: DISCOVERY_BODY },
];

/** 一覧の行の字。 */
export function sampleLabel(s: SampleTemplate): string {
  return `サンプル: ${s.title}(${s.summary})`;
}

/** 一覧の行の値から、サンプルを引く。サンプルでなければ `null`。 */
export function sampleOfValue(value: string): SampleTemplate | null {
  if (!value.startsWith(SAMPLE_VALUE_PREFIX)) return null;
  const id = value.slice(SAMPLE_VALUE_PREFIX.length);
  return SAMPLE_TEMPLATES.find((s) => s.id === id) ?? null;
}
