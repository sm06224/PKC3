/**
 * 🔴 **録音・画面録画**(#413)。
 *
 * > user 要望 2026-07-16(PKC2 #922):
 * > 「**録音と画面収録をマルチメディアで埋め込めるようにする / これで、
 * > 会議メモをうまく残せるはず**」
 *
 * ## 🔴 PKC2 はここで壊れていた ── PKC3 はその原因を持っていない
 *
 * PKC2 は blob → **base64** → container 全体の JSON 保存でメモリが多段に増幅し、
 * 100MB 級の収録で**タブごと落ちて全損**していた(user 報告 2026-07-21)。
 *
 * 🔑 ここは **`Blob` の断片を配列に積むだけ**である ── ブラウザの `Blob` は
 *   bytes を **JS heap の外**に置くので、積んでも heap は増えない。
 *   最後に `new Blob(chunks)` で 1 本にして、そのまま IDB へ渡す
 *   (`attachOne` の口を通す ── 2 つ目の取り込み口を作らない)。
 * ⚠ **base64 にしない**(不可侵指示 2026-07-27「ゼロコピー」)。
 *
 * ## ⚠ ここは adapter である
 *
 * `MediaRecorder` / `getUserMedia` はブラウザの口なので `features/` に置けない。
 * 🔑 代わりに**口を注入できる形**にしてある ── そうしないと
 *   「実ブラウザでしか確かめられない」= 壊れても間欠の赤でしか気づけない。
 *
 * ## 🔴 切った 1 本の長さを容器へ書く(#952 A3)
 *
 * `MediaRecorder` が作る webm には**長さ(`Duration`)が書かれない** ──
 * 開くと `duration` が `Infinity` になり、シークバーが伸びない。
 * 🔑 **容器を走査して求めない**(この 1 本は最大 `partBytes` = 250MB ある。
 *   丸ごと読むのは高い)。代わりに**録っている側が持っている値**を使う ──
 *   1 本(= 1 つの `Recorder` インスタンス)の始まりから終わりまでの壁時計。
 *   容器に書き足すのは `features/audio/webm-opus.ts` の
 *   `insertMissingDuration`(先頭の数百バイトだけ読む ── 中身は 1 バイトも
 *   読まない・動かさない)。
 * 🟢 **画面録画(`kind: 'screen'`)にも効く**(2026-10-10 に実ブラウザで確かめた)。
 *   機構は track の中身を見ないので、VP8 + opus の容器でも同じ答えになる ──
 *   フル chromium / headless_shell の両方で、録ったままは `duration` が `Infinity`、
 *   書き足すと 4.008 秒(壁時計の 4008ms)になり、終わりの 0.5 秒前へ飛べた。
 *   回帰は `tests/smoke/media-capture.smoke.spec.ts` の録画の段が見る。
 * ⚠ **既にある添付は書き換えない**(不可逆 ── 添付を勝手に書き換えるのは
 *   user のデータへの介入である)。効くのは**これから録る物**だけ。
 *   `notice-log.ts` の対応する entry でそう伝える。
 */

import { insertMissingDuration } from '@features/audio/webm-opus';
import { NO_MIX_NOTICE, planScreenAudio, type MicState } from '@features/capture/audio-mix';

/** どちらを録るか。 */
export type CaptureKind = 'audio' | 'screen';

/**
 * 収録が終わった理由。⚠ **黙って終わらない** ── どれも user に見える。
 *
 * ⚠ `discarded`(捨てた)を**別の値にしてある**のは、受け側が
 *   「取り込む / 取り込まない」を**理由で**分けられるようにするため ──
 *   同じ `stopped` にすると、捨てたのに本文へ参照が入る。
 *
 * 🔴 **2026-09-08(#771):`too-large` を捨てて `too-long` / `failed` にした。**
 * ⚠ これは「記法を減らすな」の対象ではない ── user の言葉が
 *   「**画面録画と録音に関して、途中終了はしてほしくない**」なので、
 *   **大きさで止めること自体が間違い**だった(いまは切って録り続ける)。
 *   ⚠ 代わりに**上限は時間**になり(`too-long`)、**符号化が死んだ**ことを
 *   言う口が増えた(`failed` ── 直す前は受け口が 0 件で、黙って短くなっていた)。
 */
export type CaptureEnd = 'stopped' | 'shared-ended' | 'too-long' | 'failed' | 'discarded';

