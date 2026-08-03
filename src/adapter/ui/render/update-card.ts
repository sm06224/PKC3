/**
 * 「新しい版があります」の面(P7 段⑤、設計 doc §2-3)。
 *
 * ⚠ **注意(notices)とは別の面**にする。notices は取込・書出しのたびに
 * `showNotices` が中身を作り替えるので、更新の案内をそこへ載せると
 * **次の取込で黙って消える**(user が押す前に導線が失われる)。
 */
export function showUpdateCard(region: HTMLElement): void {
  region.textContent = '';

  const text = document.createElement('span');
  text.setAttribute('data-pkc-field', 'update-text');
  text.textContent = '新しい版があります。';

  const apply = document.createElement('button');
  apply.type = 'button';
  apply.setAttribute('data-pkc-action', 'apply-update');
  apply.textContent = '再読込';

  const later = document.createElement('button');
  later.type = 'button';
  later.setAttribute('data-pkc-action', 'dismiss-update');
  later.textContent = 'あとで';

  region.append(text, apply, later);
  region.hidden = false;
}

/**
 * 交代を頼んだあとの面(P7 段⑤ review H-2)。
 *
 * ⚠ **面ごと消さない**。押した直後に消すと、交代が成立しなかったときに
 * 「押したのに何も起きず、導線だけ無くなった」になる ── 実際にその形を踏んだ。
 * 押せる導線だけを外し、何が起きているかは残す。
 */
export function showUpdatingCard(region: HTMLElement): void {
  region.textContent = '';
  const text = document.createElement('span');
  text.setAttribute('data-pkc-field', 'update-text');
  text.textContent = '新しい版に切り替えています…';
  region.append(text);
  region.hidden = false;
}

/** 見送る(⚠ 次に開いたときに再び出る ── 待機中の worker は残るため)。 */
export function clearUpdateCard(region: HTMLElement): void {
  region.textContent = '';
  region.hidden = true;
}

/** 面と「押されたら何をするか」。 */
export interface UpdatePrompt {
  /** 新しい版に気づいた ── 押されたら `apply` を呼ぶ。 */
  present(apply: () => void): void;
  /** 「再読込」が押された。 */
  apply(): void;
  /** 「あとで」が押された。 */
  dismiss(): void;
}

export interface UpdatePromptDeps {
  /**
   * 編集中(= 再読込で消える下書きがある)か。
   * 🔴 再読込は open editor の本文を**確認なしで捨てる** ── 本文は AppState に
   * しか無く(永続は `PERSIST_ENTRY` のみ)、`beforeunload` も無い(review M-2)。
   * 案内は editor の隣に出る常設面なので、誤クリックが起きうる。
   */
  isEditing?(): boolean;
  /** 捨ててよいか聞く。⚠ `delete-entry` / `purge-trash` と同じ倒し方に揃える。 */
  confirmDiscard?(): boolean;
}

/**
 * 面と押されたときの動きをまとめる(P7 段⑤)。
 *
 * 🔑 **`main.ts` に直書きしない**。押した後は再読込が走るので、
 * 「押したら案内がどうなるか」は smoke からは観測できない(次のページには無い)
 * ── 変異試験で実際に生き残った。**取り出せば test できる**。
 *
 * ⚠ 交代を**頼むだけ**。再読込は交代が済んでから(`watchForUpdate` の側)。
 */
export function createUpdatePrompt(
  region: HTMLElement,
  deps: UpdatePromptDeps = {},
): UpdatePrompt {
  let pending: (() => void) | null = null;
  return {
    present(apply) {
      pending = apply;
      showUpdateCard(region);
    },
    apply() {
      const run = pending;
      if (!run) return;
      // ⚠ 断られたら**何も変えない**(面も pending もそのまま)── 押し直せる
      if (deps.isEditing?.() && !(deps.confirmDiscard?.() ?? true)) return;
      // ⚠ 先に null にする ── 交代は一度きり。連打で 2 回頼まない
      pending = null;
      // ⚠ 面ごと消さない(review H-2)。押せる導線だけ外し、状況は残す
      showUpdatingCard(region);
      run();
    },
    dismiss() {
      // ⚠ `pending` は残す(押せる導線が無くなるだけ)。次に開けば再び出る
      clearUpdateCard(region);
    },
  };
}
