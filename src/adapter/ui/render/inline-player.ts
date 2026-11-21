/**
 * 🔴 **その場の小さなプレーヤー**(#1966 4-3 ②。user 裁定 2026-11-17「押したときの再生は、その場の小さなプレーヤー
 *   (必要ならそのプレーヤーから元の録音ノートへ飛べる導線を添える)」)。
 *
 * 議事録などに入った時刻つきの引用 `[0:15](entry:<録音>#t=15)` を押すと、**ノートを移らずに**、押したリンクの
 * 段落のすぐ下に小さなプレーヤーが出て、その時刻から鳴る。プレーヤーには
 *
 * - 録音の名前と「0:15 から」
 * - 再生機(`<audio controls>` / 動画なら `<video controls>`)
 * - 「録音のノートを開く」(そのノートを開き、その時刻から鳴らす ── 4-3 ① の道)
 * - 「×」(閉じる)
 *
 * が並ぶ。⚠ **補助は主の作業領域を奪わない**(CLAUDE.md §2-10)── 中央の本文は動かさず、段落の下に 1 枚差すだけ。
 *
 * ## 寿命(⚠ 不可侵指示「生成物はライフサイクルの終端で即破棄」)
 *
 * - 同時に出るのは **1 枚だけ**。新しく開く・閉じる・ノートを移る・本文が描き直されて器が外れる、のどれでも
 *   **ObjectURL を revoke** して器を外す(`closeInlinePlayer`)。
 * - 録音の長さを超える時刻(#1163 依頼 373 と同じ規則)なら鳴らさず、そう言う。
 *
 * 🔑 何を鳴らすか(録音の本文 → 添付の鍵 → 実体)は呼び手が `load` で渡す ── ここは器と寿命だけを持つ。
 */
import { elapsedText, msToSeconds } from '@features/elapsed-text';
import { appVoiceBoostRouter } from './voice-boost';
import { unloadMedia } from './media-release';

export const INLINE_PLAYER_FIELD = 'inline-player';

export interface InlinePlayerSource {
  /** 再生機に差す URL(この module が閉じるときに `dispose` を呼ぶ)。 */
  readonly url: string;
  readonly dispose: () => void;
  readonly mime: string;
  /** 録音の名前(見出しに出す)。 */
  readonly name: string;
}

interface Open {
  readonly box: HTMLElement;
  readonly owner: string | null;
  dispose: (() => void) | null;
  observer: MutationObserver | null;
}

let current: Open | null = null;

/** いま出ているプレーヤー(無ければ `null`)。 */
export function inlinePlayerBox(): HTMLElement | null {
  return current?.box ?? null;
}

/** プレーヤーを開いたときに居たノート(移ったら閉じるため)。 */
export function inlinePlayerOwner(): string | null {
  return current?.owner ?? null;
}

/** 閉じる(URL を返し、器を外す)。何度呼んでもよい。 */
export function closeInlinePlayer(): void {
  const c = current;
  if (c === null) return;
  current = null;
  c.observer?.disconnect();
  // ⚠ `src` を外すだけでは読み込みは止まらない ── `load()` まで通す(`media-release.ts`)
  unloadMedia(c.box, null);
  c.dispose?.();
  c.dispose = null;
  c.box.remove();
}

export const INLINE_PLAYER_BEYOND = 'この時刻は録音の長さを超えています';
export const INLINE_PLAYER_GONE = '録音が見つかりません(消したか、まだ読み込めていません)';
export const INLINE_PLAYER_NOT_MEDIA = 'このリンク先は再生できる音・動画ではありません';

/**
 * 押したリンクの段落の下にプレーヤーを出して、その時刻から鳴らす。
 *
 * @param anchor 押したリンク(この要素を含む段落・引用・項目の直後に差す)
 * @param lid 録音のノート
 * @param ms 鳴らし始める時刻
 * @param owner 開いたときに居たノート(移ったら閉じる)
 * @param load 録音の実体を借りる(借りられなければ `null`)
 */