export interface CaptureHandle {
  readonly kind: CaptureKind;
  /** いま何バイト積んだか(概算 ── 帯に出す)。⚠ 切っても戻さない(通算)。 */
  bytes(): number;
  /**
   * 🔴 **これまでに切って渡した本数**(#771)。⚠ **いま録っている 1 本は含まない** ──
   *   帯に「N 本目」を出す側が `+1` する(数え方を 2 通りにしないため)。
   */
  parts(): number;
  /** 何ミリ秒経ったか。 */
  elapsedMs(): number;
  /** 止めて、それまでの分を返す。⚠ **1 バイトも録れていなければ `null`**。 */
  stop(): Promise<Blob | null>;
  /** 捨てる(bytes を手放す)。⚠ 止めた後に呼んでも安全。 */
  discard(): void;
}

/** 差し替えられる口(test はここに fake を入れる)。 */
export interface CaptureDeps {
  readonly getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  readonly getDisplayMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  /** ⚠ `MediaRecorder` そのもの(test は fake を渡す)。 */
  readonly Recorder?: typeof MediaRecorder;
  /** 🔴 画面録画の音を混ぜる口(#1985 項目 3)。⚠ test は fake を渡す。省略 = ブラウザのもの(無ければ混ぜない)。 */
  readonly AudioContext?: typeof AudioContext;
  readonly MediaStream?: typeof MediaStream;
  readonly now?: () => number;
}

export interface CaptureOptions {
  /**
   * 🔴 **1 本がここまで育ったら切って、次を始める**(#771)。⚠ **止めない**。
   * ⚠ PKC2 は 1 本を抱えたまま落ちて**全損**した ── 切るのはその再発を止める門でもある。
   * 🔑 **時間ではなく量で切る** ── 同じ 1 分でも、音だけと画面とでは桁が違う。
   */
  readonly partBytes: number;
  /**
   * 🔴 **ここに達したら止める**(user 指示 2026-09-07「最大時間を１２時間にして」)。
   * ⚠ 見るのは**断片が来たとき**である ── そのためだけの常駐タイマーを張らない。
   */
  readonly maxMs: number;
  /**
   * 🔴 **途中で切れた 1 本**(何本目かを添える)。⚠ **最後の 1 本はここへ来ない** ──
   *   そちらは `stop()` の約束が返す(受け口を 2 つにすると、どちらか片方だけ
   *   直る日が来る)。
   */
  readonly onPart?: (blob: Blob, part: number) => void;
  /** 終わったときに呼ぶ(自動で止まった場合も来る)。 */
  readonly onEnd?: (reason: CaptureEnd) => void;
  /**
   * 🔴 **断片が 1 つ届くたびに呼ぶ**(#1985 項目 2。途中保存の入口)。⚠ 待たない(同期に呼んで戻る)。
   * `segment` = 何本目か(0 始まり。`onPart` の `part - 1`、最後の 1 本は `parts()`)/ `index` = その本の中の番号(0 始まり)/
   * `elapsedMs` = その本の始まりからの経過。⚠ `blob` は受け取ったまま(写さない)。
   */
  readonly onChunk?: (c: { segment: number; index: number; elapsedMs: number; blob: Blob }) => void;
  /**
   * 🔴 **画面録画にマイクも混ぜるか**(#1985 項目 3。user 裁定 2026-11-20 案 A)。⚠ 省略 = 混ぜない(従来どおり)。
   * 製品は設定(既定 入)を渡す。音だけの録音では見ない。
   */
  readonly mixMic?: boolean;
  /** 🔴 録り始めに 1 度だけ出す知らせ(マイクが使えず共有の音だけにした、など)。 */
  readonly onNotice?: (text: string) => void;
}

/**
 * 断片を配る刻み。⚠ **1 秒より粗くしない** ── 切り所の見張りも帯の大きさも、
 *   断片が来たときにしか動かない。
 */
const SLICE_MS = 1000;

/** 断りの理由を持つ失敗。⚠ **黙って no-op にしない**(#413 の要件)。 */
export class CaptureRefused extends Error {}

/** 器を作れない / 始められない(権限は通っている)ときの文言。 */
export const CAPTURE_START_UNSUPPORTED =
  '録音・録画を始められませんでした(このブラウザは録音の形式に対応していません)';

/**
 * 🔴 **`Duration` を探すための先頭の読み量**(#952 A3)。
 *
 * ⚠ `Info`(容器の見出し)は実測で数百バイト以内(`TimestampScale` /
 *   `MuxingApp` / `WritingApp` くらいしか無い)── 桁で余裕を持たせても、
 *   1 本が 250MB あっても**ここだけは丸ごと読まない**ので安い。
 * 🔑 足りなければ `insertMissingDuration` が `incomplete` で断り、
 *   元の bytes をそのまま使う(退化するだけで、録音は壊れない)。
 */
