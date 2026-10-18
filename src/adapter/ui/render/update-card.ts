/**
 * 「新しい版があります」の面(P7 段⑤、設計 doc §2-3)。
 *
 * ⚠ **注意(notices)とは別の面**にする。notices は取込・書出しのたびに
 * `showNotices` が中身を作り替えるので、更新の案内をそこへ載せると
 * **次の取込で黙って消える**(user が押す前に導線が失われる)。
 */
/**
 * 🔴 **画面に出る字は、ここが正本**(#532 段 C、2026-09-09)。
 *
 * ⚠ セルフホストの `はじめに.txt` とマニュアルが「読み直すとこう出ます」と**案内する**ので、
 *   字が 2 か所に別々に書かれると、片方だけ変わった日に **user は別のものを探す**
 *   (CLAUDE.md「文言は押した場所と対で pin する」)。
 * 🔑 だから export して、案内の側の test がここから引く。
 */
export const UPDATE_TEXT = '新しいバージョンがあります。';

/**
 * 🔴 **切り替える前に、何が変わるかへの手がかり**(台帳 #1852 束 L2。依頼 84-2 B)。
 * ⚠ 以前はカードに「新しいバージョンがあります。」だけで、切り替えた後に何が起きるかが書いてなかった。
 *   変更点は切り替えた後のお知らせで読める。⚠ `UPDATE_TEXT` は別の file(はじめに.txt)が引くので、字を足すだけで変えない。
 */
export const UPDATE_HINT = '切り替えると、変更点がお知らせに出ます。';

/**
 * 🔴 **別のタブで切り替わったとき、押していないタブに出す字**(台帳 #1852 束 L2。依頼 131 A)。
 * ⚠ 古いバージョンのまま動き続けると、あとで保存の役目を引き継ぐときに古い部品が無くて失敗する。書きかけは巻き込まない
 *   (勝手に読み込み直さず、押されたときだけ)。
 */
export const UPDATE_ELSEWHERE_TEXT =
  '別のタブで新しいバージョンに切り替わりました。このタブも読み込み直してください。';

/**
 * 🔴 **「あとで切り替える」を押した後も、切り替える場所を残す**(台帳 #1852 束 L2。依頼 84-1 C / 120-2 A)。
 * ⚠ 直す前は、カードを消すと PKC3 を開き直すまで切り替えるボタンがどこにも無かった。
 *   「見送った」(= 待機中の版が在る)を module に持ち、システムの「お知らせ」とヘルプの版の行が行を出す。
 */
let updatePendingFlag = false;
const pendingListeners = new Set<() => void>();
function setUpdatePending(on: boolean): void {
  if (updatePendingFlag === on) return;
  updatePendingFlag = on;
  for (const fn of [...pendingListeners]) fn();
}
/** 新しいバージョンが待っているか(カードを見送った後も真)。 */
export function updatePending(): boolean {
  return updatePendingFlag;
}
/** 変わったら呼ぶ。戻り値で聞くのをやめる。 */
export function onUpdatePendingChange(fn: () => void): () => void {
  pendingListeners.add(fn);
  return () => pendingListeners.delete(fn);
}

/**
 * 🔴 **「新しいバージョンに切り替える」の行**(システムの「お知らせ」・ヘルプの版の行に置く)。
 * ⚠ 待っている版が無い間は隠れる。押し口は既存の `apply-update`(カードのボタンと同じ受け手 ── 新しい操作を作らない)。
 */
export function buildUpdateAvailableRow(tag: 'p' | 'div' = 'p'): HTMLElement {
  const row = document.createElement(tag);
  row.setAttribute('data-pkc-field', 'update-available');
  const text = document.createElement('span');
  text.textContent = `${UPDATE_TEXT}`;
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.setAttribute('data-pkc-action', 'apply-update');
  apply.textContent = '新しいバージョンに切り替える';
  row.append(text, apply);
  const paint = (): void => {
    row.hidden = !updatePendingFlag;
  };
  paint();
  let wasConnected = false;
  const off = onUpdatePendingChange(() => {
    // 作り直されて外れた行は聞くのをやめる(器を作り直すたびに聞き手が溜まらない)
    if (row.isConnected) wasConnected = true;
    else if (wasConnected) return void off();
    paint();
  });
  return row;
}

