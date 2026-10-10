/**
 * 設定の画面(P8 段④)。
 *
 * > user 指示 2026-08-03「**テーマは設定系の画面にしまってください。
 * > 普段から必要ではない**」
 *
 * 🔑 **画面**であって、かぶせる窓ではない ── 「同じものが常に同じ場所にある」
 * という業務画面の作法に従い、ほかの面と同じ場所(中央)に出す。
 *
 * ⚠ ここは**めったに来ない場所**。だから常時見える帯からは外したが、
 * 押す導線そのものは畳まない(操作の帯に「設定」を置く)。
 */
import { SameOriginGrants } from '@adapter/platform/same-origin-grants';
import { ExtensionGrants } from '@adapter/platform/extension-grants';
import { AgentGrants, appAgentGrants } from '@adapter/platform/agent-grants';
import { AgentTabStatus, appAgentTabStatus } from '@adapter/platform/agent-tab-status';
import type { AppState } from '@adapter/state/app-state';
import { appStorageVacuum, type StorageVacuum } from '@adapter/platform/storage/vacuum-run';
import { STORAGE_SECTION_LABEL } from '@features/asr/asr-text';
import { appEditorMode, EditorModeStore } from './editor-mode';
import { appOpenInEdit, OpenInEditStore } from './open-in-edit';
import { appAlarmEnabled, AlarmEnabledStore } from './alarm-enabled';
import { appVoiceBoost, VoiceBoostStore } from './voice-boost';
import { appMissingLinks, MissingLinksStore } from './missing-links';
import { appCodeCollapse, CodeCollapseStore } from './code-collapse';
import { appInlineCodeCopy, InlineCodeCopyStore } from './inline-code-copy';
import { appPdfReader, PdfReaderStore } from './pdf-reader-setting';
import { appPhoneLinks, PhoneLinksStore } from './phone-links';
import { appDateLinks, DateLinksStore } from './date-links';
import { appRelativeDays, RelativeDaysStore } from './relative-days';
import { appColorSwatch, ColorSwatchStore } from './color-swatch';
import { NOTICES, type Notice } from '@features/notice/notice-log';
import { appExternalImages, ExternalImagePolicy } from './external-images';
import { appPasteSource, PasteSourceStore } from './paste-source';
import { appJobMonitor, type JobMonitor } from '@adapter/platform/job-monitor';
import { appNoticeStore, type NoticeStore } from '@adapter/platform/notice-store';
import { appTooNarrowOk, TooNarrowOkStore } from './too-narrow';
import { buildOfficePackPanel, type OfficePackPanel } from './office-pack-panel';
import { buildAsrPackPanel, type AsrPackPanel } from './asr-pack-panel';
import { buildSettingsCommands, buildSettingsFile } from './commands';
import { buildKeymapPanel, type KeymapPanel } from './keymap-panel';
import type { SettingsGroup, SettingsSection } from './settings/section';
import { createMessagesSection } from './settings/messages';
import { createThemeSection } from './settings/theme';
import { createPageFormatSection } from './settings/page-format';
import { createProseAlignSection } from './settings/prose-align';
import { createTextScaleSection } from './settings/text-scale';
import { createReadColumnsSection } from './settings/read-columns';
import { createColumnRuleSection } from './settings/column-rule';
import { createTagBadgeSection } from './settings/tag-badge';
import { createEditorModeSection } from './settings/editor-mode';
import { createOpenInEditSection } from './settings/open-in-edit';
import { createPhoneLinksSection } from './settings/phone-links';
import { createDateLinksSection } from './settings/date-links';
import { createRelativeDaysSection } from './settings/relative-days';
import { createColorSwatchSection } from './settings/color-swatch';
import { createMissingLinksSection } from './settings/missing-links';
import { createCodeCollapseSection } from './settings/code-collapse';
import { createInlineCodeCopySection } from './settings/inline-code-copy';
import { createPdfReaderSection } from './settings/pdf-reader';
import { createPasteSourceSection } from './settings/paste-source';
import { createAlarmEnabledSection } from './settings/alarm-enabled';
import { createVoiceBoostSection } from './settings/voice-boost';
import { createOpenPlaceSection } from './settings/open-place';
import { createAppOpenTargetSection } from './settings/app-open-target';
import { createExternalImagesSection } from './settings/external-images';
import { createSameOriginSection } from './settings/same-origin';
import { createExtensionsSection } from './settings/extensions';
import { createAgentsSection } from './settings/agents';
import { createOpenedHistorySection } from './settings/opened-history';
import { createSearchHistorySection } from './settings/search-history';
import { createCopyHistorySection } from './settings/copy-history';
import { createTooNarrowSection } from './settings/too-narrow';
import { createPersistSection } from './settings/persist';
import { createNoticesSection, createNoticeListSection } from './settings/notices';