export async function openInlinePlayer(args: {
  readonly anchor: HTMLElement;
  readonly lid: string;
  readonly ms: number;
  readonly owner: string | null;
  readonly load: () => Promise<InlinePlayerSource | null>;
}): Promise<HTMLElement> {
  closeInlinePlayer();
  const doc = args.anchor.ownerDocument;
  const box = doc.createElement('div');
  box.setAttribute('data-pkc-field', INLINE_PLAYER_FIELD);
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', '録音を聞く');
  box.setAttribute('data-pkc-entry', args.lid);
  const head = doc.createElement('div');
  head.setAttribute('data-pkc-field', 'inline-player-head');
  const label = doc.createElement('span');
  label.setAttribute('data-pkc-field', 'inline-player-label');
  label.textContent = `${elapsedText(args.ms)} から`;
  const open = doc.createElement('button');
  open.type = 'button';
  open.setAttribute('data-pkc-action', 'inline-player-open-note');
  open.setAttribute('data-pkc-entry', args.lid);
  open.setAttribute('data-pkc-seek-ms', String(args.ms));
  open.textContent = '録音のノートを開く';
  const close = doc.createElement('button');
  close.type = 'button';
  close.setAttribute('data-pkc-action', 'inline-player-close');
  close.setAttribute('aria-label', 'プレーヤーを閉じる');
  close.title = 'プレーヤーを閉じる';
  close.textContent = '×';
  head.append(label, open, close);
  const note = doc.createElement('p');
  note.setAttribute('data-pkc-field', 'inline-player-note');
  note.hidden = true;
  box.append(head, note);
  // ⚠ 段落・引用・項目の**直後**に差す(リンクの字の中に割り込ませない)
  const block = args.anchor.closest('blockquote, li, p, td') ?? args.anchor;
  block.after(box);
  const entry: Open = { box, owner: args.owner, dispose: null, observer: null };
  current = entry;
  // 🔴 本文が描き直されて器ごと外れたら、借りた URL を返す(閉じる口を押されないまま消える道)
  if (typeof MutationObserver === 'function' && box.parentNode !== null) {
    entry.observer = new MutationObserver(() => {
      if (current === entry && !box.isConnected) closeInlinePlayer();
    });
    entry.observer.observe(doc.body, { childList: true, subtree: true });
  }
  const say = (text: string): void => {
    note.textContent = text;
    note.hidden = false;
  };
  let src: InlinePlayerSource | null;
  let why = INLINE_PLAYER_GONE;
  try {
    src = await args.load();
  } catch (e) {
    // 🔑 読み手が理由を言えるときはその字(音・動画でない、など)。言えないときは「見つかりません」
    src = null;
    if (e instanceof Error && e.message !== '') why = e.message;
  }
  // 借りている間に閉じられた / 別のプレーヤーに替わった → 借りた物はすぐ返す
  if (current !== entry) {
    src?.dispose();
    return box;
  }
  if (src === null) {
    say(why);
    return box;
  }
  entry.dispose = src.dispose;
  label.textContent = `${src.name}・${elapsedText(args.ms)} から`;
  const media = doc.createElement(src.mime.startsWith('video/') ? 'video' : 'audio');
  media.controls = true;
  media.preload = 'metadata';
  media.setAttribute('data-pkc-field', 'inline-player-media');
  // 🔑 本文・録ったものの再生機と同じ扱い(音を聞きやすくする設定がここでも効く ── `voice-boost.ts`)
  appVoiceBoostRouter.watch(media);
  const at = msToSeconds(args.ms);
  media.addEventListener(
    'loadedmetadata',
    () => {
      if (current !== entry) return;
      // 🔴 長さを超える時刻は鳴らさない(#1163 依頼 373 と同じ規則)
      if (Number.isFinite(media.duration) && args.ms > media.duration * 1000) {
        say(INLINE_PLAYER_BEYOND);
        return;
      }
      media.currentTime = at;
      const played = media.play();
      if (played !== undefined && typeof played.catch === 'function') {
        played.catch((err: unknown) => {
          if (!(err instanceof DOMException && err.name === 'AbortError')) say('再生を始められませんでした(▶ を押してください)');
        });
      }
    },
    { once: true },
  );
  media.src = src.url;
  box.insertBefore(media, note);
  return box;
}
