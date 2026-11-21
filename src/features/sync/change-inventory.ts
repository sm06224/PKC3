/**
 * 🔴 **端末間の同期(#2000)── 変更の集合に何が乗るか・乗らないかの全数表**(段 1)。
 *
 * 同期は任意の設定(既定 OFF)。ここは「運ぶ物」を**名指しで**持つ ── 一覧に無い種類が
 * 増えた日に「入れ忘れ」と「わざと入れない」が区別できなくなるのを防ぐ(`settings-file.ts` の
 * `PORTABLE_KEYS` / `SKIPPED_KEYS` と同じ考え方)。`tests/features/sync/change-inventory.test.ts` が
 * 件数と各行の整合を固定する。設計 doc §12.1 の表はこの定数のコピーである。
 *
 * ⚠ pure module。
 */

/** `yes` = 単独で運ぶ / `part-of` = 別の物の一部として運ぶ / `derived` = 本文から導かれる / `no` = 運ばない。 */
export type SyncCarry = 'yes' | 'part-of' | 'derived' | 'no';

export interface SyncInventoryRow {
  readonly id: string;
  readonly label: string;
  readonly carry: SyncCarry;
  /** 運ぶ段(2 = `*.pkc3-diff.zip` から、3 = フォルダ同期で全データ)。運ばないなら `null`。 */
  readonly stage: 2 | 3 | null;
  /** どう運ぶか(運ばないなら代わりの道)。 */
  readonly how: string;
  /** そう決めた理由。 */
  readonly why: string;
}

export const SYNC_INVENTORY: readonly SyncInventoryRow[] = [
  {
    id: 'body',
    label: '本文',
    carry: 'yes',
    stage: 2,
    how: 'ノートごとに内容ハッシュで照合し、本文を丸ごと運ぶ(行の差分は使わない)',
    why: '全 body が PKC-Markdown 1 本なので単位が揃う。取り込み側は前の本文を履歴へ残してから置き換える',
  },
  {
    id: 'title',
    label: '題名',
    carry: 'part-of',
    stage: 2,
    how: 'ノートの指紋の「内容」欄(題名・種別・本文)の一部として運ぶ',
    why: '題名だけの変更も「変更」として検出するため。別に照合しない。移動と別の欄なので、移動と編集は自動で合わさる',
  },
  {
    id: 'kind',
    label: '種別(フレーバー)',
    carry: 'part-of',
    stage: 2,
    how: 'ノートの指紋の「内容」欄の一部として運ぶ',
    why: '種別を変えるとフレーバーの抽出列が変わるので、本文と同じ単位で動かす',
  },
  {
    id: 'parent',
    label: '親フォルダ',
    carry: 'part-of',
    stage: 2,
    how: 'フォルダへの所属(structural のつながり)の宛先 ID を、ノートの指紋の「親フォルダ」欄に入れる',
    why: '移動だけの変更も検出し、編集とは欄ごとに合わせる(同じ欄が両方で違うときだけ競合)。並び順は端末ごとの表示順なので含めない',
  },
  {
    id: 'tags',
    label: 'タグ',
    carry: 'derived',
    stage: 2,
    how: '本文から導かれる語なので、本文と一緒に動く',
    why: 'タグは独立の値ではない(索引列 body_tags は受け取った側が作り直す)',
  },
  {
    id: 'relations',
    label: 'つながり',
    carry: 'yes',
    stage: 2,
    how: '(from / to / 種類)をキーにして照合する(id ではない。2 台が同じつながりを別々に作っても 1 本になる)。指紋は定数で、作る・消すだけ',
    why: 'つながりは単独で増減し、中身の変更が無い。フォルダ所属以外(意味・出典など)も同じ道',
  },
  {
    id: 'labels',
    label: '色ラベル・ピン留め',
    carry: 'yes',
    stage: 3,
    how: 'コレクションの settings 表の行を、ID をキー・値のハッシュで照合する',
    why: '本文・更新日時に触れない別の保存先なので、ノートの指紋には入らない。段 2 の差分ファイルでは運ばず、段 3 で揃える',
  },
  {
    id: 'revisions',
    label: '履歴(版)',
    carry: 'no',
    stage: null,
    how: '運ばない。取り込んだ側が、本文を置き換える前に自分の履歴へ 1 版残す',
    why: '履歴は端末ごとの逆向き差分の鎖で、版の id と鎖の位置が端末固有。運ぶと鎖が読めなくなり、量も大きい。全部を運ぶ道はバックアップ(.pkc3-full.zip)',
  },
  {
    id: 'assets',
    label: '添付',
    carry: 'yes',
    stage: 2,
    how: 'ハッシュをキーに、相手に無い実体だけを運ぶ(同じ内容は 1 度だけ)',
    why: '実体は内容で同一性が決まる。ノートが参照する添付だけを対象にする',
  },
  {
    id: 'settings',
    label: '設定・フラグ',
    carry: 'no',
    stage: null,
    how: '運ばない。設定だけは「設定ファイル」で別に移せる',
    why: '端末ごとの見た目・許可が混ざると意味が変わる(同期のオン・オフも端末ごと)',
  },
  {
    id: 'system-notes',
    label: 'system 領域のノート(メッセージ等)',
    carry: 'no',
    stage: null,
    how: '運ばない',
    why: 'その端末のアプリが自分について言った記録で、user のノートではない(バックアップにも入らない)',
  },
  {
    id: 'trash',
    label: '削除(ゴミ箱)',
    carry: 'yes',
    stage: 2,
    how: '「消した」という事実(削除の記録: ID と消した時点の指紋)だけを運ぶ。受け取った側は自分のゴミ箱へ移す(戻せる)',
    why: 'ゴミ箱の中身は運ばない(別の端末の消した版を溜めない)。削除の記録はゴミ箱を空にしても消えない別の記録に持つ',
  },
  {
    id: 'sync-state',
    label: '同期の記録(端末 id・連番・相手ごとの前回の合意・削除の記録)',
    carry: 'no',
    stage: null,
    how: '運ばない。端末ごとに持つ',
    why: '端末 id を共有すると同じ端末と見なされ、変更が消える',
  },
];