export class SettingsRenderer {
  private built = false;
  /** Office 一式の節(#88 / O6-a)。⚠ 器と同じ寿命 ── 自分で変化を購読する。 */
  private officePack: OfficePackPanel | null = null;
  private asrPack: AsrPackPanel | null = null;
  /**
   * ショートカットキーの節(#256)。⚠ 器と同じ寿命 ── 自分で割当の変化を購読する。
   * ⚠ 組み直しは 1 度だけ(`built`)なので、購読も capture も 1 組しか生きない。
   */
  private keymapPanel: KeymapPanel | null = null;

  constructor(
    private readonly region: HTMLElement,
    /**
     * ⚠ **段②b でこの画面からは外した**(「処理(ワーカー)── 開発者向け」節を
     *   `buildJobs()` ごと削除。代わりの入口は「システム → メッセージ →
     *   処理の記録を開く」)。この引数はもう**この class の中では読まない**。
     *   ⚠ それでも**位置は動かさない** ── ここより後ろの全引数が、この file の
     *   規約どおり「末尾に足す」形で積まれており(すぐ下の docstring 群)、
     *   数十の test が位置引数でそこへ届いている。1 つ抜くと、その全部を
     *   ずらす作業が要る(この段の主題ではない ── 触るなら別 PR で)。
     */
    private readonly monitor: JobMonitor = appJobMonitor,
    /** 外部画像の設定(2026-08-06)。⚠ test は自分で `new` して渡す。 */
    private readonly externalImages: ExternalImagePolicy = appExternalImages,
    /**
     * お知らせを出すか(P11 段⑤)。⚠ **戻し道はここ 1 か所**である ──
     * 帯の「今後は出さない」を押した user が復帰できる唯一の場所なので、
     * `tests/adapter/announce.test.ts` がこの往復を守る。
     */
    private readonly notices: NoticeStore = appNoticeStore,
    /** 編集の仕方(#104 第 2 弾)。⚠ test は自分で `new` して渡す。 */
    private readonly editorMode: EditorModeStore = appEditorMode,
    /** 「開く」で編集に入るか(user 裁定 2026-08-18)。⚠ test は自分で `new` して渡す。 */
    private readonly openInEdit: OpenInEditStore = appOpenInEdit,
    /** 素のまま起動の許可(#301)。⚠ test は自分で `new` して渡す。 */
    private readonly sameOriginGrants: SameOriginGrants = new SameOriginGrants(),
    /** 目次を見せる許可(#195 / C-5 段①)。⚠ test は自分で `new` して渡す。 */
    private readonly extensionGrants: ExtensionGrants = new ExtensionGrants(),
    /**
     * 🔴 **貼付で読み取る形**(user 指示 2026-08-25)。
     * ⚠ **末尾に足す** ── 途中に入れると、位置引数で渡している test が
     *   **静かに別の物を受け取る**(1 稿目で実際に 12 件落とした)。
     */
    private readonly pasteSource: PasteSourceStore = appPasteSource,
    /**
     * 🔴 **予定の時刻に知らせるか**(#280)。
     * ⚠ **末尾に足す**(すぐ上の戒めのとおり)── 途中に入れると、位置引数で
     *   渡している test が**静かに別の物を受け取る**。⚠ 1 稿目で実際に
     *   途中へ入れて 2 件落とした(型が違ったので tsc が拾ったが、
     *   **同じ型どうしなら黙って通る**)。
     */
    private readonly alarmEnabled: AlarmEnabledStore = appAlarmEnabled,
    /**
     * 🔴 **狭い画面の断り書きを出すか**(#687 E-1)。帯の OK で切れた user の
     * **唯一の戻し道**である。⚠ **末尾に足す**(すぐ上の戒めのとおり)。
     */
    private readonly tooNarrowOk: TooNarrowOkStore = appTooNarrowOk,
    /**
     * 🔴 **本文の素の電話番号を押せる字にするか**(#278 段②)。
     * ⚠ **末尾に足す**(すぐ上の戒めのとおり)── 1 稿目で `alarmEnabled` の
     *   直後に入れて、位置引数で渡している test を 1 件落とした。
     */
    private readonly phoneLinks: PhoneLinksStore = appPhoneLinks,
    /**
     * 🔴 **聞くときだけ音を整えるか**(#772 段① B)。
     * ⚠ **末尾に足す**(すぐ上の戒めのとおり)── 途中に入れると、位置引数で
     *   渡している test が**静かに別の物を受け取る**。
     */
    private readonly voiceBoost: VoiceBoostStore = appVoiceBoost,
    /**
     * 🔴 **これまでのお知らせ**(#1017 段③-2)。⚠ **注入できるようにする**
     *   (ヘルプの旧 `HelpRenderer.notices` と同じ理由、2026-08-08 の変異試験の
     *   指摘)── `NOTICES` を丸ごと出す変異・上限を守らない変異が誰にも
     *   殺されなくなる。⚠ **末尾に足す**(すぐ上の戒めのとおり)。
     */
    private readonly noticeList: readonly Notice[] = NOTICES,
    /**
     * 🔴 **本文の `@日付` を押せる字にするか**(#1169)。
     * ⚠ **末尾に足す**(すぐ上の戒めのとおり)。
     */
    private readonly dateLinks: DateLinksStore = appDateLinks,
    /**
     * 🔴 **リンク先のノートが無いリンクを点線で見せるか**(#1174 段①)。
     * ⚠ **末尾に足す**(すぐ上の戒めのとおり)。
     */
    private readonly missingLinks: MissingLinksStore = appMissingLinks,
    /**
     * 🔴 **長いコード枠を最初から畳むか**(#1087)。
     * ⚠ **末尾に足す**(すぐ上の戒めのとおり)。
     */
    private readonly codeCollapse: CodeCollapseStore = appCodeCollapse,
    /**
     * 🔴 **文中の短いコードを押すとコピーするか**(#1087)。
     * ⚠ **末尾に足す**(すぐ上の戒めのとおり)。
     */
    private readonly inlineCodeCopy: InlineCodeCopyStore = appInlineCodeCopy,
    /**
     * 🔴 **本文の日付の右に「あとN日」を添えるか**(#1225)。
     * ⚠ **末尾に足す**(すぐ上の戒めのとおり)。
     */
    private readonly relativeDays: RelativeDaysStore = appRelativeDays,
    /**
     * 🔴 **本文の色コードの左に色の見本を出すか**(#1224)。
     * ⚠ **末尾に足す**(すぐ上の戒めのとおり)。
     */
    private readonly colorSwatch: ColorSwatchStore = appColorSwatch,
    /**
     * 🔴 **保存領域を縮める**(#999)。⚠ 画面は**この係が組んだ表示を映すだけ**
     *   (見込みも押せるかも判断しない)。⚠ **末尾に足す**(すぐ上の戒めのとおり)。
     */
    private readonly vacuum: StorageVacuum = appStorageVacuum,
    /**
     * 🔴 **PDF を PKC の画面で開くか**(#275 段①)。
     * ⚠ **末尾に足す**(すぐ上の戒めのとおり)。
     */
    private readonly pdfReader: PdfReaderStore = appPdfReader,
    /**
     * 🔴 **ブラウザの AI に許した範囲**(#1407 段①)。
     * ⚠ **末尾に足す**(すぐ上の戒めのとおり)。test は自分で `new AgentGrants(fake)` を渡す。
     */
    private readonly agentGrants: AgentGrants = appAgentGrants,
    /**
     * 🔴 **このタブで AI のツールが使えるか**(#1407)。⚠ **末尾に足す**(すぐ上の戒めのとおり)。
     */
    private readonly agentTabStatus: AgentTabStatus = appAgentTabStatus,
  ) {
    /**
     * 🔴 **節の登録表(#1382)── 並びが画面の並びである。** 節を足す = `settings/` に 1 file 足し、
     * ここへ 1 行足す。⚠ 組む(`build`)も映す(`sync`)も**この表を回す**ので、`sync` を
     * 呼び忘れる道が無い(`tests/adapter/settings-sections.test.ts` が全数 pin する)。
     * ⚠ 同じ `group` の節は、登録の順に 1 つの入れ物(`dl` など)へ並ぶ ── 入れ物の側は
     *   `render()` が持つ(節ごとの見出しと区画)。
     * ⚠ 映す順は「最初の組み立て」と「以後の `render()`」で同じ(前は 2 通りに書いてあった)。
     *   「本文の日付」は「日付までの日数」より前に置く(後者の `sync` が前者のチェックを読む)。
     */
    this.sections = [
      createMessagesSection(region),
      createThemeSection(region),
      createPageFormatSection(region),
      createProseAlignSection(region),
      createTextScaleSection(region),
      createReadColumnsSection(region),
      createColumnRuleSection(region),
      createTagBadgeSection(region),
      createEditorModeSection(region, editorMode),
      createOpenInEditSection(region, openInEdit),
      createPhoneLinksSection(region, phoneLinks),
      createDateLinksSection(region, dateLinks),
      createRelativeDaysSection(region, relativeDays),
      createColorSwatchSection(region, colorSwatch),
      createMissingLinksSection(region, missingLinks),
      createCodeCollapseSection(region, codeCollapse),
      createInlineCodeCopySection(region, inlineCodeCopy),
      createPdfReaderSection(region, pdfReader),
      createPasteSourceSection(region, pasteSource),
      createAlarmEnabledSection(region, alarmEnabled),
      createVoiceBoostSection(region, voiceBoost),
      createOpenPlaceSection(region),
      createAppOpenTargetSection(region),
      createExternalImagesSection(region, externalImages),
      createSameOriginSection(sameOriginGrants),
      createExtensionsSection(extensionGrants),
      createAgentsSection(agentGrants, agentTabStatus),
      createOpenedHistorySection(),
      createSearchHistorySection(),
      createCopyHistorySection(),
      createTooNarrowSection(region, tooNarrowOk),
      createPersistSection(region),
      createNoticesSection(region, notices),
      createNoticeListSection(noticeList),
    ];
  }

