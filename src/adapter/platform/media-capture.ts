/**
 * 🔴 **録音・画面収録**(#413)。
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
 * ⚠ **画面収録(`kind: 'screen'`)はまだ対象外** ── 機構は track の中身を
 *   見ないので効くはずだが、実ブラウザの画面収録では確かめていない。
 * ⚠ **既にある添付は書き換えない**(不可逆 ── 添付を勝手に書き換えるのは
 *   user のデータへの介入である)。効くのは**これから録る物**だけ。
 *   `notice-log.ts` の対応する entry でそう伝える。
 */

import { insertMissingDuration } from '@features/audio/webm-opus';

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
}

/**
 * 断片を配る刻み。⚠ **1 秒より粗くしない** ── 切り所の見張りも帯の大きさも、
 *   断片が来たときにしか動かない。
 */
const SLICE_MS = 1000;

/** 断りの理由を持つ失敗。⚠ **黙って no-op にしない**(#413 の要件)。 */
export class CaptureRefused extends Error {}

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
async function withRecordedDuration(blob: Blob, durationMs: number): Promise<Blob> {
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
        : 'この環境では画面収録できません(ブラウザが対応していません)',
    );
  }
  return fn;
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
    throw new CaptureRefused('この環境では収録できません(ブラウザが対応していません)');
  }
  /**
   * ⚠ **束ね直す** ── 下の `onSegmentStop` は関数宣言(巻き上げ)なので、
   *   `found` の絞り込みがそこまで届かない。`const` に受け直して型を確定させる。
   */
  const Recorder = found;
  const ask = pick(deps, kind);
  let stream: MediaStream;
  try {
    // ⚠ 画面収録でも**音を一緒に**頼む(会議メモは音が要る)
    stream = await ask(kind === 'audio' ? { audio: true } : { video: true, audio: true });
  } catch (e) {
    const name = (e as { name?: string } | null)?.name ?? '';
    throw new CaptureRefused(
      name === 'NotAllowedError'
        ? kind === 'audio'
          ? 'マイクの許可がありません'
          : '画面の共有が許可されませんでした'
        : `収録を始められませんでした(${name || (e as Error).message})`,
    );
  }

  const chunks: Blob[] = [];
  /** 切ってからここまでに積んだ量(**次の切り所**を測る)。 */
  let segBytes = 0;
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

  let rec = new Recorder(stream);

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
   * 🔴 **長さを容器へ書く**(#952 A3)。⚠ **画面収録はまだ対象外**
   *   (`media-capture.ts` 冒頭の docstring を見よ)。
   */
  const finalizeSegment = (seg: { blob: Blob; durationMs: number }): Promise<Blob> =>
    kind === 'audio' ? withRecordedDuration(seg.blob, seg.durationMs) : Promise.resolve(seg.blob);

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
    for (const t of stream.getTracks()) t.stop();
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
    phase = 'recording';
    /**
     * 🔴 **次の器を先に起こす**(#952 A3)── `Duration` を書く仕事(次の段落)は
     *   非同期なので、そちらを待ってから起こすと**その間だけ録っていない隙間**
     *   ができる。⚠ 順番を変えると、録音そのものが欠ける側の欠陥になる。
     */
    try {
      rec = new Recorder(stream);
      arm();
      rec.start(SLICE_MS);
    } catch {
      // 🔴 次の器を作れない ── **録っているふりをしない**(帯だけ伸びるのが最悪)
      finish('failed');
    }
    segStartedAt = now();
    if (seg !== null) {
      part += 1;
      const p = part; // ⚠ 非同期の間に `part` がまた進みうるので、値を控える
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
  for (const t of stream.getTracks()) t.addEventListener('ended', () => finish('shared-ended'));

  // ⚠ 1 秒ごとに切る ── 切らないと `ondataavailable` が最後に 1 回しか来ず、
  //    切り所の見張りも帯の大きさも**動かない**
  rec.start(SLICE_MS);

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