const DURATION_HEADER_PREFIX_BYTES = 65536;

/**
 * 🔴 **切った 1 本に `Duration` を書き足す**(#952 A3)。
 *
 * ⚠ **先頭だけ読む**(`blob.slice` は写さない ── ゼロコピー)。書けなかった
 *   ときは元の `blob` をそのまま返す(この機能が録音そのものを壊してはいけない)。
 */
export async function withRecordedDuration(blob: Blob, durationMs: number): Promise<Blob> {
  try {
    const prefix = new Uint8Array(await blob.slice(0, DURATION_HEADER_PREFIX_BYTES).arrayBuffer());
    const patched = insertMissingDuration(prefix, durationMs);
    if (!patched.ok) return blob;
    return new Blob([patched.bytes as BlobPart, blob.slice(prefix.length)], { type: blob.type });
  } catch {
    // ⚠ 長さが書けなくても、録音そのものは壊さない(退化するだけ)
    return blob;
  }
}

/**
 * 🔴 **単調な時計を選ぶ**(#952 A3。着地前レビューで判明)。
 *
 * ⚠ ここで測った差は `Duration` として**添付へ恒久的に焼き込まれる**。
 *   `Date.now()` は **NTP の補正・スリープ復帰・user の時計変更**で前後に飛ぶので、
 *   飛んだぶんがそのまま長さになる ── **12 時間録れる**ので、飛ぶ窓も広い。
 * 🔑 `now()` は**差にしか使っていない**(`now() - startedAt` /
 *   `now() - segStartedAt` / `elapsedMs`)ので、既定を `performance.now()` へ
 *   替えても意味は変わらず、**時計の飛びが構造から消える**。
 * ⚠ 後ろ向きの飛びは `Math.max(0, …)` で既に潰してあったが、**前向きは無防備**だった
 *   ── 片側だけ守るのは、守っていないのと同じ形で残る。
 *
 * 🔴 **引数で受けるのは、門が本当に効くことを検められるようにするため**である
 *   ── `globalThis` を直に読むと、**どちらの枝を通ったか test から見えない**
 *   (CLAUDE.md §2「経路が一度も通っていない」)。⚠ 製品からは `globalThis` を渡す。
 *
 * @param host `performance` を持たない環境(古い箱)では `Date.now` へ落ちる。
 */
export function pickClock(host: { performance?: { now(): number } }): () => number {
  const perf = host.performance;
  if (perf === undefined || typeof perf.now !== 'function') return () => Date.now();
  return () => perf.now();
}

/**
 * 🔴 **画面の共有を頼む**(#1985 項目 3)。⚠ `systemAudio: 'include'` はシステム音声の共有を勧める指定。
 *   知らない辞書メンバは普通は無視されるが、型で断る実装(`TypeError`)なら**指定なしでやり直す**
 *   (許可の拒否などは `TypeError` ではないので、やり直さずそのまま断る)。
 */
async function askDisplay(
  ask: (c: MediaStreamConstraints) => Promise<MediaStream>,
): Promise<MediaStream> {
  try {
    return await ask({ video: true, audio: true, systemAudio: 'include' } as MediaStreamConstraints);
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    return ask({ video: true, audio: true });
  }
}

/** 🔴 マイクの許可の確認を待つ上限(これを過ぎたら「使えない」として画面と共有の音だけで始める)。 */
export const MIC_WAIT_MS = 15_000;

function stopTracks(s: MediaStream): void {
  for (const t of s.getTracks()) t.stop();
}

/**
 * マイクを頼む。⚠ 取れなくても録画は続けるので、理由は状態で返す(投げない)。
 * 🔴 **待つのは `MIC_WAIT_MS` まで**(許可の確認を放置されても、共有が生きたまま帯が出ない状態にしない)。
 *   ⚠ 時間切れの後で届いたマイクは**その場で止める**(表示を残さない)。
 */