  /** 節の登録表(constructor で 1 度だけ組む)。並びが画面の並び。 */
  private readonly sections: readonly SettingsSection[];

  /** 登録表を読む口(test 用 ── 並びと「全部の `sync` が呼ばれる」を pin する)。 */
  registeredSections(): readonly SettingsSection[] {
    return this.sections;
  }

  /** 登録表のうち `group` の節を、登録の順に組む(1 つの節が複数の根を返してもよい)。 */
  private buildGroup(group: SettingsGroup): Node[] {
    const out: Node[] = [];
    for (const s of this.sections) {
      if (s.group !== group) continue;
      const built = s.build();
      if (Array.isArray(built)) out.push(...built);
      else out.push(built);
    }
    return out;
  }

  /** `dl`(定義の一覧)の中身を、登録表の `group` から組む。 */
  private buildDl(group: SettingsGroup): HTMLElement {
    const dl = document.createElement('dl');
    dl.append(...this.buildGroup(group));
    return dl;
  }

  /** 登録表の全部を映す。⚠ 節ごとの `syncX()` を直に呼ばない(呼び忘れを作らない)。 */
  private syncSections(state: AppState): void {
    for (const s of this.sections) s.sync(state);
  }


  render(state: AppState): void {
    if (this.built) {
      // 🔴 未読・許可・件数などは毎 state で変わりうる ── 登録表の全部を映す。
      this.syncSections(state);
      // 🔴 開いている間に大きさが動きうる ── 測り直す(間隔は係が持つ)
      this.vacuum.refresh();
      return;
    }
    this.built = true;
    this.region.textContent = '';

    const head = document.createElement('div');
    head.setAttribute('data-pkc-field', 'pane-title');
    head.textContent = 'システム';
    this.region.append(head);

    const body = document.createElement('div');
    body.setAttribute('data-pkc-region', 'settings-body');

    /**
     * 🔴 **メッセージ**(設計 doc §7、段②a)── **先頭(目次の直後)に置く**
     * (裁定 2026-09-20「システムのノートは system 領域」)。
     */
    body.append(...this.buildGroup('top'));

    /**
     * 🔴 **「設定」(#1017 段③-1)** ── PKC を型システムとして言い直した結果、
     * system 領域(user 向け)の「好み」という型の入れ物になった
     * (`docs/development/ui-total-design-2026-09.md` §3.2 の裁定)。
     *
     * ⚠ **畳まない**(user 指示「主要な導線を畳まない」)── 見出しで区切るだけにする。
     * ⚠ 中は h4 で 4 つ(表示 / 編集 / 通知 / 開き方)+ 貼り付け・ショートカットキー・
     *   設定の持ち出し に分かれる ── 前は 22 件が「表示」1 つの `dl` に地続きに
     *   並んでいた(実測: 見た目の好みでない項目が 9 件混ざっていた)。
     */
    const configSection = document.createElement('section');
    configSection.setAttribute('data-pkc-region', 'settings-config');
    const configHead = document.createElement('h3');
    configHead.textContent = '設定';
    configSection.append(configHead);

    /**
     * 🔑 **表示**(見た目の好みだけ)── 外へ何が伝わるかの判断は「許可」に置く
     *   (同じ場所に混ぜると、配色を選ぶ気分で押される)。
     */
    const userSection = document.createElement('section');
    userSection.setAttribute('data-pkc-region', 'settings-user');
    const userHead = document.createElement('h4');
    userHead.textContent = '表示';
    userSection.append(userHead);

    /**
     * 🔑 各 h4 の `dl` の中身は、**登録表の `group` から組む**(`settings/` の節が `dt` / `dd` を返す)。
     * 並びは登録の順 = 画面の順。
     */
    const dl = this.buildDl('display');
    /** 🔴 h4「編集」の中身(#1017 段③-1)。 */
    const editDl = this.buildDl('edit');
    /** 🔴 h4「通知」の中身(#1017 段③-1)。 */
    const notifyDl = this.buildDl('notify');
    /** 🔴 h4「開き方」の中身(#1017 段③-1)。 */
    const openDl = this.buildDl('open');
    /** 「保存領域」の h4「PKC3 のデータ」の中身。 */
    const persistDl = this.buildDl('persist');
    /** 「お知らせ」の h3 の中の、お知らせを出すかの設定。 */
    const noticeDl = this.buildDl('notice');
    /** 「記録」の h3 の末尾、狭い画面の断り書き。 */
    const tooNarrowDl = this.buildDl('too-narrow');

    /**
     * 🔴 **版はヘルプへ移した**(P11)。
     *
     * P10 では上下の帯の撤去先としてここに置いたが、設定は「**あなたが選ぶもの**」の
     * 場所であり、版は選べない ── ヘルプ(困ったときに見る場所)の持ち物である。
     * ⚠ **2 か所に出さない**。同じ値を 2 経路で描くと、片方だけ直して食い違う
     *   (CLAUDE.md「同じ値を複数の描画経路へ渡すものは、経路ごとに pin する」)。
     * ⚠ 版の組み立ては `help.ts` の `versionText()` **1 か所**にある。
     */

    userSection.append(dl);
    configSection.append(userSection);

    /**
     * 🔑 **h4「編集」**(2026-09-21、#1017 段③-1)── 編集の仕方 / 開いたときの状態 /
     * 貼り付け(読み取る形)/ 本文の電話番号 / ショートカットキー。
     */
    const editSection = document.createElement('section');
    editSection.setAttribute('data-pkc-region', 'settings-edit');
    const editHead = document.createElement('h4');
    editHead.textContent = '編集';
    editSection.append(editHead, editDl);
    configSection.append(editSection);
    // ⚠ 「貼り付け」は独立した節(#1017 段③-1 以前からの区画名 `settings-paste-source`)。
    //   読み取る形の dt はその中に在る ── 登録表の `paste` から置く。
    configSection.append(...this.buildGroup('paste'));
    /**
     * ⌨ **ショートカットキー**(user 指示 2026-08-18)。⚠ 一覧は `KEY_COMMANDS` から出す
     * (PKC2 はここを手書きにしてズレた)。
     */
    this.keymapPanel?.dispose();
    this.keymapPanel = buildKeymapPanel();
    configSection.append(this.keymapPanel.root);

    /** 🔑 **h4「通知」**(2026-09-21、#1017 段③-1)── 予定の知らせ / 音を聞きやすくする。 */
    const notifySection = document.createElement('section');
    notifySection.setAttribute('data-pkc-region', 'settings-notify');
    const notifyHead = document.createElement('h4');
    notifyHead.textContent = '通知';
    notifySection.append(notifyHead, notifyDl);
    configSection.append(notifySection);

    /** 🔑 **h4「開き方」**(2026-09-21、#1017 段③-1)── 書庫(zip)を開く場所 / アプリの開き方。 */
    const openSection = document.createElement('section');
    openSection.setAttribute('data-pkc-region', 'settings-open-ways');
    const openHead = document.createElement('h4');
    openHead.textContent = '開き方';
    openSection.append(openHead, openDl);
    configSection.append(openSection);

    // 🔑 **h4「設定の持ち出し」**(既に h4 で描かれている ── そのまま置く)。
    configSection.append(buildSettingsFile());
    body.append(configSection);

    /**
     * 🔴 **「許可」**(#1017 段③-1)── この端末で許した事実(system 領域、user 向け)。
     * ⚠ 「取り消す」の入口 3 つを 1 つの h3 の下に揃える(`ui-total-design-2026-09.md` §3.2)。
     */
    const permSection = document.createElement('section');
    permSection.setAttribute('data-pkc-region', 'settings-permissions');
    const permHead = document.createElement('h3');
    permHead.textContent = '許可';
    permSection.append(permHead);
    permSection.append(...this.buildGroup('permissions'));
    body.append(permSection);

    /**
     * 🔴 **「記録」**(#1017 段③-1)── この端末の行動の事実(system 領域、user 向け)。
     */
    const historySection = document.createElement('section');
    historySection.setAttribute('data-pkc-region', 'settings-history');
    const historyHead = document.createElement('h3');
    historyHead.textContent = '記録';
    historySection.append(historyHead);
    historySection.append(...this.buildGroup('history'));
    historySection.append(this.buildTooNarrowSection(tooNarrowDl));
    body.append(historySection);

    /**
     * 🔴 **「保存領域」**(#1017 段③-1)── この端末の入れ物の状態(system 領域、user 向け)。
     * ⚠ 並びは設計 doc §3.2 のとおり:このアプリのデータ / 容量の内訳 /
     *   使っていない添付 / 保存領域の点検 / Office 表示。
     */
    const storageSection = document.createElement('section');
    storageSection.setAttribute('data-pkc-region', 'settings-storage');
    const storageHead = document.createElement('h3');
    storageHead.textContent = STORAGE_SECTION_LABEL;
    storageSection.append(storageHead);
    storageSection.append(this.buildPersistSection(persistDl));
    storageSection.append(buildSettingsCommands());
    /**
     * 🔴 **Office 一式**(#88 / O6-a)── **この端末に 77MB を置くかどうか**という
     * 保存領域の判断。⚠ 器は 1 度だけ組む。状態の変化は panel 自身が購読して字だけ差し替える。
     */
    this.officePack = buildOfficePackPanel();
    storageSection.append(this.officePack.root);
    /**
     * 🔴 **音声認識の部品**(#772 段②)── Office 一式と同じく「この端末に大きな部品を
     * 置くかどうか」という保存領域の判断なので、**その隣**に置く。
     */
    this.asrPack = buildAsrPackPanel();
    storageSection.append(this.asrPack.root);
    body.append(storageSection);

    /**
     * 🔴 **「お知らせ」**(#1017 段③-1)── 開発側からの配信の一覧の入口。
     * ⚠ ヘルプにも 1 行のリンクを残す(裁定 2026-09-20「困っている人の動線」)。
     */
    const noticeSection = document.createElement('section');
    noticeSection.setAttribute('data-pkc-region', 'settings-notices-section');
    const noticeHead = document.createElement('h3');
    noticeHead.textContent = 'お知らせ';
    noticeSection.append(noticeHead);
    noticeSection.append(this.buildNoticeSection(noticeDl));
    body.append(noticeSection);

    /**
     * 🔴 **先頭に目次を置く**(#1017 段⓪。user 裁定 2026-09-20「当面の実装は、
     * システムの中に目次を付けて節の間を移動しやすくするところまで」)。
     * ⚠ **組み終わった `body` から `h3` を走査して作る**(手で列挙しない)──
     *   節を足し忘れても目次から抜け落ちない(CLAUDE.md §7)。
     */
    this.region.append(this.buildToc(body));
    this.region.append(body);
    this.syncSections(state);
    // 🔴 保存領域を縮める(#999)── 係の表示が変わるたびに映す(購読は 1 組しか生きない)
    this.vacuum.subscribe(() => this.syncVacuum());
    this.syncVacuum();
    this.vacuum.refresh();
  }