export function showUpdateCard(region: HTMLElement): void {
  region.textContent = '';

  const text = document.createElement('span');
  text.setAttribute('data-pkc-field', 'update-text');
  text.textContent = `${UPDATE_TEXT}${UPDATE_HINT}`;

  const apply = document.createElement('button');
  apply.type = 'button';
  apply.setAttribute('data-pkc-action', 'apply-update');
  apply.textContent = '新しいバージョンに切り替える';

  const later = document.createElement('button');
  later.type = 'button';
  later.setAttribute('data-pkc-action', 'dismiss-update');
  later.textContent = 'あとで切り替える';

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
export function showUpdatingCard(region: HTMLElement, label = '新しいバージョンに切り替えています…'): void {
  region.textContent = '';
  const text = document.createElement('span');
  text.setAttribute('data-pkc-field', 'update-text');
  text.textContent = label;
  region.append(text);
  region.hidden = false;
}

/** 切り替えを頼んでから、これだけ待っても切り替わらないときの字(依頼 84-6 B)。 */
export const UPDATE_STUCK_TEXT = '切り替わりませんでした。ページを読み込み直してください。';
/** 「切り替わらなかった」と見なすまでの待ち(ミリ秒)。 */
export const UPDATE_STUCK_MS = 10_000;

/**
 * 🔴 **「切り替えています…」のまま止まったとき**(台帳 #1852 束 A1。依頼 84-6 B)。
 * ⚠ 直す前は、このカードのまま押し直す道が無かった。字を改め、読み込み直す道(`apply-update` と同じ受け手)を付ける。
 */
export function showUpdateStuckCard(region: HTMLElement, withReload: boolean): void {
  region.textContent = '';
  const text = document.createElement('span');
  text.setAttribute('data-pkc-field', 'update-text');
  text.textContent = UPDATE_STUCK_TEXT;
  region.append(text);
  if (withReload) {
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.setAttribute('data-pkc-action', 'apply-update');
    apply.textContent = '読み込み直す';
    region.append(apply);
  }
  region.hidden = false;
}

/**
 * 別のタブで切り替わったときのカード(依頼 131 A)。⚠ 押すのは「読み込み直す」(`apply-update` と同じ受け手)。
 */
export function showUpdateElsewhereCard(region: HTMLElement): void {
  region.textContent = '';
  const text = document.createElement('span');
  text.setAttribute('data-pkc-field', 'update-text');
  text.textContent = UPDATE_ELSEWHERE_TEXT;
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.setAttribute('data-pkc-action', 'apply-update');
  apply.textContent = '読み込み直す';
  const later = document.createElement('button');
  later.type = 'button';
  later.setAttribute('data-pkc-action', 'dismiss-update');
  later.textContent = 'あとで読み込み直す';
  region.append(text, apply, later);
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
  /** 別のタブが切り替えた ── 押されたら `reload` を呼ぶ(依頼 131 A。書きかけは勝手に消さない)。 */
  elsewhere(reload: () => void): void;
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
  /** ⚠ **非同期**(#299 段③)── 確認はアプリ自身のダイアログになった。 */
  confirmDiscard?(): Promise<boolean>;
  /** 切り替わらずに止まったときの「読み込み直す」(依頼 84-6 B)。無ければ字だけ出す。 */
  reload?(): void;
  /** 止まったと見なすまでの待ち(ミリ秒)。試験で短くする。 */
  stuckMs?: number;
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
  /** 別のタブの切り替えを受けた読み込み直しか(押した後の字を変える)。 */
  let isElsewhere = false;
  /** 「切り替えています…」の見張り(依頼 84-6 B)。別の面に替わったら外す。 */
  let stuckTimer: ReturnType<typeof setTimeout> | null = null;
  const stopWatch = (): void => {
    if (stuckTimer !== null) clearTimeout(stuckTimer);
    stuckTimer = null;
  };
  return {
    present(apply) {
      stopWatch();
      pending = apply;
      isElsewhere = false;
      setUpdatePending(true);
      showUpdateCard(region);
    },
    elsewhere(reload) {
      stopWatch();
      // ⚠ 待機中の版を持つ印(`updatePending`)は立てない ── 切り替えるのではなく読み込み直すだけ
      pending = reload;
      isElsewhere = true;
      showUpdateElsewhereCard(region);
    },
    async apply() {
      const run = pending;
      if (!run) return;
      // ⚠ 断られたら**何も変えない**(面も pending もそのまま)── 押し直せる
      // ⚠ 確認は**後から**返る ── ここを同期のまま書くと、押した瞬間に
      //   再読込してしまう(確認が飾りになる)
      if (deps.isEditing?.() === true && !((await deps.confirmDiscard?.()) ?? true)) return;
      // ⚠ 先に null にする ── 交代は一度きり。連打で 2 回頼まない
      pending = null;
      setUpdatePending(false);
      // ⚠ 面ごと消さない(review H-2)。押せる導線だけ外し、状況は残す
      showUpdatingCard(region, isElsewhere ? '読み込み直しています…' : undefined);
      run();
      // 🔴 切り替わらないまま止まったら、字を改めて読み込み直す道を出す(依頼 84-6 B)。
      //    ⚠ 切り替われば再読込で消えるので、タイマーは残っても害は無い
      stopWatch();
      stuckTimer = setTimeout(() => {
        stuckTimer = null;
        const reload = deps.reload;
        if (reload !== undefined) pending = reload;
        showUpdateStuckCard(region, reload !== undefined);
      }, deps.stuckMs ?? UPDATE_STUCK_MS);
    },
    dismiss() {
      stopWatch();
      // ⚠ `pending` は残す(押せる導線が無くなるだけ)。次に開けば再び出る
      clearUpdateCard(region);
    },
  };
}