async function askMic(
  deps: CaptureDeps,
): Promise<{ state: MicState; stream: MediaStream | null }> {
  const md = (globalThis as { navigator?: { mediaDevices?: MediaDevices } }).navigator?.mediaDevices;
  const fn = deps.getUserMedia ?? md?.getUserMedia?.bind(md);
  if (fn === undefined) return { state: 'unavailable', stream: null };
  let gaveUp = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const got = (async (): Promise<{ state: MicState; stream: MediaStream | null }> => {
    try {
      // 🔑 相手の声がスピーカーから回り込むので、エコー除去とノイズ抑制を頼む
      const s = await fn({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (gaveUp) {
        stopTracks(s);
        return { state: 'denied', stream: null };
      }
      return { state: 'ok', stream: s };
    } catch (e) {
      const name = (e as { name?: string } | null)?.name ?? '';
      return { state: name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable', stream: null };
    }
  })();
  const timeout = new Promise<{ state: MicState; stream: MediaStream | null }>((resolve) => {
    timer = setTimeout(() => {
      gaveUp = true;
      resolve({ state: 'denied', stream: null });
    }, MIC_WAIT_MS);
  });
  try {
    return await Promise.race([got, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function pick(deps: CaptureDeps, kind: CaptureKind): (c: MediaStreamConstraints) => Promise<MediaStream> {
  const md = (globalThis as { navigator?: { mediaDevices?: MediaDevices } }).navigator?.mediaDevices;
  const fn =
    kind === 'audio'
      ? (deps.getUserMedia ?? md?.getUserMedia?.bind(md))
      : (deps.getDisplayMedia ?? md?.getDisplayMedia?.bind(md));
  if (fn === undefined) {
    throw new CaptureRefused(
      kind === 'audio'
        ? 'この環境では録音できません(ブラウザが対応していません)'
        : 'この環境では画面録画できません(ブラウザが対応していません)',
    );
  }
  return fn;
}


/**
 * 🔴 **画面録画は、キーフレームを約 2 秒ごとに置く**(#683 段②b-3。設計 doc §6)。
 *
 * 既定は約 4.4 秒間隔(Chrome 141 で実測)── あとから前後を削るとき、切り出しの
 * 起点が最大でそのぶん手前へずれる。`videoKeyFrameIntervalDuration` で 2.0 秒に
 * なる(同じ環境の実測)。⚠ 音だけの録音は映像が無いので渡さない。
 * 知らない辞書メンバは読まれず無視されるので、対応の検出はしない。
 * 投げる実装があれば、**指定なしで作り直す**(録れないよりは既定の間隔で録る)。
 * ⚠ 器を作る 2 か所(最初と、切って次を起こすとき)が**必ずここを通る**。
 */
export const SCREEN_KEYFRAME_INTERVAL_MS = 2000;

export function newRecorder(
  Recorder: typeof MediaRecorder,
  stream: MediaStream,
  kind: CaptureKind,
): MediaRecorder {
  if (kind !== 'screen') return new Recorder(stream);
  try {
    return new Recorder(stream, {
      videoKeyFrameIntervalDuration: SCREEN_KEYFRAME_INTERVAL_MS,
    } as MediaRecorderOptions);
  } catch {
    return new Recorder(stream);
  }
}

/**
 * 🔴 **収録を始められなかったときの理由**(#1087)── ブラウザの例外名(`NotFoundError` …)を
 * そのまま画面に出さず、日本語の理由と次にすることへ置き換える。
 * ⚠ 許可の出し方は、外部リンクの案内(`popup-hint.ts`)と同じ書き方
 *   (「アドレスバーの右端で〜を許可してください」)。
 * ⚠ 知らない名前は理由を作らない ── 「収録を始められませんでした」だけにして、
 *   名前は括弧で残す(バグ報告の手がかり)。
 */
export function captureStartFailedText(kind: CaptureKind, name: string, message: string): string {
  const audio = kind === 'audio';
  switch (name) {
    case 'NotAllowedError':
      return audio
        ? 'マイクの許可がありません。アドレスバーの右端でマイクを許可してください'
        : '画面の共有が許可されませんでした。もう一度押して共有する画面を選ぶか、アドレスバーの右端で画面の共有を許可してください';
    case 'NotFoundError':
      return audio
        ? 'マイクが見つかりません。マイクをつないでから、もう一度押してください'
        : '共有する物が見つかりません。共有できる画面やウィンドウがあるかを確かめて、もう一度押してください';
    case 'NotReadableError':
      return audio
        ? 'マイクをほかのアプリが使っています。そのアプリを閉じてから、もう一度押してください'
        : '画面を読み取れません。ほかのアプリが使っていないかを確かめて、もう一度押してください';
    case 'AbortError':
      return '録音・録画を始める途中で中断されました。もう一度押してください';
    case 'OverconstrainedError':
      return audio
        ? 'このマイクでは録音できません。ほかのマイクに切り替えて、もう一度押してください'
        : 'この画面は録画できません。ほかの画面やウィンドウを選んで、もう一度押してください';
    case 'SecurityError':
      return 'ブラウザの設定で、このページでの録音・録画が許されていません';
    default:
      return `録音・録画を始められませんでした(${name || message})`;
  }
}

/**
 * 収録を始める。⚠ **断るときは理由つきで投げる**(権限拒否 / 非対応)。
 *
 * 🔴 **ブラウザ側の「共有を停止」でも正しく終わる** ── track の `ended` を見る。
 *   ⚠ 見ていないと**帯だけ残って、永久に録っているように見える**
 *   (PKC2 が明記していた要件)。
 */
export async function startCapture(
  kind: CaptureKind,
  deps: CaptureDeps,
  opts: CaptureOptions,
): Promise<CaptureHandle> {
  const now = deps.now ?? pickClock(globalThis);
  const found = deps.Recorder ?? (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  if (found === undefined) {
    throw new CaptureRefused('この環境では録音・録画できません(ブラウザが対応していません)');
  }
  /**
   * ⚠ **束ね直す** ── 下の `onSegmentStop` は関数宣言(巻き上げ)なので、
   *   `found` の絞り込みがそこまで届かない。`const` に受け直して型を確定させる。
   */
  const Recorder = found;
  const ask = pick(deps, kind);
  let stream: MediaStream;
  try {
    // ⚠ 画面録画でも**音を一緒に**頼む(会議メモは音が要る)
    stream = await (kind === 'audio' ? ask({ audio: true }) : askDisplay(ask));
  } catch (e) {
    const name = (e as { name?: string } | null)?.name ?? '';
    throw new CaptureRefused(captureStartFailedText(kind, name, (e as Error | null)?.message ?? ''));
  }

  /**
   * 🔴 **画面録画の音の組み立て**(#1985 項目 3)。録る器へ渡す stream は、映像 + (混ぜた音 | 共有の音 | マイク)。
   * ⚠ 組んだ stream は**収録 1 回で 1 つ**(切って次の器を起こすときも同じ物を渡す ── `AudioContext` を作り直さない)。
   * ⚠ 取った物(共有 / マイク / 混ぜ場)は**全部ここに控え**、`releaseStream` が 1 か所で止める。
   */
  const shared = stream;
  const held: MediaStream[] = [shared];
  let ctx: AudioContext | null = null;
  /**
   * 🔴 **共有の終わりは、マイクの許可を待つ前から見る**。⚠ 後から張ると、許可の確認中に「共有を停止」された回の
   *   `ended` を取り逃し、死んだ映像のまま録り始めてマイクも点いたままになる。
   */
  let sharedEnded = false;
  let onSharedEnd: (() => void) | null = null;
  for (const t of shared.getTracks()) {
    t.addEventListener('ended', () => {
      sharedEnded = true;
      onSharedEnd?.();
    });
  }
  /** 器へ渡す stream(音を混ぜない回は共有そのまま)。 */
  let recStream: MediaStream = shared;
  if (kind === 'screen' && opts.mixMic === true) {
    const mic = await askMic(deps);
    if (mic.stream !== null) held.push(mic.stream);
    const AC = deps.AudioContext ?? (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    const MS = deps.MediaStream ?? (globalThis as { MediaStream?: typeof MediaStream }).MediaStream;
    const plan = planScreenAudio({
      displayAudio: shared.getAudioTracks().length > 0,
      mic: mic.state,
      hasContext: AC !== undefined,
      hasStream: MS !== undefined,
    });
    let mixFailed = false;
    try {
      if (plan.use === 'mix' && AC !== undefined && MS !== undefined && mic.stream !== null) {
        const c = new AC();
        ctx = c;
        // 🔴 自動再生の制限で `suspended` のまま作られることがある ── 動かない混ぜ場は無音を録るので、
        //   動かせなければ混ぜない(共有の音のまま録る)
        if (c.state !== 'running') {
          try {
            await c.resume();
          } catch {
            // 下で state を見て退避する
          }
          if ((c.state as string) !== 'running') throw new Error('audio context is not running');
        }
        const dest = c.createMediaStreamDestination();
        c.createMediaStreamSource(shared).connect(dest);
        c.createMediaStreamSource(mic.stream).connect(dest);
        recStream = new MS([...shared.getVideoTracks(), ...dest.stream.getAudioTracks()]);
      } else if (plan.use === 'mic' && MS !== undefined && mic.stream !== null) {
        recStream = new MS([...shared.getVideoTracks(), ...mic.stream.getAudioTracks()]);
      }
    } catch {
      // 混ぜ場を作れなかった ── 共有のまま録る。使わなかったマイクと混ぜ場は**いま**止める(表示を残さない)
      recStream = shared;
      try {
        void Promise.resolve(ctx?.close()).catch(() => undefined);
      } catch {
        // 閉じられなくても続ける
      }
      ctx = null;
      mixFailed = true;
    }
    // 🔴 使わなかったマイクは**いま**止める(表示を残さない)
    if (mic.stream !== null && (mixFailed || (plan.use !== 'mix' && plan.use !== 'mic'))) stopTracks(mic.stream);
    const notice = mixFailed ? NO_MIX_NOTICE : plan.notice;
    if (notice !== null) opts.onNotice?.(notice);
    if (recStream !== shared) held.push(recStream);
  }

  const chunks: Blob[] = [];
  /** 切ってからここまでに積んだ量(**次の切り所**を測る)。 */
  let segBytes = 0;
  /** いまの本の中で、何個目の断片か(切るたびに 0 へ戻す。途中保存の鍵)。 */
  let segChunkNo = 0;
  /** 始めてからの総量(帯に出す)。⚠ 切っても戻さない。 */
  let total = 0;
  /** 🔴 **切って渡した本数**(#771)。⚠ **最後の 1 本は含まない**(`stop()` が返す)。 */
  let part = 0;
  const startedAt = now();
  /**
   * 🔴 **いま録っている 1 本(器 1 つぶん)の始まり**(#952 A3)。
   * ⚠ 切るたびに(次の `Recorder` を起こす直前に)リセットする ── `Duration` は
   *   **その 1 本自身の長さ**であって、収録全体の経過時間ではない。
   */
  let segStartedAt = startedAt;
  /** 捨てた ── 以後の断片も、既に積んだ分も**返さない**。 */
  let abandoned = false;

  /**
   * 🔴 **収録の段**(#771)。
   *
   * ⚠ `rotating` を**別の値にしてある**のが肝である ── 切っている最中に
   *   `onstop` が来たとき、「**次を始める**」のか「**終わる**」のかを
   *   読み分けるのはここ 1 か所だけ。⚠ 旗を 2 つに割ると、片方を壊しても
   *   もう片方が救って**変異が生き延びる**(CLAUDE.md §1「救い手が変わっただけ」)。
   */
  let phase: 'recording' | 'rotating' | 'done' = 'recording';

  /**
   * 🔴 **器を作れなかったら、取ったマイクを返す**(#1087)── `getUserMedia` は通っているので、
   *   ここで投げると **track が生きたまま**(マイクの表示が点いたまま)になる。
   */
  const releaseStream = (): void => {
    // 🔴 共有・マイク・混ぜた物の track を**全部**止め、混ぜ場も閉じる(ブラウザのマイク表示を残さない)
    for (const s of held) stopTracks(s);
    const c = ctx;
    ctx = null;
    if (c !== null) {
      try {
        void Promise.resolve(c.close()).catch(() => undefined);
      } catch {
        // 閉じられなくても止める手は止めない
      }
    }
  };
  // 🔴 マイクの許可・混ぜ場の準備を待つ間に共有が止められていたら、死んだ映像で録り始めない
  if (sharedEnded || shared.getTracks().some((t) => t.readyState === 'ended')) {
    releaseStream();
    throw new CaptureRefused('共有が止められたので、録画を始めませんでした。もう一度押してください');
  }
  let rec: MediaRecorder;
  try {
    rec = newRecorder(Recorder, recStream, kind);
  } catch {
    releaseStream();
    throw new CaptureRefused(CAPTURE_START_UNSUPPORTED);
  }

  /**
   * いま積んでいる分を 1 本にして、**積み場を空ける**。
   * ⚠ 捨てた回・1 バイトも無い回は `null`(呼び側は「渡さない」を選べる)。
   * 🔴 **`Duration` はここでは書かない**(#952 A3)── 次の器を作る手前で
   *   呼ばれるので、ここで待つと**録っていない隙間**ができる。長さだけ
   *   壁時計で持ち帰り、実際に書くのは `finalizeSegment`(非同期)に任せる。
   */
  const takeRawSegment = (): { blob: Blob; durationMs: number } | null => {
    if (abandoned || chunks.length === 0) return null;
    const blob = new Blob(chunks, { type: rec.mimeType || chunks[0]!.type });
    const durationMs = Math.max(0, now() - segStartedAt);
    chunks.length = 0;
    return { blob, durationMs };
  };

  /**
   * 🔴 **長さを容器へ書く**(#952 A3)。録音も画面録画も同じ道を通る
   *   (`media-capture.ts` 冒頭の docstring を見よ)。
   */
  const finalizeSegment = (seg: { blob: Blob; durationMs: number }): Promise<Blob> =>
    withRecordedDuration(seg.blob, seg.durationMs);

  /**
   * 🔴 **「止まった」は 1 本の約束で表す**(`onstop` が解決する)。
   *
   * ⚠ **押した時点の `chunks` を返してはいけない** ── 実物の `MediaRecorder` は
   *   `stop()` の**後に**最後の `dataavailable` を配ってから `stop` を撃つので、
   *   その場で組むと**末尾が欠ける**。とくに 12 時間 / 共有停止で先に終わっている回は、
   *   受け側が `stop()` を呼ぶのが**数ミリ秒あと**になるので必ず踏む。
   * ⚠ happy-dom の stub は同期に撃つので、**この欠陥は unit では見えない**
   *   (だから約束の側に寄せて、待ち方を 1 つにしてある)。
   */
  let settle: ((b: Blob | null) => void) | null = null;
  const stopped = new Promise<Blob | null>((resolve) => {
    settle = resolve;
  });
  const emit = (): void => {
    const resolve = settle;
    if (resolve === null) return;
    settle = null;
    const seg = takeRawSegment();
    if (seg === null) {
      resolve(null);
      return;
    }
    void finalizeSegment(seg).then(resolve);
  };

  /**
   * ⚠ **止めるのは 1 回だけ** ── 「止める」を押した直後に track の `ended` が
   *   来ることがある(ブラウザ側の停止と重なる)。2 回止めると例外になる。
   * ⚠ 止められなかった / 既に止まっていた回は**その場で解決する** ──
   *   `onstop` が来ない相手で待つと、受け側が**永久に待つ**。
   * 🔴 **切っている最中に終わりが来たら、`stop()` を撃ち直さない**(#771)──
   *   もう撃ってあるので、その `onstop` が下の分岐で `emit()` する。
   *   ⚠ 撃ち直すと例外になり、しかも**最後の 1 本が本になり損ねる**。
   */
  function finish(reason: CaptureEnd): void {
    if (phase === 'done') return;
    const wasRotating = phase === 'rotating';
    phase = 'done';
    opts.onEnd?.(reason);
    if (!wasRotating) {
      try {
        if (rec.state === 'inactive') emit();
        else rec.stop();
      } catch {
        emit(); // 既に止まっている ── 落とさない・待たせない
      }
    }
    releaseStream();
  }

  /**
   * 1 本ぶんが止まった。⚠ **ここが `rotating` と `done` の分かれ目**である。
   * 🔴 切っている最中なら、その 1 本を渡して**次の器を作って録り続ける**(#771)。
   *   ⚠ webm は**先頭にしか初期化情報が無い**ので、断片を途中で切っただけの
   *   2 本目は再生できない ── **器ごと作り直す**のが唯一「全部の file が
   *   揃って落ちてくる」形である。
   */
  function onSegmentStop(): void {
    if (phase !== 'rotating') {
      emit();
      return;
    }
    // 🔑 **先に取り出す**(次の器の壁時計と混ざらないように、リセットの前に読む)
    const seg = takeRawSegment();
    segBytes = 0;
    segChunkNo = 0;
    phase = 'recording';
    /**
     * 🔴 **本数は、失敗しうる手(次の器)より前に数える**(#1087)── 後ろだと、次の器が
     *   作れず `finish('failed')` した回に **`parts()` がまだ 0** で、保存済みの 1 本目があるのに
     *   「1 バイトも録れていません」と言ってしまう。
     */
    let p = 0;
    if (seg !== null) {
      part += 1;
      p = part; // ⚠ 非同期の間に `part` がまた進みうるので、値を控える
    }
    /**
     * 🔴 **次の器を先に起こす**(#952 A3)── `Duration` を書く仕事(次の段落)は
     *   非同期なので、そちらを待ってから起こすと**その間だけ録っていない隙間**
     *   ができる。⚠ 順番を変えると、録音そのものが欠ける側の欠陥になる。
     */
    try {
      rec = newRecorder(Recorder, recStream, kind);
      arm();
      rec.start(SLICE_MS);
    } catch {
      // 🔴 次の器を作れない ── **録っているふりをしない**(帯だけ伸びるのが最悪)
      finish('failed');
    }
    segStartedAt = now();
    if (seg !== null) {
      void finalizeSegment(seg).then((blob) => opts.onPart?.(blob, p));
    }
  }

  function onData(ev: BlobEvent): void {
    /**
     * ⚠ **`phase === 'done'` でも積む** ── 実物は `stop()` の**あと**に最後の
     *   断片を配る。ここで捨てると**末尾が丸ごと欠ける**(#413 の当の欠陥。
     *   1 稿目でうっかり捨て、`lateRecorder` の 2 本が即座に落ちて教えてくれた)。
     * 🔑 段を見るのは**切るかどうか**の判定だけ(下)。
     */
    if (abandoned || ev.data.size === 0) return;
    chunks.push(ev.data);
    segBytes += ev.data.size;
    total += ev.data.size;
    // 🔴 途中保存へ(`part` は切るたびに増えるが、増えるのは**最後の断片が届いた後**なので、ここで読む値は本の番号に等しい)
    // ⚠ 見張りが投げても、下の 12 時間 / 切り分けの判定を飛ばさない(収録そのものを守る)
    const chunkIndex = segChunkNo++;
    try {
      opts.onChunk?.({
        segment: part,
        index: chunkIndex,
        elapsedMs: Math.max(0, now() - segStartedAt),
        blob: ev.data,
      });
    } catch {
      // 途中保存の失敗は収録を止めない
    }
    /**
     * 🔴 **12 時間で止める**(user 指示 2026-09-07「最大時間を１２時間にして」)。
     * ⚠ **切るより先に見る** ── 同じ断片で両方に当たったら、止めるほうが勝つ
     *   (切ってから止めると、空の 1 本が生まれる)。**守っているのは順番**である。
     * ⚠ ここの `return` **そのものは no-op** である(下の切り分けは
     *   `phase === 'recording'` を見るので、止めた後は通らない)── 読み手のために
     *   早く抜けているだけ。変異試験でそう出たので、そう書いておく
     *   (CLAUDE.md「『これが無いと壊れる』と書く前に、外して壊れるのを見る」)。
     * 🔑 時計は**断片が来たとき**に見る ── そのためだけの `setInterval` を
     *   張らない(user 指示 2026-08-03「常駐を作らない」)。
     */
    if (now() - startedAt >= opts.maxMs) {
      finish('too-long');
      return;
    }
    /**
     * 🔴 **1 本が大きくなったら切って、次を始める**(#771)。⚠ **止めない** ──
     *   user の言葉は「**途中終了はしてほしくない**」である。
     */
    if (segBytes >= opts.partBytes && phase === 'recording') {
      phase = 'rotating';
      try {
        rec.stop();
      } catch {
        // 止められないなら切らない(録り続ける ── 次の断片でまた試す)
        phase = 'recording';
      }
    }
  }

  /**
   * 器 1 つぶんの配線。⚠ **切るたびに新しい器へ張り直す** ── 張り忘れると
   *   2 本目以降が**断片を 1 つも積まない**(そして誰も気づかない)。
   */
  function arm(): void {
    rec.ondataavailable = onData;
    rec.onstop = onSegmentStop;
    /**
     * 🔴 **符号化が死んだら止める**(#771)。⚠ 受け口が無いと断片が来なくなる
     *   だけなので、大きさの門にも当たらず**帯だけ伸び続ける** ── user から見ると
     *   「押していないのに短い」になる(それが今回の報告の形の 1 つである)。
     */
    rec.onerror = (): void => finish('failed');
  }

  arm();
  // 🔴 ブラウザ側の「共有を停止」
  // ⚠ 見るのは**共有(音声の収録ではマイク)**の track だけ ── 画面録画中にマイクだけが抜けても、録画は続ける
  onSharedEnd = () => finish('shared-ended');

  // ⚠ 1 秒ごとに切る ── 切らないと `ondataavailable` が最後に 1 回しか来ず、
  //    切り所の見張りも帯の大きさも**動かない**
  try {
    rec.start(SLICE_MS);
  } catch {
    releaseStream();
    throw new CaptureRefused(CAPTURE_START_UNSUPPORTED);
  }

  return {
    kind,
    bytes: () => total,
    parts: () => part,
    elapsedMs: () => now() - startedAt,
    stop: () => {
      finish('stopped');
      return stopped;
    },
    discard: () => {
      // ⚠ **先に立てる** ── これより後に届く断片も、既に積んだ分も返さない
      abandoned = true;
      finish('discarded');
      // ⚠ **bytes を手放す**(2026-07-27「ライフサイクル終端での即破棄」)
      chunks.length = 0;
      total = 0;
      segBytes = 0;
    },
  };
}