  /**
   * 🔴 **保存領域を縮める**の表示を映す(#999)。⚠ 判断は `StorageVacuum` が持つ ──
   * ここは**字と押せるかを置くだけ**(2 か所で判断すると、片方だけ直した日に食い違う)。
   */
  private syncVacuum(): void {
    const note = this.region.querySelector<HTMLElement>('[data-pkc-field="vacuum-note"]');
    const btn = this.region.querySelector<HTMLButtonElement>('[data-pkc-field="vacuum-run"]');
    if (note === null || btn === null) return;
    const v = this.vacuum.view();
    if (note.textContent !== v.text) note.textContent = v.text;
    if (btn.disabled !== !v.canRun) btn.disabled = !v.canRun;
    btn.setAttribute('aria-busy', v.busy ? 'true' : 'false');
  }

  /**
   * 🔴 **先頭に置く目次**(#1017 段⓪)。
   *
   * ⚠ **手で節を列挙しない** ── 節を足し忘れると目次から抜け落ちる
   *   (CLAUDE.md §7「同じ値・同じ判定が複数の場所にある」)。組み終わった
   *   `body` から `h3` を走査して作る ── 節が増減しても目次は追随する。
   * ⚠ **畳まない**(`<details>` は使わない)── user 指示「主要な導線は畳まない」
   *   (`tests/docs-parity.test.ts` が全数走査で落とす)。
   * ⚠ **`<a href="#…">` は使わない** ── hash はディープリンク
   *   (`platform/deep-link.ts`)が読むので、押すたびに URL の hash を壊す。
   *   飛び先は `data-pkc-action="system-jump"` + `data-pkc-target="<id>"` で渡す
   *   (`binder.ts` の受け手が `scrollIntoView` する)。`top` は実在する id ではなく
   *   「目次へ戻る」の合図(見出しの id と衝突させない)。
   * ⚠ **「上へ」は `h3` の子にしない** ── `h.textContent` を読む所が他にもある
   *   (`tests/docs-parity.test.ts` の §697 突合)。子にすると「表示上へ」のように
   *   混ざって読める(CLAUDE.md「器を替えても読み取れる値は同じ形か」)。
   *   代わりに `h3` を**囲む器**を差し込み、「上へ」は**その兄弟**にする。
   */
  private buildToc(body: HTMLElement): HTMLElement {
    const nav = document.createElement('nav');
    nav.setAttribute('data-pkc-region', 'settings-toc');
    const row = document.createElement('div');
    row.setAttribute('data-pkc-field', 'settings-toc-row');
    nav.append(row);
    const heads = Array.from(body.querySelectorAll<HTMLHeadingElement>('h3'));
    heads.forEach((h, i) => {
      const id = `settings-h3-${i}`;
      // ⚠ 機能の選択子は `data-pkc-*`(規約)── `id` は使わない
      h.setAttribute('data-pkc-section', id);
      const label = h.textContent ?? '';

      const link = document.createElement('button');
      link.type = 'button';
      link.setAttribute('data-pkc-action', 'system-jump');
      link.setAttribute('data-pkc-target', id);
      link.textContent = label;
      row.append(link);

      /**
       * ⚠ **段②b で「jobs には上へを置かない」分岐を消した** ── その計器の区画
       *   (`buildJobs()`)自体をこの画面から削除したため、分岐の的が無くなった
       *   (死んだ分岐を残さない。CLAUDE.md §7)。いまは全節が同じ扱いで
       *   「上へ」を持つ。
       */
      const back = document.createElement('button');
      back.type = 'button';
      back.setAttribute('data-pkc-action', 'system-jump');
      back.setAttribute('data-pkc-target', 'top');
      back.setAttribute('data-pkc-field', 'settings-back-to-top');
      back.textContent = '目次へ戻る';
      const wrap = document.createElement('div');
      wrap.setAttribute('data-pkc-field', 'settings-heading-row');
      h.replaceWith(wrap);
      wrap.append(h, back);
    });
    return nav;
  }

