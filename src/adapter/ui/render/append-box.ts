/**
 * 追記欄(P8 段⑧)。
 *
 * > user 指示 2026-08-03「**追記型は今すぐ実装して、今のままだと、なんの意味もない**」
 * > 「**編集競合は競合ロックと強制解放も念頭にしてください**」
 *
 * 🔴 前の実装(段⑥)は「編集画面を開いて末尾へ飛ぶ」だけだった ── 5000 行の
 * ログでも毎回全文を textarea に載せる。**追記型の意味が無い**。ここは編集画面を
 * 通らず、打って押したら**その場で disk へ書く**。
 *
 * 🔑 **器を作り直さない**。本文は追記のたびに書き換わって再描画されるので、
 * 同じ器に入れると**打ちかけの文字も focus も消える**。だから `shell` が
 * 別 region を持ち、この描画器は**中身を作るのは 1 回だけ**で、以後は
 * 表示・ロック状態だけを更新する。
 *
 * ⚠ 変換中(IME)の Enter で送らない ── `isComposing` を見る。
 */
import type { AppState } from '@adapter/state/app-state';
import { bodyLockOf } from '@adapter/state/app-state';
import { isAppendable } from '@features/flavor/append-spec';
import { iconButton } from './icons';

/** 追記欄の見え方。⚠ ここが唯一の判定(描画側と binder で二重に持たない)。 */
export type AppendMode =
  | { kind: 'hidden' }
  | { kind: 'ready'; lid: string }
  /** 自分の編集が握っている ── 保存 / 破棄で解ける(強制解放の穏当な形)。 */
  | { kind: 'editing'; lid: string }
  /** 書込が飛んでいる ── 通常は一瞬。返ってこなければ強制解放。 */
  | { kind: 'writing'; lid: string };

/**
 * いま追記欄をどう出すか。**pure** なので unit で全パターン見られる。
 * ⚠ 「本文が読めていない」ときは出さない ── 押しても書けないボタンを出さない。
 */
export function appendModeOf(state: AppState): AppendMode {
  const lid = state.selectedLid;
  if (!lid || state.viewMode !== 'detail') return { kind: 'hidden' };
  if (!isAppendable(state.entryMetas.get(lid)?.archetype)) return { kind: 'hidden' };
  const lock = bodyLockOf(state);
  if (lock?.lid === lid) return { kind: lock.holder, lid };
  // ⚠ 本文が届いていない間は出さない(追記の基底は disk だが、
  //    「開けていないノートに書く」導線は user から見て嘘になる)
  if (state.openBody?.lid !== lid) return { kind: 'hidden' };
  if (state.phase !== 'ready') return { kind: 'hidden' };
  return { kind: 'ready', lid };
}

export class AppendBoxRenderer {
  private readonly region: HTMLElement;
  private readonly form: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly lockBar: HTMLElement;
  private readonly lockText: HTMLElement;
  private readonly resolve: HTMLElement;
  private readonly discard: HTMLElement;
  private readonly release: HTMLElement;
  private last: AppendMode['kind'] | null = null;
  private lastLid: string | null = null;

  constructor(region: HTMLElement) {
    this.region = region;

    this.form = document.createElement('div');
    this.form.setAttribute('data-pkc-field', 'append-form');
    this.input = document.createElement('textarea');
    this.input.setAttribute('data-pkc-field', 'append-input');
    this.input.rows = 2;
    this.input.placeholder = '追記する内容(Ctrl+Enter で追記)';
    this.form.append(this.input, iconButton('append-entry', '追記'));

    this.lockBar = document.createElement('div');
    this.lockBar.setAttribute('data-pkc-field', 'append-lock');
    this.lockText = document.createElement('span');
    this.lockText.setAttribute('data-pkc-field', 'append-lock-reason');
    // 編集が握っているとき ── **失わない出口を先に出す**
    this.resolve = iconButton('commit-edit', '保存して解放');
    this.discard = iconButton('cancel-edit', '編集を破棄');
    // 書込が返らないとき ── 最後の出口
    this.release = iconButton('force-release', '強制解放');
    this.lockBar.append(this.lockText, this.resolve, this.discard, this.release);

    this.region.append(this.lockBar, this.form);
  }

  /** 書込に入った時点の disk 内容。**成功したかどうかの唯一の判別材料**。 */
  private persistedAtWrite: string | null = null;

  render(state: AppState): void {
    const mode = appendModeOf(state);
    // 選択が別のノートへ移ったら打ちかけを捨てる(別のノートへ書いてしまわない)
    const lid = mode.kind === 'hidden' ? null : mode.lid;
    if (lid !== this.lastLid) {
      this.input.value = '';
      this.lastLid = lid;
    }
    // 🔑 **通ったときだけ欄を空にする**。失敗・強制解放では打った内容を残す ──
    // 「押したら消えたが保存されていない」は、この機構で一番やってはいけない負け方。
    // ⚠ 判別は `persisted`(disk で確認できた内容)の変化で見る ── `error` の
    // 有無で見ると、無関係な別の失敗に引きずられる
    if (this.last === 'writing' && mode.kind !== 'writing') {
      if (state.openBody?.persisted !== this.persistedAtWrite) this.clear();
      this.persistedAtWrite = null;
    } else if (mode.kind === 'writing' && this.last !== 'writing') {
      this.persistedAtWrite = state.openBody?.persisted ?? null;
    }
    if (mode.kind === this.last) return; // 種類が同じなら DOM を触らない
    this.last = mode.kind;
    this.region.hidden = mode.kind === 'hidden';
    this.form.hidden = mode.kind !== 'ready';
    this.lockBar.hidden = mode.kind === 'ready' || mode.kind === 'hidden';
    this.resolve.hidden = mode.kind !== 'editing';
    this.discard.hidden = mode.kind !== 'editing';
    this.release.hidden = mode.kind !== 'writing';
    if (mode.kind === 'editing') {
      this.lockText.textContent = 'このノートは編集中です。保存するか、編集を破棄すると追記できます。';
    } else if (mode.kind === 'writing') {
      this.lockText.textContent = '追記を書き込んでいます…(返ってこないときは強制解放)';
    }
  }

  /** 追記が通ったら欄を空にして、続けて打てるようにする(連続追記)。 */
  clear(): void {
    this.input.value = '';
    this.input.focus();
  }
}