  /**
   * 🔴 **狭い画面の断り書き**(#1017 段③-1。「表示」から移した dl をそのまま使う)。
   * ⚠ **判断は 1 つも増やさない** ── 中身(dt/dd)は `render()` が組んだものを渡すだけ。
   */
  private buildTooNarrowSection(dl: HTMLElement): HTMLElement {
    const wrap = document.createElement('section');
    wrap.setAttribute('data-pkc-region', 'settings-too-narrow');
    const h = document.createElement('h4');
    h.textContent = '狭い画面の断り書き';
    wrap.append(h, dl);
    return wrap;
  }

  /**
   * 🔴 **このアプリのデータ**(#1017 段③-1。「表示」から「保存領域」へ移した)。
   * ⚠ **判断は 1 つも増やさない** ── 中身(dt/dd)は登録表の `persist` が組んだものを渡すだけ。
   */
  private buildPersistSection(dl: HTMLElement): HTMLElement {
    const wrap = document.createElement('section');
    wrap.setAttribute('data-pkc-region', 'settings-persist');
    const h = document.createElement('h4');
    h.textContent = 'PKC3 のデータ';
    wrap.append(h, dl);
    return wrap;
  }

  /**
   * 🔴 **お知らせ**(#1017 段③-1。「表示」から「お知らせ」の h3 へ移した)。
   * ⚠ **判断は 1 つも増やさない** ── 中身(dt/dd)は登録表の `notice` が、
   *   「これまでのお知らせ」は `notice-list` が組んだものを渡すだけ。
   */
  private buildNoticeSection(dl: HTMLElement): HTMLElement {
    const wrap = document.createElement('section');
    wrap.setAttribute('data-pkc-region', 'settings-notices');
    const h = document.createElement('h4');
    h.textContent = 'お知らせ';
    wrap.append(h, dl);
    wrap.append(...this.buildGroup('notice-list'));
    return wrap;
  }
}
