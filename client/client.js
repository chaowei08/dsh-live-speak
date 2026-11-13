/**
 * dsh-live-speak — 浏览器侧：播放队列 + 顶栏内联播放条 + 侧栏导航行。
 *
 * 与 dsh-big-fish-speak 的本质区别：音频在**这一端**播放。
 *   宿主只负责合成，把每段 mp3 挂在 /plugins/dsh-live-speak/audio/<id> 上；
 *   这里的 Audio 对象负责出声，所以暂停 / 恢复 / 停止 / 跳过都是真的即时生效。
 *
 * 挂载（两份播放条按 settings.dock 互斥，同一时刻只有一份）：
 *   - settings.section                     → 设置分区
 *   - conversation.session.header.actions  → 顶栏形态 HeaderCluster（dock=top）
 *   - sidebar.panellist                    → 侧栏形态 SidebarRow（dock=sidebar，order 100）
 *
 * 兼容：factory 整体 try/catch；require 缺模块就静默退出，不影响 DSH 主界面。
 */
(function () {
  try {
    if (typeof window === "undefined" || !window.__ModuleLoader__) return;

    window.__ModuleLoader__.load({
      id: "dsh-live-speak",
      factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

        var react;
        try {
          react = require("react");
        } catch {
          return module.exports;
        }
        var h = react.createElement;

        var API = "/plugins/dsh-live-speak";
        var AUDIO_PREFIX = API + "/audio/";
        // 提示音响完到这个开口之间的空档：0.35 秒两声，留半拍让人反应过来是"要说话了"
        var CHIME_GAP_MS = 520;
        // 侧栏导航行与主面板共用的 ID（宿主靠它把两者对上）
        var LIVE_PANEL_ID = "dsh-live-speak";

        // ── 多语言：跟随 DSH「通用设置 → 语言」 ──────────────────────────
        // 宿主把当前语言放在 ctx.locale 快照里（getSnapshot().active + subscribe），
        // 值是 BCP47 形式（zh-CN / en-US / ja-JP / es-ES …）。这里只按前缀分流，
        // 除中文、日文外统一落到英文，避免出现「一半中文一半外文」。
        var UI_LANG = "zh";
        var TEXT = {
          zh: {
            "section.title": "Edge 语音播报",
            "row.label": "语音播报",
            "phase.loading": "准备中",
            "phase.playing": "正在播报",
            "phase.paused": "已暂停",
            "phase.blocked": "等待播放",
            "phase.generating": "生成中",
            "phase.idle": "等待播报",
            "phase.done": "播报完成",
            "short.loading": "准备中",
            "short.playing": "正在播报",
            "short.paused": "已暂停",
            "short.blocked": "等点击",
            "short.generating": "生成中",
            "short.idle": "待播",
            "short.done": "播报完成",
            "empty.none": "没有待播内容",
            "empty.streaming": "正在生成下一句…",
            "empty.synth": "正在合成下一段…",
            "act.pause": "暂停",
            "act.play": "播放 / 继续",
            "act.stop": "停止（清空队列）",
            "act.stopShort": "停止",
            "act.skip": "跳过这一段",
            "act.preview": "试听当前声线",
            "act.mute": "静音（当前会静默播完）",
            "act.unmute": "取消静音",
            "act.expand": "展开",
            "act.collapse": "收起",
            "act.stopAndClose": "停止并收起",
            "hint.clickToStart": "点播放键开始",
            "hint.queue": "还有 {n} 段",
            "hint.queueFull": "还有 {n} 段待播",
            "hint.live": "边生成边播",
            "hint.livePause": "边生成边播，可随时暂停",
            "hint.paused": "点播放继续",
            "hint.idle": "暂停 / 停止随时可用",
            "settings.group.behavior": "播报行为",
            "settings.auto": "自动播报",
            "settings.auto.hint": "模型回复时自动念，不用手动触发",
            "settings.realtime": "实时播报",
            "settings.realtime.hint": "模型流式输出时边写边念，不等整段写完；非流式模型则在整段到达后立刻开念",
            "settings.interrupt": "新回复打断旧内容",
            "settings.interrupt.hint": "关掉则把旧的念完再念新的",
            "settings.codeQuiet": "写代码时只念开头和结果",
            "settings.codeQuiet.hint": "回复里一出现代码（或模型开始写文件）就停止逐字念，写完只念末尾的结果说明。代价：写代码过程中是静音的，可能连着几分钟没有声音；关掉则恢复逐字念、落地只补尾巴。",
            "settings.dockExpanded": "侧栏播放条默认展开",
            "settings.dockExpanded.hint": "只在「左侧导航栏」形态有用：打开就是展开的卡片，不用每次点行尾箭头。手动点过箭头之后以手动为准；选了顶栏形态则无效果。",
            "settings.group.position": "播放条位置（二选一）",
            "settings.dock.top": "顶栏",
            "settings.dock.top.hint": "一行横条",
            "settings.dock.sidebar": "左侧导航栏",
            "settings.dock.sidebar.hint": "窄条贴底",
            "settings.group.voice": "声音",
            "settings.group.engine": "播报引擎",
            "settings.engine.online": "线上语音",
            "settings.engine.online.hint": "微软神经声线，最自然；只走线上，不会换成本机声线",
            "settings.engine.local": "本地语音",
            "settings.engine.local.hint": "用系统自带声线，不联网、零安装，起播最快",
            "settings.voice": "声线",
            "settings.voice.hint": "纯英文声线念中文会自动退回晓晓；想听洋腔中文选带「能念中文」的那两条",
            "settings.voice.localHint": "本机装了几条就列几条，装了新语音包点右边重新检测",
            "settings.voice.localNone": "未检测到可用声线",
            "settings.voice.refresh": "重新检测",
            "settings.rate": "语速",
            "settings.rate.hint": "正数更快，负数更慢，范围 -50% ~ +100%",
            "settings.chunk": "段落字数",
            "settings.chunk.hint": "越大越连贯，越小越早出声；本地引擎合成快，长文章可设 200~300",
            "settings.chunk.unit": "字",
            "settings.volume": "播放音量",
            "settings.volume.hint": "页面侧实际出声的音量",
            "settings.preview": "试听",
            "settings.preview.hint": "用当前声线念一句，确认效果",
            "settings.preview.btn": "试听",
            "settings.group.eq": "均衡器",
            "settings.eq.flat": "默认",
            "settings.eq.clarity": "人声清晰",
            "settings.eq.soft": "温柔",
            "settings.eq.deep": "浑厚",
            "settings.eq.custom": "自定义",
            "settings.eq.reset": "重置",
            "settings.eq.hint": "拖动滑块立刻生效；只改声音的明暗厚薄，改不了机械语调。",
            "panel.foot": "声线、语速、音量、播放条位置都能在「设置 → Edge 语音播报」里改。",
            "voice.default": "晓晓",
            "preview.default": "你好，我是晓晓。这是试听。"
          },
          en: {
            "section.title": "Edge Speech",
            "row.label": "Speech",
            "phase.loading": "Preparing",
            "phase.playing": "Speaking",
            "phase.paused": "Paused",
            "phase.blocked": "Ready to play",
            "phase.generating": "Generating",
            "phase.idle": "Waiting",
            "phase.done": "Finished",
            "short.loading": "Preparing",
            "short.playing": "Speaking",
            "short.paused": "Paused",
            "short.blocked": "Click to play",
            "short.generating": "Generating",
            "short.idle": "Waiting",
            "short.done": "Finished",
            "empty.none": "Nothing queued",
            "empty.streaming": "Generating the next line…",
            "empty.synth": "Voicing the next part…",
            "act.pause": "Pause",
            "act.play": "Play / Resume",
            "act.stop": "Stop (clear queue)",
            "act.stopShort": "Stop",
            "act.skip": "Skip this segment",
            "act.preview": "Preview this voice",
            "act.mute": "Mute (keeps playing silently)",
            "act.unmute": "Unmute",
            "act.expand": "Expand",
            "act.collapse": "Collapse",
            "act.stopAndClose": "Stop and collapse",
            "hint.clickToStart": "Press play to start",
            "hint.queue": "{n} more",
            "hint.queueFull": "{n} more to speak",
            "hint.live": "Speaking as it types",
            "hint.livePause": "Speaking as it types, pause anytime",
            "hint.paused": "Press play to resume",
            "hint.idle": "Pause and stop anytime",
            "settings.group.behavior": "Behavior",
            "settings.auto": "Auto speak",
            "settings.auto.hint": "Read replies aloud without pressing anything",
            "settings.realtime": "Live speaking",
            "settings.realtime.hint": "Speaks while the model is still writing when it streams; otherwise starts the moment the full reply arrives",
            "settings.interrupt": "Interrupt on new reply",
            "settings.interrupt.hint": "Turn off to finish the old reply before the new one",
            "settings.codeQuiet": "Quiet while writing code",
            "settings.codeQuiet.hint": "Stops reading the moment code (or file writing) appears, then reads only the closing summary when the reply finishes. Trade-off: several minutes of silence while the code is being written; turn off to go back to live speaking.",
            "settings.dockExpanded": "Expand the sidebar player by default",
            "settings.dockExpanded.hint": "Only applies to the sidebar row: the card starts expanded instead of waiting for you to click the arrow. Once you toggle the arrow yourself, your choice wins. No effect in header-bar mode.",
            "settings.group.position": "Player position (pick one, two options)",
            "settings.dock.top": "Header bar",
            "settings.dock.top.hint": "One compact row",
            "settings.dock.sidebar": "Sidebar row",
            "settings.dock.sidebar.hint": "A row in the left navigation",
            "settings.group.voice": "Voice",
            "settings.group.engine": "Speech engine",
            "settings.engine.online": "Online",
            "settings.engine.online.hint": "Microsoft neural voices, the most natural; online only, never switches to a system voice",
            "settings.engine.local": "On this computer",
            "settings.engine.local.hint": "Uses the system voices: no network, nothing to install, starts fastest",
            "settings.voice": "Voice",
            "settings.voice.hint": "English-only voices fall back to Xiaoxiao for Chinese; pick a Multilingual voice for Chinese with an accent",
            "settings.voice.localHint": "Every voice installed here is listed; click refresh after installing a new one",
            "settings.voice.localNone": "No usable voice found",
            "settings.voice.refresh": "Refresh",
            "settings.rate": "Rate",
            "settings.rate.hint": "Positive is faster, negative is slower, from -50% to +100%",
            "settings.chunk": "Paragraph size",
            "settings.chunk.hint": "Larger is smoother, smaller starts earlier; with the local engine 200–300 is fine for long text",
            "settings.chunk.unit": "chars",
            "settings.volume": "Playback volume",
            "settings.volume.hint": "Volume of the audio played in this page",
            "settings.preview": "Preview",
            "settings.preview.hint": "Hear the current voice with one sentence",
            "settings.preview.btn": "Play",
            "settings.group.eq": "Equalizer",
            "settings.eq.flat": "Flat",
            "settings.eq.clarity": "Clarity",
            "settings.eq.soft": "Soft",
            "settings.eq.deep": "Deep",
            "settings.eq.custom": "Custom",
            "settings.eq.reset": "Reset",
            "settings.eq.hint": "Moves take effect instantly. Brightness and body only — robotic cadence stays.",
            "panel.foot": "Voice, rate, volume and bar position are under Settings → Edge Speech.",
            "voice.default": "Xiaoxiao",
            "preview.default": "Hi, this is a preview of the current voice."
          },
          ja: {
            "section.title": "Edge 音声読み上げ",
            "row.label": "読み上げ",
            "phase.loading": "準備中",
            "phase.playing": "読み上げ中",
            "phase.paused": "一時停止",
            "phase.blocked": "再生待ち",
            "phase.generating": "生成中",
            "phase.idle": "待機中",
            "phase.done": "読み上げ完了",
            "short.loading": "準備中",
            "short.playing": "読み上げ中",
            "short.paused": "一時停止",
            "short.blocked": "クリックで再生",
            "short.generating": "生成中",
            "short.idle": "待機中",
            "short.done": "完了",
            "empty.none": "再生待ちはありません",
            "empty.streaming": "次の文を生成中…",
            "empty.synth": "次の部分を音声化中…",
            "act.pause": "一時停止",
            "act.play": "再生 / 再開",
            "act.stop": "停止（キューを消去）",
            "act.stopShort": "停止",
            "act.skip": "この段落をスキップ",
            "act.preview": "この声を試聴",
            "act.mute": "ミュート（無音で最後まで再生）",
            "act.unmute": "ミュート解除",
            "act.expand": "展開",
            "act.collapse": "折りたたむ",
            "act.stopAndClose": "停止して閉じる",
            "hint.clickToStart": "再生ボタンで開始",
            "hint.queue": "残り {n} 段",
            "hint.queueFull": "残り {n} 段",
            "hint.live": "生成しながら読み上げ",
            "hint.livePause": "生成しながら読み上げ、いつでも一時停止できます",
            "hint.paused": "再生で再開",
            "hint.idle": "いつでも一時停止・停止できます",
            "settings.group.behavior": "読み上げ動作",
            "settings.auto": "自動読み上げ",
            "settings.auto.hint": "返信を自動で読み上げます",
            "settings.realtime": "リアルタイム読み上げ",
            "settings.realtime.hint": "モデルがストリーミング出力のときは書きながら読み上げ、そうでなければ全文が届いた直後に始まります",
            "settings.interrupt": "新しい返信で中断",
            "settings.interrupt.hint": "オフにすると古い返信を最後まで読み上げてから新しい返信を読みます",
            "settings.codeQuiet": "コード生成中は静かに",
            "settings.codeQuiet.hint": "コード（またはファイル書き込み）が現れた時点で読み上げを止め、完了後に末尾の結果説明だけを読みます。代わりに、コード生成中は数分間無音になります。オフにすると従来どおり逐次読み上げに戻ります。",
            "settings.dockExpanded": "サイドバーのプレイヤーを常に展開",
            "settings.dockExpanded.hint": "「左のナビゲーション」形態のみ有効：最初からカードが展開された状態になります。矢印を自分で操作した後はその操作が優先されます。ヘッダーバー形態では効果ありません。",
            "settings.group.position": "プレイヤーの位置（2つから選択）",
            "settings.dock.top": "ヘッダーバー",
            "settings.dock.top.hint": "1 行のコンパクトバー",
            "settings.dock.sidebar": "左のナビゲーション",
            "settings.dock.sidebar.hint": "左側のナビゲーションの 1 行",
            "settings.group.voice": "声",
            "settings.group.engine": "読み上げエンジン",
            "settings.engine.online": "オンライン",
            "settings.engine.online.hint": "Microsoft のニューラル音声で最も自然。オンライン専用で、この PC の音声には切り替わりません",
            "settings.engine.local": "この PC で読み上げ",
            "settings.engine.local.hint": "システム内蔵の音声を使用。ネット不要・追加インストール不要で、最も早く鳴ります",
            "settings.voice": "声",
            "settings.voice.hint": "英語専用の声で中国語を読むと Xiaoxiao に戻ります。中国語を読みたい場合は Multilingual の声を選んでください",
            "settings.voice.localHint": "この PC にある音声をすべて表示します。新しい音声を入れたら右の再検出を押してください",
            "settings.voice.localNone": "使用できる音声が見つかりません",
            "settings.voice.refresh": "再検出",
            "settings.rate": "速度",
            "settings.rate.hint": "正の値で速く、負の値で遅く、範囲は -50% 〜 +100%",
            "settings.chunk": "段落の文字数",
            "settings.chunk.hint": "大きいほど滑らか、小さいほど早く話し始める。ローカルエンジンなら長文でも 200〜300 が快適",
            "settings.chunk.unit": "字",
            "settings.volume": "再生音量",
            "settings.volume.hint": "このページで実際に鳴る音量",
            "settings.preview": "試聴",
            "settings.preview.hint": "現在の声で一文を読み上げて確認",
            "settings.preview.btn": "試聴",
            "settings.group.eq": "イコライザー",
            "settings.eq.flat": "フラット",
            "settings.eq.clarity": "クリア",
            "settings.eq.soft": "ソフト",
            "settings.eq.deep": "低音",
            "settings.eq.custom": "カスタム",
            "settings.eq.reset": "リセット",
            "settings.eq.hint": "スライダーは即時反映。明暗と厚みのみ調整、機械的な抑揚は変わりません。",
            "panel.foot": "声・速度・音量・表示位置は「設定 → Edge 音声読み上げ」で変更できます。",
            "voice.default": "Xiaoxiao",
            "preview.default": "こんにちは。これは現在の声の試聴です。"
          }
        };

        /** 把 BCP47 语言 id 归到本插件支持的三档；空值表示读不到。 */
        function langOf(raw) {
          var id = String(raw || "").toLowerCase();
          if (id === "") return "";
          if (id.indexOf("zh") === 0) return "zh";
          if (id.indexOf("ja") === 0) return "ja";
          return "en";
        }

        /** 取一条 UI 文案；缺 key 时回落中文，再缺就原样返回 key。 */
        function t(key, vars) {
          var table = TEXT[UI_LANG] || TEXT.zh;
          var text = table[key];
          if (text === undefined) text = TEXT.zh[key];
          if (text === undefined) return key;
          if (vars) {
            for (var name in vars) {
              if (Object.prototype.hasOwnProperty.call(vars, name)) {
                text = text.split("{" + name + "}").join(String(vars[name]));
              }
            }
          }
          return text;
        }

        /** 从宿主 locale 快照读当前语言（宿主没给就沿用上次读到的）。 */
        function readLang(ctx) {
          try {
            var snap = typeof ctx.locale.getSnapshot === "function" ? ctx.locale.getSnapshot() : null;
            var active = snap === null || snap === undefined ? null : snap.active;
            if (active !== null && typeof active === "object") active = active.id;
            return langOf(active);
          } catch {
            return "";
          }
        }

        /**
         * 声线显示名。宿主下发的 settings.voiceName 是中文标签，
         * 非中文界面改用插件自带的英文名：拿 settings.voice 去声线表里查。
         */
        function voiceNameOf(state) {
          var s = (state && state.settings) || {};
          // 本地档：真正发声的是系统里的那条声线，宿主已经把它下成
          // voiceName（Huihui Desktop 这种原名）和 voiceLabel（「Huihui·本机」）。
          // 这一支必须放在查表之前，否则会拿 Edge 的 id 查出「晓晓」，
          // 卡片上写着晓晓、耳朵里却是本机声线。
          if (s.ttsEngine === "local") {
            if (UI_LANG === "zh" && s.voiceLabel) return s.voiceLabel;
            var localRaw = String(s.voiceName || s.localVoice || "")
              .replace(/^Microsoft\s+/i, "")
              .replace(/\s+Desktop$/i, "");
            if (localRaw) return localRaw;
          }
          var id = s.voice || "";
          var list = (manager && manager.voices) || (state && state.voices) || [];
          for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].id === id) {
              return (UI_LANG === "zh" || !list[i].labelEn) ? list[i].label : list[i].labelEn;
            }
          }
          var raw = s.voiceName || "";
          return raw || t("voice.default");
        }

        /**
         * 声线简名：卡片标题只有 258px，状态 + 全名放不下，取「·」前的名字部分
         * （中文是「晓晓」，英文是「HsiaoChen」），完整名放在悬停提示和设置页下拉里。
         */
        function voiceShortOf(state) {
          var full = voiceNameOf(state);
          var cut = String(full === null || full === undefined ? "" : full).split("·")[0];
          return (cut && cut.trim()) || full;
        }

        // ── 样式 ────────────────────────────────────────────────────────
        var css = [
          // 顶部栏开关
          ".dshLiveSpeakBtn{flex:none;width:28px;height:28px;cursor:pointer;background:0 0;border:none;border-radius:999px;justify-content:center;align-items:center;padding:0;display:inline-flex;color:var(--dsw-alias-label-secondary,#8e8e93);transition:color .15s,background .15s}",
          ".dshLiveSpeakBtn:hover:not(:disabled){background:rgba(127,127,127,.14)}",
          ".dshLiveSpeakBtn[data-auto=\"on\"]{color:#007aff}",
          ".dshLiveSpeakBtn svg{width:18px;height:18px;display:block}",
          ".dshLiveSpeakBtn .dshLiveWave{transform-origin:center;opacity:.55}",
          ".dshLiveSpeakBtn[data-playing=\"true\"] .dshLiveWave{animation:dshLiveWave 1.05s ease-in-out infinite}",
          ".dshLiveSpeakBtn[data-playing=\"true\"] .dshLiveWave2{animation-delay:.24s}",
          "@keyframes dshLiveWave{0%,100%{opacity:.35;transform:scaleY(.6)}50%{opacity:1;transform:scaleY(1)}}",

          // 悬浮播放条
          ".dshLiveDock{position:fixed;right:20px;bottom:88px;z-index:2147483000;width:328px;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:12px 14px 11px;border-radius:16px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#1c1c1f) 92%,transparent);color:var(--dsw-alias-label-primary,#fff);font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:1.4;box-shadow:0 12px 32px rgba(0,0,0,.28),inset 0 0 0 1px var(--dsw-alias-border-l2,rgba(255,255,255,.12));backdrop-filter:blur(22px) saturate(1.4);-webkit-backdrop-filter:blur(22px) saturate(1.4);pointer-events:auto;animation:dshLiveDockIn .22s cubic-bezier(.2,.9,.3,1.1)}",
          "@keyframes dshLiveDockIn{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}",
          // 形态互换时用一点极短的淡入，切换看起来是"立刻出现"而不是等一帧
          "@keyframes dshLiveSwapIn{from{opacity:0}to{opacity:1}}",
          // 停靠位置：顶栏（横条）/ 左侧导航栏（窄条）
          // 顶栏横条：宿主在会话标题栏的 actions 槽里给它位置，按行内流式铺开
          // 顶栏横条（旧 Dock 版式，保留给可能的复用）
          ".dshLiveDock[data-dock=\"top\"]{position:static;left:auto;right:auto;top:auto;bottom:auto;width:auto;max-width:min(520px,calc(100vw - 48px));flex-direction:row;align-items:center;gap:12px;padding:5px 10px;border-radius:12px;white-space:nowrap;animation:dshLiveSwapIn .14s ease-out}",
          ".dshLiveDock[data-dock=\"top\"] .dshLiveDockRow{flex:0 0 auto;min-width:0;max-width:300px;gap:8px}",
          ".dshLiveDock[data-dock=\"top\"] .dshLiveDockLabel{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}",
          ".dshLiveDock[data-dock=\"top\"] .dshLiveDockText,.dshLiveDock[data-dock=\"top\"] .dshLiveBar,.dshLiveDock[data-dock=\"top\"] .dshLiveHint{display:none}",
          ".dshLiveDock[data-dock=\"top\"] .dshLiveActions{flex:0 0 auto;gap:8px}",
          ".dshLiveDock[data-dock=\"top\"] .dshLivePlay,.dshLiveDock[data-dock=\"top\"] .dshLiveGhost{width:22px;height:22px;flex:none}",
          ".dshLiveDock[data-dock=\"top\"] .dshLiveDockClose{flex:none}",
          // 左侧栏形态：位置由运行时测量「更多」菜单项决定（见 Dock 里的 hook），
          // 这里只留兜底，避免测量失败时跑到屏幕中间。
          ".dshLiveDock[data-dock=\"sidebar\"]{right:auto;left:12px;bottom:14px;width:248px}",
          ".dshLiveDock[data-dock=\"sidebar\"] .dshLiveDockLabel{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
          ".dshLiveDockRow{display:flex;align-items:center;gap:10px}",
          ".dshLiveDockDot{flex:none;width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-button-info-fill,#007aff)}",
          // 图标槽：和宿主 panelRow 里的 panelGlyph 同宽 16px，行内图标与文字才能对齐到菜单列
          ".dshLiveGlyphIcon{display:inline-flex;align-items:center;justify-content:center;transition:opacity .2s ease}",
          // 注意：图标里的柱子类名必须是 dshLiveGlyphBar，绝不能复用 dshLiveBar ——
          // 后者是播放进度条样式（height:3px），会把 SVG 柱子的高度压成 3px，12 物理像素下就成了“四个点”
          "@keyframes dshLiveGlyphBar{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.45)}}",
          "@keyframes dshLiveGlyphBreath{0%,100%{transform:scale(1)}50%{transform:scale(1.07)}}",
          ".dshLiveGlyphIcon[data-phase=\"playing\"]{animation:dshLiveGlyphBreath 1.5s ease-in-out infinite}",
          ".dshLiveGlyphIcon[data-phase=\"playing\"] .dshLiveGlyphBar{transform-origin:50% 100%;animation:dshLiveGlyphBar .85s ease-in-out infinite}",
          ".dshLiveGlyphIcon[data-phase=\"playing\"] .dshLiveGlyphBar:nth-of-type(2){animation-duration:.65s;animation-delay:.1s}",
          ".dshLiveGlyphIcon[data-phase=\"playing\"] .dshLiveGlyphBar:nth-of-type(3){animation-duration:.95s;animation-delay:.2s}",
          ".dshLiveGlyphIcon[data-phase=\"playing\"] .dshLiveGlyphBar:nth-of-type(4){animation-duration:.75s;animation-delay:.3s}",
          ".dshLiveGlyph{flex:none;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center}",
          ".dshLiveDockDot[data-phase=\"paused\"]{background:var(--dsw-static-amber-500,#f59e0b)}",
          ".dshLiveDockDot[data-phase=\"blocked\"]{background:var(--dsw-alias-state-error-primary,#ff453a)}",
          ".dshLiveDockDot[data-phase=\"idle\"]{background:var(--dsw-alias-label-tertiary,#8e8e93)}",
          ".dshLiveDockDot[data-phase=\"playing\"]{animation:dshLivePulse 1.4s ease-in-out infinite}",
          "@keyframes dshLivePulse{0%,100%{opacity:.35}50%{opacity:1}}",
          ".dshLiveDockLabel{flex:1;min-width:0;font-size:11px;letter-spacing:.3px;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.62));text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
          ".dshLiveDockCount{flex:none;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.52))}",
          ".dshLiveDockClose{flex:none;width:20px;height:20px;padding:0;border:none;border-radius:999px;background:0 0;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.5));cursor:pointer;display:inline-flex;align-items:center;justify-content:center}",
          ".dshLiveDockClose:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.12));color:var(--dsw-alias-label-primary,#fff)}",
          ".dshLiveDockText{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:13px;line-height:1.45;color:var(--dsw-alias-label-primary,rgba(255,255,255,.94));min-height:18px}",
          ".dshLiveBar{position:relative;height:3px;border-radius:999px;background:var(--dsw-alias-border-l2,rgba(255,255,255,.16));overflow:hidden}",
          ".dshLiveBarFill{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:linear-gradient(90deg,#a6d1ff 0%,#007aff 100%);background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-button-info-fill,#007aff) 34%,#ffffff) 0%,var(--dsw-alias-button-info-fill,#007aff) 100%);transition:width .18s linear}",
          ".dshLiveActions{display:flex;align-items:center;gap:8px}",
          ".dshLivePlay{flex:none;width:34px;height:34px;padding:0;border:none;border-radius:999px;background:0 0;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;box-shadow:none}",
          ".dshLivePlay:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));filter:none}",
          // 有内容可播时不再常驻一块蓝底，改成图标本身变蓝（三处同一套规则）
          ".dshLivePlay[data-primary=\"true\"]{color:var(--dsw-alias-button-info-fill,#007aff)}",
          ".dshLiveGhost{flex:none;width:30px;height:30px;padding:0;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.18));border-radius:999px;background:0 0;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.82));cursor:pointer;display:inline-flex;align-items:center;justify-content:center}",
          ".dshLiveGhost:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1));color:var(--dsw-alias-label-primary,#fff)}",
          ".dshLiveHint{flex:1;min-width:0;text-align:right;font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.5));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
          ".dshLiveSpeak{flex:none;width:26px;height:26px;padding:0;border:none;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1));color:var(--dsw-alias-label-primary,#fff);cursor:pointer;display:inline-flex;align-items:center;justify-content:center}",
          ".dshLiveSpeak:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.2))}",
          ".dshLiveDock svg{display:block}",

          // ── 内联模式：嵌进会话标题栏那一行，不再 fixed 浮在上面 ──
          ".dshLiveHeaderCluster{display:inline-flex;align-items:center;gap:8px;min-width:0}",
          ".dshLiveDock[data-inline=\"true\"]{position:static;display:inline-flex;flex-direction:row;align-items:center;gap:8px;padding:0;margin-left:12px;border-radius:0;background:0 0;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none;animation:none;width:auto;overflow:hidden}",
          ".dshLiveDock[data-inline=\"true\"] .dshLiveDockRow{gap:6px}",
          ".dshLiveDock[data-inline=\"true\"] .dshLiveDockText{display:none}",
          ".dshLiveDock[data-inline=\"true\"] .dshLiveBar{display:none}",
          ".dshLiveDock[data-inline=\"true\"] .dshLiveHint{display:none}",
          ".dshLiveDock[data-inline=\"true\"] .dshLiveDockLabel{flex:none;width:auto;max-width:104px;text-transform:none;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
          ".dshLiveDock[data-inline=\"true\"] .dshLiveDockCount{flex:none;width:auto;min-width:20px;text-align:left}",
          ".dshLiveDock[data-inline=\"true\"] .dshLiveActions{gap:6px}",
          ".dshLiveDock[data-inline=\"true\"] .dshLivePlay{width:16px;height:16px;border-radius:4px;box-shadow:none}",
          ".dshLiveDock[data-inline=\"true\"] .dshLiveGhost{width:16px;height:16px;border-radius:4px;border:none}",
          ".dshLiveDock[data-inline=\"true\"] .dshLiveSpeak{width:16px;height:16px;border-radius:4px;background:0 0}",
          // 上一条把 inline 里的喇叭键背景归零，特异性高于 .dshLiveSpeak:hover 的伪类，
          // 于是顶栏上悬停时没有灰块（其它三颗都有）。这里按同一特异性补回 hover。
          ".dshLiveDock[data-inline=\"true\"] .dshLiveSpeak:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
          ".dshLiveDock[data-inline=\"true\"] .dshLiveSpeak[data-muted=\"true\"]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
          ".dshLiveDock[data-inline=\"true\"] .dshLiveDockClose{width:16px;height:16px;border-radius:4px}",
          ".dshLiveDock[data-inline=\"true\"] svg{width:13px;height:13px}",
          // ✕ 是描线，13px 会比实心图标满一圈，单独收 1px
          ".dshLiveDock[data-inline=\"true\"] .dshLiveDockClose svg{width:12px;height:12px}",
          // 左侧栏形态套用紧凑单行样式，但保留 fixed 定位（位置由运行时测量给）
          ".dshLiveDock[data-dock=\"sidebar\"][data-inline=\"true\"]{position:fixed;margin-left:0;padding:3px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#e8e8e8);background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 1px 3px rgba(0,0,0,.06);overflow:visible}",          ".dshLiveDock[data-dock=\"sidebar\"][data-inline=\"true\"] .dshLiveDockRow{gap:6px}",
          ".dshLiveDock[data-dock=\"sidebar\"][data-inline=\"true\"] .dshLiveActions{gap:6px}",
          ".dshLiveDock[data-dock=\"sidebar\"][data-inline=\"true\"] .dshLivePlay{width:16px;height:16px}",
          ".dshLiveDock[data-dock=\"sidebar\"][data-inline=\"true\"] .dshLiveGhost{width:16px;height:16px}",
          ".dshLiveDock[data-dock=\"sidebar\"][data-inline=\"true\"] .dshLiveSpeak{width:16px;height:16px}",
          ".dshLiveDock[data-dock=\"sidebar\"][data-inline=\"true\"] .dshLiveDockClose{width:16px;height:16px}",
          ".dshLiveDock[data-dock=\"sidebar\"][data-inline=\"true\"] svg{width:12px;height:12px}",
          // 侧栏「语音播报」面板（点导航行后主区域显示）
          ".dshLivePanel{padding:24px 28px;display:flex;flex-direction:column;gap:16px;max-width:760px}",
          ".dshLivePanelHead{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-primary,#111)}",
          ".dshLivePanelTitle{font-weight:600}",
          ".dshLivePanelCount{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8e)}",
          ".dshLivePanelText{font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary,#55555a);white-space:pre-wrap;word-break:break-word;max-height:170px;overflow:auto}",
          ".dshLivePanel .dshLiveBar{width:100%;height:4px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.08));overflow:hidden}",
          ".dshLivePanelActions{display:flex;align-items:center;gap:8px}",
          ".dshLivePanelHint{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8e);margin-left:2px}",
          ".dshLivePanelFoot{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8e);margin-top:2px}",
          // 侧栏导航行里的迷你播放条
          ".dshLiveRowBar{position:relative;display:flex;flex:1 1 auto;min-width:0;width:100%;align-items:center;gap:6px;font-size:14px;line-height:1;color:var(--dsw-alias-label-primary,#111);white-space:nowrap;animation:dshLiveSwapIn .14s ease-out}",
          ".dshLiveRowTop{display:flex;width:100%;min-width:0;align-items:center;gap:6px}",
          ".dshLiveRowText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}",
          ".dshLiveRowBtn{flex:none;width:16px;height:16px;border:none;border-radius:4px;background:0 0;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}",
          ".dshLiveRowBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
          // 主键（播放 / 暂停）与卡片、顶栏同款：品牌蓝实心 + 白图标
          ".dshLiveRowBtn[data-primary=\"true\"]{background:0 0;color:var(--dsw-alias-button-info-fill,#007aff)}",
          ".dshLiveRowBtn[data-primary=\"true\"]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
          // 按下瞬间变蓝，松开回原色 —— 除了 hover 淡底之外给一层明确的点击反馈
          ".dshLiveRowBtn:active,.dshLiveCardPlay:active,.dshLiveCardGhost:active,.dshLiveCardClose:active,.dshLivePlay:active,.dshLiveGhost:active,.dshLiveSpeak:active,.dshLiveSpeakBtn:active,.dshLiveDockClose:active,.dshLiveRowToggle:active{color:var(--dsw-alias-button-info-fill,#007aff)}",
          // 静音键：静音中图标转警示色，不用只靠画叉去分辨
          ".dshLiveRowBtn[data-muted=\"true\"],.dshLiveCardGhost[data-muted=\"true\"],.dshLivePlay[data-muted=\"true\"],.dshLiveGhost[data-muted=\"true\"],.dshLiveSpeak[data-muted=\"true\"],.dshLiveSpeakBtn[data-muted=\"true\"]{color:var(--dsw-alias-state-error-primary,#ff453a)}",
          ".dshLiveRowBar svg{width:13px;height:13px}",
          // button 不继承字体（默认会是 13.33px Arial），跟 DSH 的正文字体设置就会对不上，这里统一 inherit
          ".dshLiveRowBtn,.dshLiveCardPlay,.dshLiveCardGhost,.dshLiveCardClose,.dshLiveSpeak,.dshLiveSpeakBtn,.dshLivePlay,.dshLiveGhost,.dshLiveDockClose,.dshLiveSwitch,.dshLiveDockOption,.dshLiveSelect,.dshLiveTestBtn{font:inherit}",
          "@media (prefers-reduced-motion:reduce){.dshLiveDock,.dshLiveBarFill,.dshLiveSwitch:after,.dshLiveCardPlay,.dshLiveRowBtn{animation:none;transition:none}}",
          ".dshLiveRowBar[data-expanded=\"true\"] .dshLiveRowToggle{color:var(--dsw-alias-label-primary,#111)}",
          // 展开箭头属于“工具键”，与三个动作键之间留一道分组间距
          ".dshLiveRowToggle{margin-left:6px}",
          // 行下方展开的卡片
          // 行下方展开的卡片：底色用侧栏选中项那种浅灰，和导航行同一档
          ".dshLiveRowCard{visibility:visible;width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:8px;padding:8px 9px 10px;border-radius:9px;border:none;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));box-shadow:none;cursor:default;container-type:inline-size}",
          ".dshLiveCardHead{display:flex;align-items:center;gap:6px;min-width:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#111)}",
          // 标题分「状态」+「声线名」两段：状态永不截断，声线名空间不够就省略（悬停看全名）
          // 字重跟宿主菜单行一致（400）：宿主 panelTitle 没有加粗，500 会让中文看起来像换了字体
          ".dshLiveCardTitle{flex:1 1 auto;min-width:0;display:inline-flex;align-items:baseline;gap:4px;overflow:hidden;font-weight:400}",
          ".dshLiveCardPhase{flex:none}",
          ".dshLiveCardVoice{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
          // 卡片被拖到很窄时只留状态，声线名自动让位
          "@container (max-width:236px){.dshLiveCardVoice{display:none}}",
          ".dshLiveCardCount{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8e)}",
          ".dshLiveCardClose{margin-left:auto;flex:none;width:16px;height:16px;border:none;border-radius:4px;background:0 0;color:var(--dsw-alias-label-tertiary,#8a8a8e);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}",
          ".dshLiveCardClose:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
          ".dshLiveCardClose svg{width:13px;height:13px}",
          // 展开卡片正文：歌词区，固定三行高（19px * 3 + 2px * 2），当前句在中间行高亮。
          // 高度写死是为了句子长短不同时卡片不上下跳，下面菜单也不会跟着抖。
          ".dshLiveLyrics{display:flex;flex-direction:column;justify-content:center;gap:2px;height:61px;overflow:hidden;padding-left:22px;line-height:19px;min-width:0}",
          ".dshLiveLyricLine{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#8a8a8e)}",
          // 当前句只占一行：长句不再自动缩小折行，改成在这条线上向左滚。
          // 只放一份文字、滚到句尾就停住（forwards）——排两遍的循环跑马灯
          // 会在回绕那一刻把两截文字同时露出来，看着像乱码。
          ".dshLiveLyricScroll{overflow:hidden;min-width:0}",
          ".dshLiveLyricScroll[data-scroll=\"true\"]{-webkit-mask-image:linear-gradient(90deg,transparent,#000 10px,#000 calc(100% - 10px),transparent);mask-image:linear-gradient(90deg,transparent,#000 10px,#000 calc(100% - 10px),transparent)}",
          ".dshLiveLyricTrack{display:block;white-space:nowrap;width:100%;will-change:translate}",
          // 位移动画交给 JS（见 track 的 ref），这里只留进场那一下
          ".dshLiveLyricTrack[data-scroll=\"true\"]{animation:dshLiveLyricIn .24s ease-out}",
          ".dshLiveLyricActive{display:block;font-size:14px;color:var(--dsw-alias-label-primary,#111);white-space:nowrap;text-overflow:unset}",
          ".dshLiveLyricIdle{color:var(--dsw-alias-label-tertiary,#8a8a8e);animation:none}",
          "@keyframes dshLiveLyricIn{from{transform:translateY(9px);opacity:.4}to{transform:none;opacity:1}}",
          ".dshLiveCardText{font-size:13px;line-height:1.45;padding-left:22px;color:var(--dsw-alias-label-secondary,#55555a);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
          ".dshLiveCardBar{position:relative;height:3px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.08));overflow:hidden}",
          ".dshLiveCardActions{display:flex;align-items:center;gap:8px}",
          ".dshLiveCardPlay{flex:none;width:16px;height:16px;border-radius:4px;border:none;background:0 0;color:var(--dsw-alias-label-secondary,#55555a);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;box-shadow:none}",
          ".dshLiveCardPlay[data-primary=\"true\"]{background:0 0;color:var(--dsw-alias-button-info-fill,#007aff)}",
          ".dshLiveCardPlay[data-primary=\"true\"]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
          ".dshLiveCardPlay svg{width:13px;height:13px}",
          ".dshLiveCardGhost{flex:none;width:16px;height:16px;border-radius:4px;border:none;background:0 0;color:var(--dsw-alias-label-secondary,#55555a);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}",
          ".dshLiveCardGhost:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
          ".dshLiveCardGhost svg{width:13px;height:13px}",
          ".dshLiveCardHint{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8e);white-space:nowrap}",

          // ── 设置面板：颜色全部走 DSH 主题变量，第三方皮肤自动跟随 ──
          ".dshLiveSettings{padding:2px 0 10px;font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:var(--dsw-alias-label-primary,#1c1c1e)}",
          ".dshLiveSettingsGroup{margin-bottom:20px}",
          ".dshLiveSettingsGroupTitle{margin:0 0 7px 2px;font-size:12px;letter-spacing:.3px;font-weight:400;color:var(--dsw-alias-label-tertiary,#8e8e93)}",
          ".dshLiveSettingsCard{border-radius:12px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.09));box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2,rgba(127,127,127,.2));overflow:hidden}",
          ".dshLiveRow{display:flex;align-items:center;gap:12px;padding:11px 14px;min-height:46px;box-sizing:border-box}",
          ".dshLiveRow + .dshLiveRow{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l2,rgba(127,127,127,.16))}",
          ".dshLiveRowMain{flex:1 1 auto;min-width:0}",
          ".dshLiveRowMain strong{display:block;font-size:13px;font-weight:400;line-height:1.35}",
          ".dshLiveRowHint{display:block;margin-top:2px;font-size:11.5px;line-height:1.4;color:var(--dsw-alias-label-tertiary,#8e8e93)}",
          ".dshLiveSwitch{flex:none;position:relative;width:40px;height:24px;padding:0;border:none;border-radius:999px;cursor:pointer;background:var(--dsw-alias-border-l3,#d1d1d6);transition:background .18s}",
          ".dshLiveSwitch[data-on=\"true\"]{background:var(--dsw-alias-button-info-fill,#007aff)}",
          ".dshLiveSwitch:after{content:\"\";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:999px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.22);transition:transform .18s}",
          ".dshLiveSwitch[data-on=\"true\"]:after{transform:translateX(16px)}",
          ".dshLiveDockPicker{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;padding:12px 14px 14px}",
          ".dshLiveDockOption{display:flex;flex-direction:column;gap:7px;padding:9px 9px 8px;border-radius:10px;cursor:pointer;text-align:left;font:inherit;color:inherit;background:0 0;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));transition:border-color .16s,background .16s}",
          ".dshLiveDockOption[data-active=\"true\"]{border-color:var(--dsw-alias-button-info-fill,#007aff);background:color-mix(in srgb,var(--dsw-alias-button-info-fill,#007aff) 9%,transparent)}",
          ".dshLiveDockOption:not([data-active=\"true\"]):hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}",
          ".dshLiveDockThumb{position:relative;height:32px;border-radius:6px;overflow:hidden;background:var(--dsw-alias-bg-base,#fff);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2,rgba(127,127,127,.2))}",
          ".dshLiveDockThumbNav{position:absolute;left:0;top:0;bottom:0;width:22%;background:var(--dsw-specific-sidebar-fill,rgba(127,127,127,.18));box-shadow:inset -1px 0 0 var(--dsw-alias-border-l2,rgba(127,127,127,.14))}",
          ".dshLiveDockThumbBar{position:absolute;left:0;right:0;top:0;height:22%;background:var(--dsw-specific-sidebar-fill,rgba(127,127,127,.18));box-shadow:inset 0 -1px 0 var(--dsw-alias-border-l2,rgba(127,127,127,.14))}",
          ".dshLiveDockThumbChip{position:absolute;border-radius:3px;background:var(--dsw-alias-button-info-fill,#007aff);opacity:.9}",
          ".dshLiveDockOptionName{font-size:12px;font-weight:400;line-height:1.2}",
          ".dshLiveDockOptionHint{font-size:11px;line-height:1.3;color:var(--dsw-alias-label-tertiary,#8e8e93)}",
          ".dshLiveSelect{flex:none;height:30px;min-width:170px;max-width:236px;padding:0 8px;border-radius:8px;font:inherit;font-size:12.5px;color:inherit;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));cursor:pointer}",
          ".dshLiveRange{flex:none;width:186px;margin:0;accent-color:var(--dsw-alias-button-info-fill,#007aff)}",
          ".dshLiveEqHead{display:flex;align-items:center;gap:8px;padding:10px 12px 2px}",
          ".dshLiveEqPreset{flex:1;min-width:0}",
          ".dshLiveEqReset{flex:none}",
          ".dshLiveEqBands{display:flex;align-items:flex-end;justify-content:space-between;gap:2px;padding:10px 8px 2px}",
          ".dshLiveEqBand{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0}",
          ".dshLiveEqSlider{-webkit-appearance:slider-vertical;writing-mode:vertical-lr;direction:rtl;width:20px;height:112px;margin:0;accent-color:var(--dsw-alias-button-info-fill,#007aff)}",
          ".dshLiveEqFreq{font-size:10px;line-height:1;color:var(--dsw-alias-label-tertiary,#8e8e93)}",
          ".dshLiveEqDb{font-size:10px;line-height:1;font-variant-numeric:tabular-nums;min-height:12px;color:var(--dsw-alias-label-secondary,#6c6c70)}",
          ".dshLiveEqHint{padding:6px 12px 10px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8e8e93)}",
          ".dshLiveValue{flex:none;min-width:52px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#3c3c43)}",
          ".dshLiveEngineOption{min-height:72px;justify-content:center}",
          ".dshLiveVoicePick{display:flex;flex:none;align-items:center;gap:8px}",
          ".dshLiveVoicePick .dshLiveSelect{min-width:120px;max-width:186px}",
          ".dshLiveVoiceRefresh{padding:0 10px}",
          ".dshLiveTestBtn{flex:none;height:30px;padding:0 14px;border:none;border-radius:8px;font:inherit;font-size:12.5px;font-weight:400;cursor:pointer;color:#fff;background:var(--dsw-alias-button-info-fill,#007aff)}",
          ".dshLiveTestBtn:hover{filter:brightness(1.06)}",
        ].join("");

        try {
          var cssId = "dsh-live-speak/Dock.module.css";
          if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + cssId + '"]') === null) {
            var tag = document.createElement("style");
            tag.dataset.plugin = "dsh-live-speak";
            tag.dataset.pluginCss = cssId;
            tag.textContent = css;
            document.head.appendChild(tag);
          }
        } catch {
          // 样式注入失败也不影响播放
        }

        // ── 播放管理器（模块级单例，两个 slot 共享） ───────────────────
        var manager = {
          auto: true,
          phase: "idle",       // idle | loading | playing | paused | blocked
          items: [],           // 待播 { id, preview, chars }
          current: null,
          // 歌词区用的上一句文本（换句时旧句子上移一行）
          prevText: "",
          // 宿主下发的「下一句」文本：包含还在合成的段，所以段间空档里第三排也不会空
          nextText: "",
          // 当前这一块里正在念第几句（LRC 时间轴下标，-1 表示还没算出来）
          cueIndex: -1,
          cursor: 0,
          epoch: -1,
          audio: null,
          objectUrl: "",
          // 静音开关：默认不静音（有声音），点一下临时静音，再点回来。
          // 单独一个字段而不是把 playbackVolume 改成 0 —— 用户设的音量要留着。
          muted: false,
          progress: 0,
          duration: 0,
          error: "",
          settings: { playbackVolume: 0.9, voiceLabel: "", rate: "+8%", dock: "top", realtime: true, interruptOnNew: true, codeQuiet: true, dockExpanded: false },
          voices: [],
          finishedAt: 0,
          // 实时播报：最近一次收到增量的时间。句子之间有合成空档，
          // 不能因为这个空档就把浮层当成"播完了"收掉。
          streamingAt: 0,
          streaming: false,
          // 后端是否还有没合成完的段：用来区分"在等模型写下一段"和"在合成下一段"，
          // 空档里不能一律写"没有待播内容"，那会让几秒静默看起来像卡死了。
          pending: 0,
          synthBusy: false,
          listeners: [],
          pollTimer: null,
          stopTimer: null
        };

        function emit() {
          var snapshot = manager.listeners.slice();
          for (var i = 0; i < snapshot.length; i += 1) {
            try {
              snapshot[i]();
            } catch {
              // 单个订阅者异常不影响其他
            }
          }
        }

        function subscribe(fn) {
          manager.listeners.push(fn);
          return function () {
            var index = manager.listeners.indexOf(fn);
            if (index >= 0) manager.listeners.splice(index, 1);
          };
        }

        // 宿主打开设置页 / 对话框时会铺一层全屏遮罩（div.<hash>_overlay，z-index 1000，
        // 尺寸等于整个内容区）。我们的展开卡片是 fixed + 自有堆叠顺序，会浮在遮罩
        // 之上 —— 看着就是"卡片压在设置页上还带阴影"，里面的 ⌃/🔊 也还能点。
        // 这里用模块级状态认这层遮罩：认到就把卡片收起并让宿主行恢复常态，
        // 遮罩关掉自动展开回去（rowExpanded 本身不动）。
        var veilActive = false;
        var veilTimer = 0;
        function hostOverlayOpen() {
          var list = document.querySelectorAll('[class*="overlay"]');
          for (var i = 0; i < list.length; i += 1) {
            var el = list[i];
            var cs = window.getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden") continue;
            if (cs.position !== "fixed" && cs.position !== "absolute") continue;
            var z = parseInt(cs.zIndex, 10);
            if (!(z >= 100)) continue;
            var rect = el.getBoundingClientRect();
            if (rect.width < window.innerWidth * 0.6 || rect.height < window.innerHeight * 0.6) continue;
            return true;
          }
          return false;
        }
        function watchHostOverlay() {
          if (veilTimer !== 0) return;
          var streak = 0;
          veilTimer = window.setInterval(function () {
            var now = hostOverlayOpen();
            // 连续两次采样一致才切换，遮罩淡入淡出期间不会让卡片闪进闪出
            if (now === veilActive) {
              streak = 0;
              return;
            }
            streak += 1;
            if (streak < 2) return;
            streak = 0;
            veilActive = now;
            // 遮罩期间卡片一律不显示，行也可能被挪动过：把量好的位置作废，
            // 遮罩解除后由 SidebarRow 的测量 effect 重新量一遍再展开
            if (now === true) rowAnchor = null;
            post("/debug", { what: "row-cover", covered: now });
            emit();
          }, 300);
        }

        function getState() {
          return {
            auto: manager.auto,
            phase: manager.phase,
            current: manager.current,
            // 歌词区只要这三样：上一句、下一句、当前句的完整文本
            prevText: manager.prevText || "",
            nextText: manager.nextText !== "" ? manager.nextText : (manager.items.length > 0 ? (manager.items[0].preview || "") : ""),
            cueIndex: manager.cueIndex,
            queue: manager.items.length,
            // 后端还没合成完的段：空档期用来判断"在合成"，而不是"没内容"
            pending: manager.pending || 0,
            synthBusy: manager.synthBusy === true,
            progress: manager.progress,
            duration: manager.duration,
            error: manager.error,
            settings: manager.settings,
            finishedAt: manager.finishedAt,
            streaming: manager.streaming === true,
            muted: manager.muted === true,
            index: manager.index,
            total: manager.total
          };
        }

        function post(path, body) {
          return fetch(API + path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body || {})
          }).catch(function () {
            return null;
          });
        }

        /**
         * 空档时歌词区那一行该说什么。
         * 优先级：报错 > 模型还在写 > 正在合成 > 真没内容。
         * 中间两种以前都写成"没有待播内容"，几秒静默看起来就像插件卡住了。
         */
        function idleLabel(state, t) {
          if (state.error !== "") return state.error;
          if (state.streaming) return t("empty.streaming");
          if ((state.pending || 0) > 0 || state.synthBusy === true) return t("empty.synth");
          return t("empty.none");
        }

        function clampVolume(value) {
          var num = Number(value);
          if (!Number.isFinite(num)) return 0.9;
          return Math.min(1, Math.max(0, num));
        }

        /**
         * 取一段文本的第一句，用来当歌词区第三排（待播句）。
         * 后端下发的 preview/nextText 是整个块的文本，直接塞进一行会很长。
         */
        function firstSentence(text) {
          if (typeof text !== "string") return "";
          var buf = "";
          var openers = { "《": "》", "「": "」", "『": "』", "“": "”", "‘": "’", "（": "）", "(": ")", "【": "】", "{": "}", "[": "]" };
          var stack = [];
          for (var i = 0; i < text.length; i += 1) {
            var ch = text[i];
            buf += ch;
            if (Object.prototype.hasOwnProperty.call(openers, ch)) {
              stack.push(openers[ch]);
              continue;
            }
            if (stack.length > 0 && ch === stack[stack.length - 1]) {
              stack.pop();
              continue;
            }
            // 逗号、冒号也算一行结束——和后端 splitLyricLines 保持同一套规则（顿号不切），
            // 否则"待播"那一行可能比当前行还长，两行挤在一起滚过去
            if (stack.length === 0 && "。！？!?…；;\n，,：:".indexOf(ch) >= 0) return buf.trim();
          }
          return buf.trim();
        }

        /** 取一段文本的最后一句，用作跨块时歌词区第一排（已播句）。 */
        function lastSentence(text) {
          if (typeof text !== "string" || text === "") return "";
          var rest = text;
          var last = "";
          while (rest !== "") {
            var head = firstSentence(rest);
            if (head === "") break;
            last = head;
            var cut = rest.indexOf(head);
            rest = cut < 0 ? "" : rest.slice(cut + head.length);
          }
          return last;
        }

        /** 真正要写进 audio 的音量：静音时 0，但不改用户设的 playbackVolume */
        function effectiveVolume() {
          return manager.muted === true ? 0 : clampVolume(manager.settings.playbackVolume);
        }

        /** 静音开关：当前这段音频立即生效，不需要重播 */
        function toggleMute() {
          manager.muted = manager.muted !== true;
          var audio = manager.audio;
          if (audio !== null) {
            try {
              audio.volume = effectiveVolume();
            } catch {
              // 有些环境不允许改音量，忽略
            }
          }
          post("/debug", { what: "mute-toggle", muted: manager.muted });
          emit();
        }

        function releaseAudio() {
          var audio = manager.audio;
          manager.audio = null;
          if (audio !== null) {
            try {
              audio.onended = null;
              audio.onerror = null;
              audio.ontimeupdate = null;
              audio.pause();
              audio.removeAttribute("src");
              audio.load();
            } catch {
              // 释放失败无所谓
            }
          }
          if (manager.objectUrl !== "") {
            try {
              URL.revokeObjectURL(manager.objectUrl);
            } catch {
              // 忽略
            }
            manager.objectUrl = "";
          }
        }

        /**
         * 静音回合收尾前的那声提示：静了几分钟再突然开口，容易被当成"又重播了"。
         * 用 WebAudio 现合成两个短音，不占合成队列、不走 /state，
         * 所以不会影响队列顺序，也不会拖慢真正要念的那一段。
         */
        var chimeCtx = null;
        function playChime() {
          if (manager.muted === true) return;
          try {
            var Ctx = window.AudioContext || window.webkitAudioContext;
            if (typeof Ctx !== "function") return;
            if (chimeCtx === null) chimeCtx = new Ctx();
            if (chimeCtx.state === "suspended" && typeof chimeCtx.resume === "function") chimeCtx.resume();
            // 打点：提示音到底有没有走、AudioContext 是否被引擎挂起（挂起时是没声音的）
            post("/debug", { what: "chime", state: chimeCtx.state, peakVolume: Number(manager.settings.playbackVolume) || 0 });
            var base = chimeCtx.currentTime + 0.02;
            var peak = Math.max(0.2, Math.min(1, Number(manager.settings.playbackVolume) || 0.9)) * 0.28;
            [880, 1174.66].forEach(function (freq, i) {
              var osc = chimeCtx.createOscillator();
              var gain = chimeCtx.createGain();
              osc.type = "sine";
              osc.frequency.value = freq;
              var at = base + i * 0.17;
              gain.gain.setValueAtTime(0.0001, at);
              gain.gain.linearRampToValueAtTime(peak, at + 0.02);
              gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.17);
              osc.connect(gain);
              gain.connect(chimeCtx.destination);
              osc.start(at);
              osc.stop(at + 0.18);
            });
          } catch {
            // 提示音失败不影响播报：直接开口就是了
          }
        }

        // ── 均衡器：播放端的 10 段 BiquadFilter 链 ──────────────────
        // 接在 <audio> 元素之后、扬声器之前，不碰合成也不碰下载，
        // 所以播放中拖动滑块就能立刻听到变化，不用重新合成。
        var EQ_BANDS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
        var EQ_BAND_LABELS = ["31", "63", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];
        // 预设：数值是每段增益（dB）。都只动频率响应，不动语速和停顿。
        var EQ_PRESETS = [
          { id: "flat", label: "settings.eq.flat", eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
          // 清晰：削掉 250 那段的闷，抬 1k~4k 的辅音
          { id: "clarity", label: "settings.eq.clarity", eq: [0, 1, 0, -2, 1, 3, 3, 2, 0, -1] },
          // 温柔：低频补厚度，2k~4k 压掉刺耳，高频去数码毛刺
          { id: "soft", label: "settings.eq.soft", eq: [-2, -1, 2, 2, 0, -1, -3, -4, -3, -4] },
          // 浑厚：只补低频
          { id: "deep", label: "settings.eq.deep", eq: [3, 3, 2, 1, 0, 0, 0, 0, 0, 0] },
        ];
        var eqCtx = null;
        var eqNodes = null;

        function ensureEqChain() {
          if (eqNodes !== null) return eqCtx;
          var Ctx = window.AudioContext || window.webkitAudioContext;
          if (typeof Ctx !== "function") return null;
          eqCtx = new Ctx();
          eqNodes = EQ_BANDS.map(function (freq, i) {
            var node = eqCtx.createBiquadFilter();
            if (i === 0) node.type = "lowshelf";
            else if (i === EQ_BANDS.length - 1) node.type = "highshelf";
            else {
              node.type = "peaking";
              node.Q.value = 1;
            }
            node.frequency.value = freq;
            node.gain.value = 0;
            return node;
          });
          for (var j = 1; j < eqNodes.length; j += 1) eqNodes[j - 1].connect(eqNodes[j]);
          // destination 只在这里接一次：每次播放都重复 connect 会让音量叠加
          eqNodes[eqNodes.length - 1].connect(eqCtx.destination);
          return eqCtx;
        }

        function applyEq(values) {
          if (eqNodes === null) return;
          var arr = Array.isArray(values) ? values : [];
          for (var i = 0; i < eqNodes.length; i += 1) {
            var g = Number(arr[i]);
            eqNodes[i].gain.value = Number.isFinite(g) ? Math.max(-12, Math.min(12, g)) : 0;
          }
        }

        /**
         * 把一段音频接到均衡器上。
         * 拿不到 running 的 AudioContext 就直接放弃、走原生播放 ——
         * 均衡器可以有，但不能因为它把声音弄没了。
         */
        function attachEq(audio) {
          var ctx = ensureEqChain();
          if (ctx === null) return null;
          var src = null;
          try {
            var st = String(ctx.state || "");
            if (st !== "running") {
              try { if (typeof ctx.resume === "function") ctx.resume(); } catch {}
              st = String(ctx.state || "");
            }
            if (st !== "running") {
              post("/debug", { what: "eq-bypass", state: st });
              return null;
            }
            src = ctx.createMediaElementSource(audio);
            src.connect(eqNodes[0]);
            applyEq((manager.settings || {}).eq);
            return src;
          } catch (e) {
            post("/debug", { what: "eq-fail", err: String((e && e.message) || e) });
            // 元素已经被接管但链没接上 = 彻底没声，这里直连扬声器保底
            if (src !== null) {
              try { src.connect(ctx.destination); } catch {}
            }
            return null;
          }
        }

        /** 真正开始下一段。 */
        function playItem(item) {
          releaseAudio();
          // 歌词区的「上一句」：取上一块的最后一句（跨块的接续），而不是整块 120 字的 preview
          var oldCues = (manager.current !== null && manager.current !== undefined) ? manager.current.cues : null;
          if (oldCues && oldCues.length > 0) {
            manager.prevText = oldCues[oldCues.length - 1].text || "";
          } else if (manager.current !== null && manager.current !== undefined) {
            var oldPreview = manager.current.preview || "";
            var oldLast = lastSentence(oldPreview);
            manager.prevText = oldLast !== "" ? oldLast : oldPreview;
          }
          manager.current = item;
          manager.phase = "loading";
          manager.progress = 0;
          // 后端合成时就知道这段多长：先拿它当分母，音频元数据到了再用实测值覆盖。
          // 之前只等 audio.duration，元数据拿不到时分母一直是 0，进度条永远空着。
          manager.duration = Number(item.duration) || 0;
          manager.error = "";
          manager.index = item.index;
          manager.total = item.total;
          manager.cueIndex = -1;
          // 播放起点打点：脚本据此算"上一段结束 → 这一段开始"的空档，判断播报有没有被切断
          post("/debug", {
            what: "play-start",
            id: item.id,
            at: Date.now(),
            dur: Math.round((Number(item.duration) || 0) * 1000) / 1000,
            cues: (item.cues || []).length,
            index: item.index,
            total: item.total,
          });
          emit();

          var audio = new Audio();
          manager.audio = audio;
          audio.volume = effectiveVolume();
          audio.preload = "auto";
          // 均衡器接不上（极少数环境）就保持原声，不影响播报
          manager.audioEq = attachEq(audio);

          // 分母优先用后端给的时长：Edge TTS 的 mp3 在播放前 audio.duration 常是 Infinity，
          // 只能等播放一会儿才变成真值，中间那几秒没有后端时长的话进度条就是空的。
          // 换句判定单独走 requestAnimationFrame：timeupdate 只有 4Hz（250ms），
          // 用它换句平均会晚 0.12s、最晚 0.26s，歌词看着总比声音慢半拍。
          var cueRaf = 0;
          var cues = item.cues || [];
          var syncCue = function () {
            manager.progress = Number(audio.currentTime) || 0;
            if (cues.length > 0) {
              var next = manager.cueIndex;
              for (var i = 0; i < cues.length; i += 1) {
                if (manager.progress >= cues[i].t) next = i;
                else break;
              }
              if (next !== manager.cueIndex) {
                manager.cueIndex = next;
                // 滚动跟不跟得上语速：记下换句瞬间"音频已播到哪"和"这一句应该在几点起"，
                // drift 为正表示文字晚于声音出现（跟不上），为负表示文字提前跳到下一句
                post("/debug", {
                  what: "cue-tick",
                  id: item.id,
                  idx: next,
                  cueT: cues[next] ? Number(cues[next].t) || 0 : 0,
                  actual: Math.round(manager.progress * 1000) / 1000,
                  drift: Math.round(((manager.progress - (cues[next] ? Number(cues[next].t) || 0 : 0))) * 1000) / 1000,
                  text: cues[next] ? String(cues[next].text).slice(0, 40) : "",
                });
                emit();
              }
            }
            if (!audio.paused && !audio.ended) cueRaf = window.requestAnimationFrame(syncCue);
            else cueRaf = 0;
          };
          audio.onplay = function () {
            if (!cueRaf) cueRaf = window.requestAnimationFrame(syncCue);
          };
          audio.ontimeupdate = function () {
            manager.progress = Number(audio.currentTime) || 0;
            if (Number.isFinite(audio.duration) && audio.duration > 0) manager.duration = audio.duration;
            emit();
          };
          audio.onended = function () {
            if (cueRaf) {
              window.cancelAnimationFrame(cueRaf);
              cueRaf = 0;
            }
            if (manager.audio !== audio) return;
            post("/debug", {
              what: "play-end",
              id: item.id,
              at: Date.now(),
              // 实际念了多久：和合成给的 duration 比，偏差大说明末尾有静音或被截
              elapsed: Math.round((Number(audio.duration) || manager.progress || 0) * 1000) / 1000,
              expect: Math.round((Number(item.duration) || 0) * 1000) / 1000,
            });
            post("/consume", { id: item.id });
            manager.phase = "idle";
            // 这里故意不清 current：下一段开始时它正好当歌词区的「上一句」；
            // 清空的话每段都从空白起，卡片里那句会一闪一闪。
            manager.progress = 0;
            manager.duration = 0;
            manager.finishedAt = Date.now();
            releaseAudio();
            emit();
            pump();
          };
          audio.onerror = function () {
            if (manager.audio !== audio) return;
            if (item.viaBlob === true) {
              manager.error = "音频读取失败";
              manager.phase = "idle";
              manager.finishedAt = Date.now();
              releaseAudio();
              emit();
              pump();
              return;
            }
            playViaBlob(item, audio);
          };

          audio.src = AUDIO_PREFIX + item.id;
          var startAudio = function () {
            if (manager.audio !== audio) return;
            var promise = audio.play();
            if (promise && typeof promise.then === "function") {
              promise.then(function () {
                if (manager.audio !== audio) return;
                // 用户在加载中就点了暂停：别让 play() 的成功回调把状态顶回 playing
                if (manager.phase === "paused") {
                  try {
                    audio.pause();
                  } catch {
                    // 忽略
                  }
                  emit();
                  return;
                }
                manager.phase = "playing";
                emit();
              }).catch(function (error) {
                if (manager.audio !== audio) return;
                // 自动播放被拦：等用户点一下播放条上的按钮
                if (error && (error.name === "NotAllowedError" || error.name === "AbortError")) {
                  manager.phase = "blocked";
                  emit();
                  return;
                }
                playViaBlob(item, audio);
              });
            } else {
              manager.phase = "playing";
              emit();
            }
          };
          // 静音回合收尾：先"叮"一声，停半拍再开口，免得几分钟静默后的第一句被当成重播
          if (item.chime === true) {
            playChime();
            window.setTimeout(startAudio, CHIME_GAP_MS);
          } else {
            startAudio();
          }
        }

        /**
         * 兜底：直接给 Audio 一个 URL 在某些环境（自定义 scheme / 权限）下可能读不到，
         * 那就自己 fetch 成 Blob 再喂给 Audio —— 同源 fetch 一定会经过宿主路由。
         */
        function playViaBlob(item, audio) {
          if (item.viaBlob === true || manager.audio !== audio) return;
          item.viaBlob = true;
          fetch(AUDIO_PREFIX + item.id)
            .then(function (res) {
              if (!res.ok) throw new Error("HTTP " + res.status);
              return res.blob();
            })
            .then(function (blob) {
              if (manager.audio !== audio) return;
              var url = URL.createObjectURL(blob);
              if (manager.objectUrl !== "") {
                try {
                  URL.revokeObjectURL(manager.objectUrl);
                } catch {
                  // 忽略
                }
              }
              manager.objectUrl = url;
              audio.src = url;
              return audio.play();
            })
            .then(function () {
              if (manager.audio !== audio) return;
              manager.phase = "playing";
              emit();
            })
            .catch(function (error) {
              if (manager.audio !== audio) return;
              manager.error = "音频获取失败：" + String((error && error.message) || error);
              manager.phase = "idle";
              manager.finishedAt = Date.now();
              post("/consume", { id: item.id });
              releaseAudio();
              emit();
              pump();
            });
        }

        /** pointerdown 和 click 都可能到达，300ms 内只认第一次。 */
        var lastActionAt = 0;
        function fire(fn) {
          return function (event) {
            var now = Date.now();
            if (now - lastActionAt < 300) return;
            lastActionAt = now;
            try {
              fn(event);
            } catch {
              // 动作失败不影响渲染
            }
          };
        }

        /** 队列里还有就接着播。 */
        function pump() {
          if (manager.phase === "loading" || manager.phase === "playing" || manager.phase === "paused" || manager.phase === "blocked") return;
          if (manager.items.length === 0) {
            manager.phase = "idle";
            emit();
            return;
          }
          manager.phase = "loading";
          playItem(manager.items.shift());
        }

        function pause() {
          // 段与段之间（音频还没就绪）也必须能暂停：只改状态，pump 会看到 paused 就不往下起
          if (manager.audio !== null) {
            try {
              manager.audio.pause();
            } catch {
              // 忽略
            }
          }
          manager.phase = "paused";
          emit();
        }

        function resume() {
          if (manager.audio !== null) {
            if (manager.phase === "paused" || manager.phase === "blocked") {
              var promise = manager.audio.play();
              if (promise && typeof promise.then === "function") {
                promise.then(function () {
                  manager.phase = "playing";
                  emit();
                }).catch(function () {
                  manager.phase = "blocked";
                  emit();
                });
              } else {
                manager.phase = "playing";
                emit();
              }
              return;
            }
          }
          // 当前段已经没了（被清空/播完），从队列里重新起
          manager.phase = "idle";
          pump();
        }

        /** 停止：本地的 Audio 立刻静音，宿主那边未播的直接丢弃。 */
        function stop(options) {
          var notifyHost = (options && options.notifyHost === false) ? false : true;
          releaseAudio();
          manager.items = [];
          manager.current = null;
          manager.prevText = "";
          manager.nextText = "";
          manager.phase = "idle";
          manager.progress = 0;
          manager.duration = 0;
          manager.index = 0;
          manager.total = 0;
          manager.finishedAt = 0;
          manager.error = "";
          emit();
          if (notifyHost) post("/clear");
        }

        /** 跳过当前这段，立刻下一段。 */
        function skip() {
          var item = manager.current;
          releaseAudio();
          if (item !== null) post("/consume", { id: item.id });
          // 被跳过的那句留在歌词区上方当「上一句」，视觉上才有滚动的连续感
          if (item !== null && item !== undefined) manager.prevText = item.preview || "";
          manager.current = null;
          manager.phase = "idle";
          manager.progress = 0;
          manager.duration = 0;
          emit();
          pump();
        }

        function setAuto(next) {
          manager.auto = next === true;
          emit();
          post("/auto", { auto: manager.auto }).then(function (res) {
            if (res === null) return;
            // 关掉自动播报 = 立刻闭嘴，不再念后面的
            if (!manager.auto) stop();
          });
        }

        /** 拉一次宿主状态，把新合成好的段接进本地队列。 */
        function poll() {
          var url = API + "/state?after=" + String(manager.cursor);
          fetch(url)
            .then(function (res) {
              return res.ok ? res.json() : null;
            })
            .then(function (data) {
              if (!data || !data.ok) return;
              // 实时流停了 25 秒就认为这条回复讲完了，浮层可以收
              var liveNow = manager.streamingAt > 0 && Date.now() - manager.streamingAt < 25000;
              if (manager.streaming !== liveNow) {
                manager.streaming = liveNow;
                emit();
              }
              manager.auto = data.auto === true;
              // 声线清单由宿主给，设置面板的下拉直接用它
              if (Array.isArray(data.voices)) manager.voices = data.voices;
              if (data.settings) {
                var oldVolume = manager.settings.playbackVolume;
                manager.settings = data.settings;
                applyEq(data.settings.eq);
                if (manager.audio !== null && oldVolume !== data.settings.playbackVolume) {
                  manager.audio.volume = effectiveVolume();
                }
              }
              // 宿主打断（新回复要念）：本地的队列和当前音频全部作废
              if (data.epoch !== undefined) {
                if (manager.epoch === -1) {
                  manager.epoch = data.epoch;
                } else if (data.epoch !== manager.epoch) {
                  manager.epoch = data.epoch;
                  manager.cursor = 0;
                  releaseAudio();
                  manager.items = [];
                  manager.current = null;
                  manager.prevText = "";
                  manager.nextText = "";
                  manager.phase = "idle";
                  manager.progress = 0;
                  manager.duration = 0;
                  emit();
                  // 立刻再拉一次全量（此时 epoch 已对齐，不会重复触发）
                  setTimeout(poll, 0);
                  return;
                }
              }
              var incoming = data.ready || [];
              if (typeof data.nextText === "string") manager.nextText = data.nextText;
              // 空档期给歌词区一个准确说法：还在合成 / 在等模型 / 真没内容
              var nextPending = Number(data.pending) || 0;
              var nextBusy = data.synthesizing === true;
              if (nextPending !== manager.pending || nextBusy !== manager.synthBusy) {
                manager.pending = nextPending;
                manager.synthBusy = nextBusy;
                emit();
              }
              var appended = false;
              for (var i = 0; i < incoming.length; i += 1) {
                var item = incoming[i];
                if (!item || item.id <= manager.cursor) continue;
                manager.cursor = item.id;
                manager.items.push({ id: item.id, preview: item.preview, chars: item.chars, duration: Number(item.duration) || 0, index: item.index, total: item.total, cues: item.cues || [], chime: item.chime === true });
                appended = true;
              }
              if (appended) emit();
              pump();
            })
            .catch(function () {
              // 宿主没起路由时静默
            });
        }

        function startPolling() {
          if (manager.pollTimer !== null) return;
          poll();
          manager.pollTimer = setInterval(function () {
            // 空闲时慢一点，播报中快一点
            var busy = manager.phase !== "idle" || manager.items.length > 0;
            if (busy || document.visibilityState === "visible") poll();
          }, 600);
        }

        function stopPolling() {
          if (manager.pollTimer !== null) {
            clearInterval(manager.pollTimer);
            manager.pollTimer = null;
          }
        }

        // ── 图标 ────────────────────────────────────────────────────────
        function WaveIcon(props) {
          var muted = props && props.muted === true;
          if (muted) {
            return h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
              h("path", { d: "M11 5 6 9H2v6h4l5 4V5z" }),
              h("path", { d: "M17 9l4 6M21 9l-4 6" })
            );
          }
          return h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
            h("path", { d: "M11 5 6 9H2v6h4l5 4V5z" }),
            h("path", { className: "dshLiveWave", d: "M15.54 8.46a5 5 0 0 1 0 7.07" }),
            h("path", { className: "dshLiveWave dshLiveWave2", d: "M19.07 4.93a10 10 0 0 1 0 14.14" })
          );
        }

        /** 图标风格开关：pinwheel = 宿主风车（对照）；bars = 四根块状声波；tile = 满格块底 + 反相麦；line = 线条麦克风；grid9 = 宿主「插件市场」九格 */
        var GLYPH_STYLE = "bars";

        /** 插件图标：默认四根声波条（16px 网格、currentColor 跟随主题；播报中高低跳动） */
        function GlyphIcon(props) {
          var phase = props !== null && props !== undefined && props.phase ? props.phase : "idle";
          if (GLYPH_STYLE === "tile") {
            // 满格圆角块底 + 反相麦克风：块底用主题字色，麦用侧栏底色 —— 深浅主题自动反相
            return h("span", { className: "dshLiveGlyphIcon", "data-phase": phase },
              h("svg", {
                viewBox: "0 0 16 16", width: 16, height: 16, fill: "none",
                strokeLinecap: "round", strokeLinejoin: "round",
                style: { flex: "none", display: "block", width: "16px", height: "16px" }
              },
                h("rect", { x: 0, y: 0, width: 16, height: 16, rx: 3.9, style: { fill: "currentColor" } }),
                h("rect", { x: 5.7, y: 2, width: 4.6, height: 7.2, rx: 2.3, style: { fill: "var(--dsw-specific-sidebar-fill, #ffffff)" } }),
                h("path", { d: "M3.4 7.2a4.6 4.6 0 0 0 9.2 0", style: { fill: "none", stroke: "var(--dsw-specific-sidebar-fill, #ffffff)", strokeWidth: 1.9 } }),
                h("rect", { x: 7.3, y: 11.4, width: 1.5, height: 1.9, style: { fill: "var(--dsw-specific-sidebar-fill, #ffffff)" } }),
                h("rect", { x: 4.6, y: 13.1, width: 6.8, height: 1.6, rx: 0.8, style: { fill: "var(--dsw-specific-sidebar-fill, #ffffff)" } })
              )
            );
          }
          if (GLYPH_STYLE === "grid9") {
            // 宿主「插件市场」九格原参数：块 3.3×3.3、rx 0.53、步距 3.75，第 9 块斜 9°
            var g9 = [[1.96, 3.36], [5.71, 3.36], [1.96, 7.11], [5.71, 7.11], [9.46, 7.11], [1.96, 10.86], [5.71, 10.86], [9.46, 10.86]];
            return h("span", { className: "dshLiveGlyphIcon", "data-phase": phase },
              h("svg", {
                viewBox: "0 0 16 16", width: 16, height: 16, fill: "none",
                style: { flex: "none", display: "block", width: "16px", height: "16px", fill: "currentColor" }
              },
                h("g", null, g9.map(function (p, i) {
                  return h("rect", { key: "b" + i, x: p[0], y: p[1], width: 3.3, height: 3.3, rx: 0.53 });
                })),
                h("rect", { x: 10.74, y: 2.09, width: 3.3, height: 3.3, rx: 0.53, transform: "rotate(9 12.39 3.74)" })
              )
            );
          }
          if (GLYPH_STYLE === "line") {
            // 线条麦克风：16px 网格、currentColor、1.7 线宽（与旧版 icon-svg 同一份几何）
            return h("span", { className: "dshLiveGlyphIcon", "data-phase": phase },
              h("svg", {
                viewBox: "0 0 16 16", width: 16, height: 16, fill: "none",
                strokeLinecap: "round", strokeLinejoin: "round",
                style: { flex: "none", display: "block", width: "16px", height: "16px", stroke: "currentColor" }
              },
                h("rect", { x: 5.8, y: 1.1, width: 4.4, height: 7.4, rx: 2.2, strokeWidth: 1.7 }),
                h("path", { d: "M2.3 6.3a5.7 5.7 0 0 0 11.4 0", strokeWidth: 1.7 }),
                h("path", { d: "M8 12v1.5", strokeWidth: 1.7 }),
                h("path", { d: "M4.4 14.1h7.2", strokeWidth: 1.7 })
              )
            );
          }
          if (GLYPH_STYLE === "pinwheel") {
            return h("span", { className: "dshLiveGlyphIcon", "data-phase": phase },
              h("svg", {
                viewBox: "0 0 16 16", width: 16, height: 16, fill: "none",
                strokeLinecap: "round", strokeLinejoin: "round",
                style: { flex: "none", display: "block", width: "16px", height: "16px", stroke: "currentColor" }
              },
                h("path", { d: "M7.84457 5.06199C11.6605 4.93876 14.7962 6.14848 14.8484 7.76397C14.8875 8.97461 13.1838 10.0696 10.7215 10.5942", strokeWidth: 1 }),
                h("path", { d: "M5.12742 8.07731C5.00419 4.26138 6.21391 1.12568 7.8294 1.07351C9.04004 1.03441 10.135 2.73808 10.6596 5.20037", strokeWidth: 1 }),
                h("path", { d: "M8.02457 10.6802C4.20865 10.8034 1.07294 9.5937 1.02077 7.97821C0.981678 6.76758 2.68535 5.67262 5.14763 5.14798", strokeWidth: 1 }),
                h("path", { d: "M10.7476 7.89535C10.8708 11.7113 9.66109 14.847 8.0456 14.8991C6.83496 14.9382 5.74 13.2346 5.21536 10.7723", strokeWidth: 1 })
              )
            );
          }
          return h("span", { className: "dshLiveGlyphIcon", "data-phase": phase },
            h("svg", {
              viewBox: "0 0 16 16", width: 16, height: 16,
              style: { flex: "none", display: "block", width: "16px", height: "16px", fill: "currentColor" }
            },
              h("rect", { className: "dshLiveGlyphBar", x: 1.96, y: 7.76, width: 2, height: 6.4, rx: 1 }),
              h("rect", { className: "dshLiveGlyphBar", x: 5.36, y: 2.76, width: 2, height: 11.4, rx: 1 }),
              h("rect", { className: "dshLiveGlyphBar", x: 8.76, y: 5.76, width: 2, height: 8.4, rx: 1 }),
              h("rect", { className: "dshLiveGlyphBar", x: 12.16, y: 9.76, width: 2, height: 4.4, rx: 1 })
            )
          );
        }

        function PlayIcon() {
          // 三角的包围盒按 viewBox 居中（5.5→18.5，中心正好 12），
          // 否则在小方块里会看起来整体偏右
          return h("svg", { viewBox: "0 0 24 24", width: 14, height: 14, fill: "currentColor" },
            h("path", { d: "M5.5 5v14l13-7z" })
          );
        }

        function PauseIcon() {
          return h("svg", { viewBox: "0 0 24 24", width: 13, height: 13, fill: "currentColor" },
            h("rect", { x: 6, y: 4.5, width: 4, height: 15, rx: 1.2 }),
            h("rect", { x: 14, y: 4.5, width: 4, height: 15, rx: 1.2 })
          );
        }

        function StopIcon() {
          // 12/24 的方块：和播放三角的视觉面积接近，否则实心方块会显得比三角沉一档
          return h("svg", { viewBox: "0 0 24 24", width: 11, height: 11, fill: "currentColor" },
            h("rect", { x: 6, y: 6, width: 12, height: 12, rx: 2 })
          );
        }

        function SkipIcon() {
          return h("svg", { viewBox: "0 0 24 24", width: 13, height: 13, fill: "currentColor" },
            h("path", { d: "M5 5v14l9-7z" }),
            h("rect", { x: 16, y: 5, width: 3, height: 14, rx: 1 })
          );
        }

        function CloseIcon() {
          // 描线比实心图标视觉更重，线宽压到 2 才和 ▶ ■ ⏭ 一个重量
          return h("svg", { viewBox: "0 0 24 24", width: 11, height: 11, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" },
            h("path", { d: "M6 6l12 12M18 6l-12 12" })
          );
        }

        function useManager() {
          var tick = react.useState(0);
          var bump = tick[1];
          var force = react.useCallback(function () {
            bump(function (n) { return n + 1; });
          }, []);
          react.useEffect(function () {
            return subscribe(force);
          }, [force]);
          return [getState(), force];
        }

        // 侧栏行的展开状态：渲染发生在宿主按钮内部，用模块级变量保存
        var rowExpanded = false;
        // 用户手动点过行尾箭头之后置 true：此时"默认展开"设置不再覆盖当前状态
        var rowExpandedManual = false;
        // 展开卡片的位置（侧栏行在视口里的矩形），由 Dock 用来 fixed 定位
        var rowAnchor = null;
        // 展开卡片是否已上报过 debug（避免每次渲染都打一条）
        var cardLogged = false;

        /** 展开 / 收起箭头：展开时朝上，收起时朝下 */
        function ChevronIcon(props) {
          var up = props !== null && props !== undefined && props.up === true;
          return h("svg", { viewBox: "0 0 24 24", width: 12, height: 12, fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round" },
            h("path", { d: up ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6" })
          );
        }

        /**
         * 侧栏那一行本身就是播放条：宿主给它 264x36 的 flex 行、overflow 可见，
         * 图标位后面还空着约 180px，所以把控件直接塞进图标位里。
         * 最右侧那个箭头把这一行向下展开成一张卡片（预览 + 进度 + 大按钮）。
         * 点击行其余区域仍然是宿主的「切到面板」，按钮自己的事件要拦下来。
         */
        function SidebarRow() {
          var pair = useManager();
          var state = pair[0];
          var force = pair[1];
          var dockMode = (state.settings && state.settings.dock) || "sidebar";
          // 「侧栏播放条默认展开」设置：只在用户还没手动点过箭头时生效。
          // 而且只在**真的有待播内容时**才展开 —— 空卡片默认弹开会压住下面的「更多」
          // 和工作区（1.0.179 实机重启后就是这样，用户看到就是一坨灰框）。
          // 一旦展开过就保持（播完不主动收回），收起一律交给手动点箭头或改设置。
          // 「侧栏播放条默认展开」设置：只在用户还没手动点过箭头时覆盖当前状态。
          // 必须走 effect 而不是在渲染里改模块变量 —— 设置是轮询回来的，
          // 改完不 force() 界面不会重画，重启后看着就像"开关没生效"。
          react.useEffect(function () {
            if (rowExpandedManual === true) return;
            var wantExpanded = (state.settings && state.settings.dockExpanded === true) && dockMode === "sidebar";
            // 排查用：设置值到底有没有到客户端、算出来的想要状态是什么
            post("/debug", {
              what: "row-want",
              setting: state.settings ? state.settings.dockExpanded : "no-settings",
              dock: dockMode,
              want: wantExpanded,
              cur: rowExpanded,
              anchor: rowAnchor === null ? null : rowAnchor.top
            });
            if (rowExpanded === wantExpanded) return;
            rowExpanded = wantExpanded;
            if (wantExpanded !== true) rowAnchor = null;
            force();
          }, [state.settings && state.settings.dockExpanded, dockMode]);
          // 歌词滚动：位移与周期在渲染时就算好（lyricPlan），由下面的 effect 落到元素上。
          // 不能用内联 ref 做这件事 —— React 每次重渲染都会把内联 ref 拆掉重挂，
          // 播放中每秒好几次 emit，等于每秒把文字拉回起点，看起来就是"滚一下卡住"。
          var lyricTrackRef = react.useRef(null);
          var rowBarRef = react.useRef(null);
          // 卡片是否显示由模块级 veilActive 决定（宿主遮罩打开时收起），见上面 watchHostOverlay。
          var covered = veilActive === true;
          var lyricPlan = null;
          var lyricPlanKey = "";
          // 注意：这里不能再 return null。宿主是在挂载时把这条 panel 行插进菜单的，
          // 组件返回 null 之后那一行就再也不回来了（切回侧栏也是空的）。
          // 所以内容始终渲染，靠下面的 effect 把宿主那一行整行摘掉。
          var phase = state.phase;
          var voiceName = voiceNameOf(state);
          var label = phase === "loading"
            ? t("phase.loading")
            : phase === "playing"
              ? t("phase.playing")
              : phase === "paused"
                ? t("phase.paused")
                : phase === "blocked"
                  ? t("phase.blocked")
                  : state.streaming
                    ? t("phase.generating")
                    : (phase === "idle" ? t("phase.idle") : t("phase.done"));
          var short = phase === "loading"
            ? t("short.loading")
            : phase === "playing"
              ? t("short.playing")
              : phase === "paused"
                ? t("short.paused")
                : phase === "blocked"
                  ? t("short.blocked")
                  : state.streaming
                    ? t("short.generating")
                    : (phase === "idle" ? t("short.idle") : t("short.done"));
          var percent = state.duration > 0 ? Math.min(100, Math.max(0, (state.progress / state.duration) * 100)) : 0;
          var current = state.current;
          var text = current !== null && current.preview
            ? current.preview
            : idleLabel(state, t);
          var total = state.total > 0 ? state.total : 0;
          var index = state.index > 0 ? state.index : 1;
          var counter = total > 1 ? index + "/" + total : (state.queue > 0 ? "+" + state.queue : "");
          // 只有"真有东西在手上"时播放键才是品牌蓝实心：正在播 / 加载 / 暂停，或队列里还有待播。
          // 不要用 total / streaming 判：它们播报结束后仍留着旧值，会让空闲状态也常亮一块蓝。
          var hasContent = phase === "playing" || phase === "loading" || phase === "paused"
            || state.queue > 0;
          var hold = function () {
            return function (event) {
              try {
                event.stopPropagation();
              } catch (err1) {
                // 事件对象异常无所谓
              }
            };
          };
          var act = function (fn) {
            return function (event) {
              try {
                event.stopPropagation();
                if (typeof event.preventDefault === "function") event.preventDefault();
              } catch (err2) {
                // 同上
              }
              try {
                fn(event);
              } catch (err3) {
                // 单个动作失败不影响其他按钮
              }
            };
          };
          var togglePlay = function () {
            if (phase === "playing" || phase === "loading") pause();
            else resume();
          };
          var toggleExpand = function () {
            // 手动开合过之后，"默认展开"设置就不再覆盖当前的展开状态
            rowExpandedManual = true;
            rowExpanded = rowExpanded !== true;
            // 记下这一行的位置：展开的卡片由 overlay 里的 Dock 渲染，
            // 位置钉在行的正下方（行内部的溢出会被宿主裁掉）
            try {
              var bar = document.querySelector(".dshLiveRowBar");
              if (bar !== null && bar !== undefined) {
                var rect = bar.getBoundingClientRect();
                rowAnchor = {
                  top: Math.round(rect.top),
                  bottom: Math.round(rect.bottom),
                  left: Math.round(rect.left),
                  width: Math.round(rect.width)
                };
              }
            } catch (errMeasure) {
              rowAnchor = null;
            }
            post("/debug", { what: "row-toggle", expanded: rowExpanded, anchor: rowAnchor });
            force();
          };
          var preview = function () {
            post("/speak", { text: (state.settings && state.settings.previewText) || "你好，我是晓晓。这是试听。" });
          };
          // 形态互斥：选「顶栏」时把宿主那一行整行 `display:none`（不占位，
          // 后面的菜单项自然上提，不留空白）；选「左侧导航栏」再放回来。
          // 用 display 而不是 visibility：visibility:hidden 仍然占着高度，会留一条空行。
          // 默认展开时卡片要有位置："默认展开"是在渲染里就把 rowExpanded 立起来的，
          // 那一刻行还没挂好，量不到矩形。这里等 DOM 就绪后补量一次，量到再重渲染。
          react.useEffect(function () {
            if (dockMode !== "sidebar") return undefined;
            if (rowExpanded !== true || rowAnchor !== null) return undefined;
            var autoBar = document.querySelector(".dshLiveRowBar");
            if (autoBar === null || autoBar === undefined) return undefined;
            try {
              var autoRect = autoBar.getBoundingClientRect();
              rowAnchor = {
                top: Math.round(autoRect.top),
                bottom: Math.round(autoRect.bottom),
                left: Math.round(autoRect.left),
                width: Math.round(autoRect.width)
              };
              post("/debug", { what: "row-toggle", expanded: rowExpanded, anchor: rowAnchor, by: "default" });
              force();
            } catch (errAutoMeasure) {
              rowAnchor = null;
            }
            return undefined;
          }, [rowExpanded, dockMode, veilActive]);

          react.useEffect(function () {
            var bar = document.querySelector(".dshLiveRowBar");
            var row = bar !== null && bar !== undefined ? bar.closest("button") : null;
            if (row === null || row === undefined) return undefined;
            // 宿主把插件内容塞进了它的图标槽（class 里带 panelGlyph），那个槽是
            // flex:0 0 auto、宽度按内容收缩，右边会空出一大块。把它改成可伸缩，
            // 我们的行才能真正铺到宿主行的右内边，按钮组才会贴在最右侧。
            try {
              var slot = bar.closest('[class*="panelGlyph"]');
              if (slot !== null && slot !== undefined) {
                slot.style.flex = "1 1 auto";
                slot.style.width = "100%";
                slot.style.minWidth = "0";
                slot.style.maxWidth = "none";
              }
              // 宿主行里还有两个 0 宽的空元素，gap:6px 会给它们各留 6px，
              // 结果我们的行永远差 12px 贴不到右内边；这一行只放我们的内容，gap 归零即可。
              row.style.gap = "0px";
            } catch (errSlot) {
              // 宿主结构变了就跳过，不影响其它逻辑
            }
            if (dockMode === "sidebar") {
              if (row.style.display === "none") row.style.display = "";
              return undefined;
            }
            // 切到顶栏时顺手把就地展开的卡片收起来，否则它会一直挂在那里
            if (rowExpanded === true) {
              rowExpanded = false;
              rowAnchor = null;
              force();
            }
            row.style.display = "none";
            return undefined;
          }, [dockMode]);
          // 展开时：把宿主那一行藏起来（卡片正好盖在它的位置），
          // 再补一份下边距把下面的菜单推开 —— 视觉上就是「这一行就地长成了卡片」
          react.useEffect(function () {
            var bar = document.querySelector(".dshLiveRowBar");
            var row = bar !== null && bar !== undefined ? bar.closest("button") : null;
            if (row === null || row === undefined) return undefined;
            if (rowExpanded !== true) {
              row.style.marginBottom = "";
              row.style.visibility = "";
              return undefined;
            }
            var raf = 0;
            // 量一次宿主行。侧栏能拖宽、窗口能缩放、菜单能折叠，
            // 所以不能只用「点开那一瞬间」的坐标，尺寸一变就重量。
            var measure = function (log) {
              // 每次现查：默认展开那条路径上，effect 第一次跑的时候卡片还没渲染出来，
              // 提前把 cardEl 查好会一直是 null，行就不会被隐藏、菜单也不会被推开
              var cardEl = document.querySelector(".dshLiveRowCard");
              var rect = row.getBoundingClientRect();
              var cs = window.getComputedStyle(row);
              var inset = parseFloat(cs.borderLeftWidth) || 0;
              var radius = parseFloat(cs.borderTopLeftRadius) || 0;
              var prev = rowAnchor;
              var next = {
                top: rect.top,
                bottom: rect.bottom,
                left: rect.left,
                width: rect.width,
                inset: inset,
                radius: radius
              };
              var moved = prev === null
                || Math.abs(prev.left - next.left) > 0.5
                || Math.abs(prev.top - next.top) > 0.5
                || Math.abs(prev.width - next.width) > 0.5
                || (prev.inset || 0) !== inset
                || (prev.radius || 0) !== radius;
              rowAnchor = next;
              if (cardEl !== null && cardEl !== undefined) {
                cardEl.style.top = rect.top + "px";
                cardEl.style.left = (rect.left + inset) + "px";
                cardEl.style.width = (rect.width - inset * 2) + "px";
                cardEl.style.borderRadius = (radius > 0 ? Math.max(4, radius - inset) : 8) + "px";
                // 宿主行藏起来、卡片正好盖在它上面；卡片长高多少，下面菜单就推开多少
                row.style.visibility = "hidden";
                row.style.marginBottom = (cardEl.offsetHeight - 36) + "px";
              }
              // cardStyle 是受控的，下一轮渲染会用 rowAnchor 重算 —— 数值变了就让渲染跟上，
              // 否则手写的 style 会在下一次 re-render 时被打回旧值
              if (moved) {
                force();
                // 侧栏拖宽 / 窗口缩放时的跟随记录（首次展开用 row-geom，这里只记变化）
                if (log !== true && cardEl !== null && cardEl !== undefined) {
                  var reRect = cardEl.getBoundingClientRect();
                  post("/debug", {
                    what: "row-relayout",
                    row: { top: rect.top, left: rect.left, width: rect.width },
                    card: { top: reRect.top, left: reRect.left, width: reRect.width }
                  });
                }
              }
              if (log === true && cardEl !== null && cardEl !== undefined) {
                var cardRect = cardEl.getBoundingClientRect();
                // 顺带把卡片标题与宿主行的实测字体一起上报，字是否一致一眼能比
                var titleEl = cardEl.querySelector(".dshLiveCardTitle");
                var tcs = titleEl !== null && titleEl !== undefined ? window.getComputedStyle(titleEl) : null;
                var ccs = window.getComputedStyle(cardEl);
                post("/debug", {
                  what: "row-geom",
                  row: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
                  inset: inset,
                  radius: radius,
                  padLeft: parseFloat(cs.paddingLeft) || 0,
                  fontSize: cs.fontSize,
                  card: { top: cardRect.top, left: cardRect.left, width: cardRect.width, height: cardRect.height },
                  font: {
                    ours: tcs === null ? null : { family: tcs.fontFamily, size: tcs.fontSize, weight: tcs.fontWeight },
                    host: { family: cs.fontFamily, size: cs.fontSize, weight: cs.fontWeight }
                  },
                  hostGlyph: (function () {
                    var g = document.querySelector(".wtg9ga_panelGlyph");
                    if (g === null || g === undefined) return null;
                    var gr = g.getBoundingClientRect();
                    return { left: gr.left, width: gr.width, height: gr.height };
                  })(),
                  hostGlyphSvg: (function () {
                    var g = document.querySelector(".wtg9ga_panelGlyph");
                    if (g === null || g === undefined) return null;
                    var s = g.querySelector("svg");
                    return s === null || s === undefined ? null : s.outerHTML.slice(0, 1600);
                  })(),
                  oursGlyph: (function () {
                    var g = document.querySelector(".dshLiveGlyph");
                    if (g === null || g === undefined) return null;
                    var s = g.querySelector("svg");
                    if (s === null || s === undefined) return null;
                    var gr = g.getBoundingClientRect();
                    var sr = s.getBoundingClientRect();
                    var gs = window.getComputedStyle(g);
                    var ss = window.getComputedStyle(s);
                    return {
                      slot: { left: gr.left, width: gr.width, height: gr.height, cssWidth: gs.width, cssHeight: gs.height, flex: gs.flex },
                      svg: {
                        left: sr.left, width: sr.width, height: sr.height,
                        attrW: s.getAttribute("width"), attrH: s.getAttribute("height"),
                        cssWidth: ss.width, cssHeight: ss.height,
                        transform: ss.transform, zoom: ss.zoom
                      }
                    };
                  })(),
                  hostTitleLeft: (function () {
                    var tt = document.querySelector(".wtg9ga_panelTitle");
                    if (tt === null || tt === undefined) return null;
                    return tt.getBoundingClientRect().left;
                  })(),
                  paint: {
                    ours: tcs === null ? null : { color: tcs.color, background: ccs.backgroundColor },
                    host: { color: cs.color, background: cs.backgroundColor }
                  }
                });
              }
            };
            measure(true);
            // 首帧量不到卡片（默认展开时卡片要等 rowAnchor 才有）就下一帧补量一次，
            // 补量到才去隐藏宿主行 + 把下面的菜单推开
            if (document.querySelector(".dshLiveRowCard") === null) {
              window.requestAnimationFrame(function () {
                measure(false);
              });
            }
            var schedule = function () {
              if (raf !== 0) return;
              raf = window.requestAnimationFrame(function () {
                raf = 0;
                measure(false);
              });
            };
            var ro = null;
            try {
              ro = new ResizeObserver(schedule);
              ro.observe(row);
            } catch {
              ro = null;
            }
            window.addEventListener("resize", schedule);
            // 侧栏列表一旦能滚动，固定的卡片会跟丢那一行：跟着滚动事件重量一次
            var scrollHost = row.parentElement;
            if (scrollHost !== null && scrollHost !== undefined) {
              scrollHost.addEventListener("scroll", schedule, { passive: true });
            }
            return function () {
              if (ro !== null) {
                try {
                  ro.disconnect();
                } catch {
                  // 断开失败无所谓
                }
              }
              window.removeEventListener("resize", schedule);
              if (scrollHost !== null && scrollHost !== undefined) {
                scrollHost.removeEventListener("scroll", schedule);
              }
              if (raf !== 0) {
                window.cancelAnimationFrame(raf);
                raf = 0;
              }
              row.style.marginBottom = "";
              row.style.visibility = "";
            };
          }, [rowExpanded, veilActive]);

          var playing = phase === "playing" || phase === "loading";
          // 展开卡片：宿主那行高度写死 36px，撑不开，所以卡片用 fixed 盖在行上，
          // 再用 margin-bottom 把下面的「自动化任务 / 更多 / 工作区」整体往下推
          var cardStyle = rowAnchor !== null
            ? {
              position: "fixed",
              // 卡片顶对齐宿主那一行的顶：与上一个菜单项的间距就天然是 panelList 的 gap:2px
              top: rowAnchor.top + "px",
              // 灰底画在 padding-box 上（panelRow 有一圈透明 border-inline），所以左右按 inset 内缩
              left: (rowAnchor.left + (rowAnchor.inset || 0)) + "px",
              width: (rowAnchor.width - (rowAnchor.inset || 0) * 2) + "px",
              borderRadius: ((rowAnchor.radius || 0) > 0
                ? Math.max(4, rowAnchor.radius - (rowAnchor.inset || 0))
                : 9) + "px",
              right: "auto",
              bottom: "auto",
              zIndex: 1200,
              // 宿主那一行被隐藏了，visibility 会继承下来，这里必须显式恢复
              visibility: "visible"
            }
            : undefined;
          var card = rowExpanded === true && rowAnchor !== null && covered !== true
            ? h("div", {
              className: "dshLiveRowCard",
              style: cardStyle,
              onPointerDown: hold(),
              onClick: hold()
            },
              h("div", { className: "dshLiveCardHead" },
                h("span", { className: "dshLiveGlyph" },
                  h(GlyphIcon, { phase: phase })
                ),
                h("span", {
                  className: "dshLiveCardTitle",
                  title: label + " · " + voiceName
                },
                  h("span", { className: "dshLiveCardPhase" }, label),
                  h("span", { className: "dshLiveCardVoice" }, " · " + voiceShortOf(state))
                ),
                h("span", { className: "dshLiveCardCount" }, counter),
                h("button", {
                  type: "button",
                  className: "dshLiveCardClose",
                  title: t("act.collapse"),
                  onClick: act(toggleExpand)
                }, h(ChevronIcon, { up: true }))
              ),
              (function () {
                // 歌词区：三行，像 LRC 那样跟着音频走。
                // 后端的块是按 120 字攒的（音频连续、播报不会因为标点断开），
                // 但每块里带了 cues = 每句的起点/时长，所以显示可以按句滚动。
                var cues = (current !== null && current !== undefined && Array.isArray(current.cues)) ? current.cues : [];
                var curText = "";
                var prevLine = "";
                var nextLine = "";
                var idx = state.cueIndex;
                if (cues.length > 0) {
                  if (idx < 0) idx = 0;
                  if (idx > cues.length - 1) idx = cues.length - 1;
                  curText = cues[idx].text || "";
                  prevLine = idx > 0 ? (cues[idx - 1].text || "") : (state.prevText || "");
                  nextLine = idx + 1 < cues.length
                    ? (cues[idx + 1].text || "")
                    : firstSentence(state.nextText || "");
                } else {
                  curText = (current !== null && current !== undefined && current.preview) ? current.preview : "";
                  prevLine = state.prevText || "";
                  nextLine = firstSentence(state.nextText || "");
                }
                var idleText = curText === ""
                  ? idleLabel(state, t)
                  : "";
                // 当前句固定一行、14px（与左侧导航标题同字号）、黑色；
                // 上一句/下一句仍是 12px 灰。长句不再自动缩小折行 —— 折成两行会
                // 把上一句/下一句挤走，改成让它在这条线上向左滚，一句念完正好到句尾。
                var overflow = Math.max(0, curText.length * 14 - 218);
                var scrollable = idleText === "" && overflow > 0;
                // 这句自己要念多久：拿下一句的起点减本句起点，最后一句用整段音频时长兜底
                var cueDur = 0;
                if (scrollable && cues.length > 0) {
                  var t0 = Number(cues[idx].t) || 0;
                  var t1 = idx + 1 < cues.length
                    ? (Number(cues[idx + 1].t) || 0)
                    : (Number(state.duration) || 0);
                  if (t1 > t0) cueDur = t1 - t0;
                }
                // 默认速度 45px/s ≈ 每秒 3.75 个字，眼睛跟得上
                var cycle = overflow / 45;
                // 但念得快时会滚不完（40 字要超过 5s），所以周期不超过本句时长的 95%：
                // 一句念完，文字刚好走到句尾停住。
                if (cueDur > 0 && cycle > cueDur) cycle = Math.max(2, cueDur * 0.95);
                var shiftPx = scrollable ? -Math.round(overflow) : 0;
                var trackText = idleText !== "" ? idleText : curText;
                var planKey = "ly" + (current !== null && current !== undefined ? current.id : "0") + "-" + String(idx);
                if (scrollable) {
                  lyricPlan = { shift: shiftPx, cycle: cycle };
                  lyricPlanKey = planKey;
                } else {
                  lyricPlanKey = planKey;
                }
                return h("div", {
                  className: "dshLiveLyrics",
                  key: planKey,
                  style: { fontSize: "12px" }
                },
                  // 空态（还没开始播）只显示那句提示，别把上一轮的残句挂在上面
                  curText !== "" && prevLine !== ""
                    ? h("div", { className: "dshLiveLyricLine" }, prevLine)
                    : null,
                  h("div", { className: "dshLiveLyricScroll", "data-scroll": scrollable ? "true" : "false" },
                    h("div", {
                      ref: lyricTrackRef,
                      className: "dshLiveLyricTrack" + (idleText === "" ? " dshLiveLyricActive" : " dshLiveLyricIdle"),
                      "data-scroll": scrollable ? "true" : "false"
                    }, trackText)
                  ),
                  curText !== "" && nextLine !== ""
                    ? h("div", { className: "dshLiveLyricLine" }, nextLine)
                    : null
                );
              })(),
              h("div", { className: "dshLiveCardBar" },
                h("div", { className: "dshLiveBarFill", style: { width: percent + "%" } })
              ),
              h("div", { className: "dshLiveCardActions" },
                h("button", {
                  type: "button",
                  className: "dshLiveCardPlay",
                  "data-primary": hasContent ? "true" : "false",
                  title: playing ? t("act.pause") : t("act.play"),
                  onClick: act(togglePlay)
                }, playing ? h(PauseIcon) : h(PlayIcon)),
                h("button", {
                  type: "button",
                  className: "dshLiveCardGhost",
                  title: t("act.stop"),
                  onClick: act(function () {
                    stop();
                  })
                }, h(StopIcon)),
                h("button", {
                  type: "button",
                  className: "dshLiveCardGhost",
                  title: t("act.skip"),
                  onClick: act(function () {
                    skip();
                  })
                }, h(SkipIcon)),
                h("span", { className: "dshLiveCardHint" },
                  state.queue > 0
                    ? t("hint.queueFull", { n: state.queue })
                    : (state.streaming ? t("hint.live") : (phase === "paused" ? t("hint.paused") : ""))
                ),
                h("button", {
                  type: "button",
                  className: "dshLiveCardGhost dshLiveCardSpeak",
                  "data-muted": state.muted === true ? "true" : "false",
                  title: state.muted === true ? t("act.unmute") : t("act.mute"),
                  onClick: act(function () {
                    toggleMute();
                  })
                }, h(WaveIcon, { muted: state.muted === true }))
              )
            )
            : null;
          // 换句才重跑：自己逐帧算位移（不依赖 CSS 过渡/keyframes，实测那两条
          // 在这里都会一步跳到终点）。同一句里 progress 的多次 emit 不会重跑，
          // 所以不会把滚动位置拉回起点。
          react.useEffect(function () {
            var el = lyricTrackRef.current;
            if (el === null || el === undefined) return undefined;
            var plan = lyricPlan;
            var rafId = 0;
            el.style.transition = "none";
            el.style.translate = "0px";
            if (plan === null || plan === undefined) return undefined;
            var t0 = 0;
            var step = function (now) {
              if (t0 === 0) t0 = now;
              var p = plan.cycle > 0 ? (now - t0) / (plan.cycle * 1000) : 1;
              if (p > 1) p = 1;
              el.style.translate = (plan.shift * p).toFixed(1) + "px";
              rafId = p < 1 ? requestAnimationFrame(step) : 0;
            };
            rafId = requestAnimationFrame(step);
            return function () {
              if (rafId) cancelAnimationFrame(rafId);
            };
          }, [lyricPlanKey]);
          return h("span", {
            className: "dshLiveRowBar",
            ref: rowBarRef,
            "data-dock": dockMode,
            "data-expanded": rowExpanded === true ? "true" : "false",
            "aria-label": t("section.title"),
            title: short + " · " + voiceName,
            onPointerDown: hold(),
            onClick: hold()
          },
            h("span", { className: "dshLiveRowTop" },
              h("span", { className: "dshLiveGlyph" },
                h(GlyphIcon, { phase: phase })
              ),
              h("span", { className: "dshLiveRowText" }, t("row.label")),
            h("button", {
              type: "button",
              className: "dshLiveRowBtn",
              "data-primary": hasContent ? "true" : "false",
              title: playing ? t("act.pause") : t("act.play"),
              onClick: act(togglePlay),
              onPointerDown: hold()
            }, playing ? h(PauseIcon) : h(PlayIcon)),
            h("button", {
              type: "button",
              className: "dshLiveRowBtn",
              title: t("act.stop"),
              onClick: act(function () {
                stop();
              }),
              onPointerDown: hold()
            }, h(StopIcon)),
            h("button", {
              type: "button",
              className: "dshLiveRowBtn",
              title: t("act.skip"),
              onClick: act(function () {
                skip();
              }),
              onPointerDown: hold()
            }, h(SkipIcon)),
            h("button", {
              type: "button",
              className: "dshLiveRowBtn dshLiveRowMute",
              "data-muted": state.muted === true ? "true" : "false",
              title: state.muted === true ? t("act.unmute") : t("act.mute"),
              onClick: act(function () {
                toggleMute();
              }),
              onPointerDown: hold()
            }, h(WaveIcon, { muted: state.muted === true })),
            h("button", {
              type: "button",
              className: "dshLiveRowBtn dshLiveRowToggle",
              title: rowExpanded === true ? t("act.collapse") : t("act.expand"),
              onClick: act(toggleExpand),
              onPointerDown: hold()
              }, h(ChevronIcon, { up: rowExpanded === true }))
            ),
            card
          );
        }

        /**
         * 会话标题栏那一行：只放内联播放条（选了顶栏时），不再单挂喇叭按钮。
         * 选「左侧导航栏」时这一份必须整体退出，否则顶栏和侧栏会同时出现两个播放条。
         */
        function HeaderCluster() {
          var pair = useManager();
          var dockMode = (pair[0].settings && pair[0].settings.dock) || "top";
          if (dockMode !== "top") return null;
          return h(Dock, { mode: "top", oneLine: true });
        }

        // ── 悬浮播放条 ──────────────────────────────────────────────────
        function Dock(props) {
          var oneLine = props !== null && props !== undefined && props.oneLine === true;
          var pair = useManager();
          var state = pair[0];
          var force = pair[1];
          // 由 SidebarRow 显式指定形态时（宿主的其它槽实测不产 DOM），按 props 渲染
          var forcedMode = (props !== null && props !== undefined && props.mode) ? String(props.mode) : "";
          var dockMode = forcedMode !== "" ? forcedMode : ((state.settings && state.settings.dock) || "top");

          // 播完之后留 2.6 秒再收起：这个定时器保证它真的会消失
          react.useEffect(function () {
            if (state.finishedAt === 0) return undefined;
            var timer = setTimeout(force, 2700);
            return function () {
              clearTimeout(timer);
            };
          }, [state.finishedAt, force]);

          /**
           * 左侧栏形态要钉在「更多」这一项下面的固定位置。
           * DSH 没有能把元件插进侧栏菜单序列的槽位（sidebar 槽位整栏由工作区列表
           * 占用），所以这里实测菜单项的位置，再用 fixed 贴到它下方。
           */
          var anchorState = react.useState(null);
          var anchor = anchorState[0];
          var setAnchor = anchorState[1];
          react.useEffect(function () {
            if (oneLine === true || dockMode !== "sidebar") return undefined;
            var raf = 0;
            var measure = function () {
              var sideWidth = 0;
              try {
                sideWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dsh-windows-sidebar-width")) || 0;
              } catch (e) {
                sideWidth = 0;
              }
              var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              var node = walker.nextNode();
              var moreRect = null;
              var workRect = null;
              while (node !== null && (moreRect === null || workRect === null)) {
                var raw = (node.nodeValue || "").trim();
                var hit = raw === "更多" ? "more" : (raw === "工作区" ? "work" : "");
                if (hit !== "") {
                  var el = node.parentElement;
                  if (el !== null) {
                    var rect = el.getBoundingClientRect();
                    // 只认左侧栏那一块，避开正文里同样出现的字
                    if (rect.width > 0 && rect.height > 0 && rect.left < 360) {
                      if (hit === "more" && moreRect === null) moreRect = rect;
                      if (hit === "work" && workRect === null) workRect = rect;
                    }
                  }
                }
                node = walker.nextNode();
              }
              if (moreRect === null) {
                setAnchor(null);
                return;
              }
              var boxWidth = sideWidth > 120 ? sideWidth : 248;
              // 紧凑条高度固定：内容 18 + 上下内边距 3*2 + 边框 2
              var barHeight = 26;
              var top = Math.round(moreRect.bottom + 6);
              // 「工作区」那一行右侧有添加按钮，播放条不能和它同一水平线
              if (workRect !== null) {
                var limit = Math.round(workRect.top - barHeight - 4);
                if (limit < top) top = Math.max(Math.round(moreRect.bottom + 2), limit);
              }
              var next = {
                top: top,
                // 左边缘跟侧栏内边距对齐（12px），宽度铺满侧栏可用宽度
                left: 12,
                width: Math.round(Math.max(200, boxWidth - 24))
              };
              setAnchor(function (prev) {
                if (prev !== null && prev.top === next.top && prev.left === next.left && prev.width === next.width) return prev;
                return next;
              });
            };
            var schedule = function () {
              if (raf !== 0) return;
              raf = requestAnimationFrame(function () {
                raf = 0;
                measure();
              });
            };
            schedule();
            window.addEventListener("resize", schedule);
            // 侧栏折叠 / 展开不会触发 resize，用慢轮询兜底
            var timer = setInterval(schedule, 2500);
            return function () {
              window.removeEventListener("resize", schedule);
              clearInterval(timer);
              if (raf !== 0) cancelAnimationFrame(raf);
            };
          }, [oneLine, dockMode]);

          // 顶栏形态常驻（它就是播报入口）；浮动形态播报中/刚播完才出现
          var visible = oneLine === true || forcedMode !== "" || state.phase !== "idle" || state.streaming === true || (state.finishedAt > 0 && Date.now() - state.finishedAt < 2600) || state.error !== "";
          if (!visible) return null;

          var current = state.current;
          var phase = state.phase;
          var percent = state.duration > 0 ? Math.min(100, Math.max(0, (state.progress / state.duration) * 100)) : 0;
          var label = phase === "loading"
            ? t("phase.loading")
            : phase === "playing"
              ? t("phase.playing")
              : phase === "paused"
                ? t("phase.paused")
                : phase === "blocked"
                  ? t("phase.blocked")
                  : state.streaming
                    ? t("phase.generating")
                    : (phase === "idle" ? t("phase.idle") : t("phase.done"));
          var text = current !== null && current.preview
            ? current.preview
            : idleLabel(state, t);
          var total = state.total > 0 ? state.total : 0;
          var index = state.index > 0 ? state.index : 1;
          // 与侧栏行同一口径：只有真在播 / 暂停 / 加载，或队列里还有待播，播放键才是品牌蓝
          var hasContent = phase === "playing" || phase === "loading" || phase === "paused"
            || state.queue > 0;
          // 实时播报一句一段，1/1 没意义；多段时仍然显示进度
          var counter = total > 1 ? index + "/" + total : (state.queue > 0 ? "+" + state.queue : "");

          // 浮层在 shell.overlay 里，click 有可能被上层吃掉：pointerdown 和 click 都挂上，谁先到算谁。
          var togglePlay = function () {
            var act = (phase === "playing" || phase === "loading") ? "pause" : "resume";
            post("/debug", { what: "dock-click", action: act });
            if (act === "pause") pause();
            else resume();
          };
          var doStop = function () {
            post("/debug", { what: "dock-click", action: "stop" });
            stop();
          };
          var doSkip = function () {
            post("/debug", { what: "dock-click", action: "skip" });
            skip();
          };
          // 展开的卡片里那个 × 只收起卡片，不停播
          var closeDock = function () {
            post("/debug", { what: "row-close", expanded: rowExpanded });
            if (rowExpanded === true) {
              // 点卡片上的 × 也是用户手动收起：之后再按"默认展开"设置自动弹开会很烦
              rowExpandedManual = true;
              rowExpanded = false;
              force();
            } else {
              doStop();
            }
          };

          // 形态过滤：只有 SidebarRow 显式指定 mode 时才渲染（宿主其它槽不产 DOM）
          if (forcedMode === "") return null;
          if (forcedMode === "sidebar") return null;
          var dockStyle = dockMode === "sidebar" && anchor !== null
            ? { top: anchor.top + "px", left: anchor.left + "px", width: anchor.width + "px", bottom: "auto" }
            : undefined;
          return h("div", {
            className: "dshLiveDock",
            role: "region",
            "aria-label": t("section.title"),
            "data-dock": dockMode,
            "data-inline": (oneLine === true || dockMode === "sidebar") ? "true" : "false",
            style: dockStyle
          },
            h("div", { className: "dshLiveDockRow" },
              h("span", { className: "dshLiveGlyph" }, h(GlyphIcon, { phase: phase })),
              // 顶栏内联那一份位置太窄：只显示状态词（「等待播报」4 字），不拼声线名，
              // 否则 82px 的槽装不下「等待播报 · 晓晓」而被省略号腰斩。声线名在展开卡片里看。
              h("span", { className: "dshLiveDockLabel" },
                oneLine === true ? label : (label + " · " + voiceNameOf(state))),
              h("span", { className: "dshLiveDockCount" }, counter),
              // 「停止并收起」只在浮卡形态有意义；顶栏内联那一份是常驻入口，
              // 收起后就没有入口能把它点回来，所以这里不渲染 ✕（停止仍由 ■ 承担）
              oneLine === true ? null : h("button", {
                type: "button",
                className: "dshLiveDockClose",
                title: t("act.stopAndClose"),
                "aria-label": t("act.stopAndClose"),
                onPointerDown: fire(closeDock),
                onClick: fire(closeDock)
              }, h(CloseIcon))
            ),
            h("div", { className: "dshLiveDockText" }, text),
            h("div", { className: "dshLiveBar" },
              h("div", { className: "dshLiveBarFill", style: { width: percent + "%" } })
            ),
            h("div", { className: "dshLiveActions" },
              h("button", {
                type: "button",
                className: "dshLivePlay",
                "data-primary": hasContent ? "true" : "false",
                title: (phase === "playing" || phase === "loading") ? t("act.pause") : t("act.play"),
                "aria-label": (phase === "playing" || phase === "loading") ? t("act.pause") : t("act.play"),
                onPointerDown: fire(togglePlay),
                onClick: fire(togglePlay)
              }, (phase === "playing" || phase === "loading") ? h(PauseIcon) : h(PlayIcon)),
              h("button", {
                type: "button",
                className: "dshLiveGhost",
                title: t("act.stop"),
                "aria-label": t("act.stopShort"),
                onPointerDown: fire(doStop),
                onClick: fire(doStop)
              }, h(StopIcon)),
              h("button", {
                type: "button",
                className: "dshLiveGhost",
                title: t("act.skip"),
                "aria-label": t("act.skip"),
                onPointerDown: fire(doSkip),
                onClick: fire(doSkip)
              }, h(SkipIcon)),
              h("span", { className: "dshLiveHint" },
                phase === "blocked"
                  ? t("hint.clickToStart")
                  : (state.queue > 0 ? t("hint.queue", { n: state.queue }) : (phase === "paused" ? t("hint.paused") : (state.streaming ? t("hint.live") : "")))
              ),
              h("button", {
                type: "button",
                className: "dshLiveSpeak",
                "data-muted": state.muted === true ? "true" : "false",
                title: state.muted === true ? t("act.unmute") : t("act.mute"),
                "aria-label": state.muted === true ? t("act.unmute") : t("act.mute"),
                // 只绑 click：pointerdown + click 双绑会把切换执行两次，静音等于没切
                onClick: fire(function () {
                  toggleMute();
                })
              }, h(WaveIcon, { muted: state.muted === true }))
            )
          );
        }

        /**
         * 侧栏「语音播报」那一行点开后，主区域显示的面板。
         * 机制跟插件市场一样：sidebar.panellist 出导航行，main 出面板内容，
         * 两边的 key / id 必须一致，宿主才知道点哪一行开哪个面板。
         */
        function SpeakPanel() {
          var pair = useManager();
          var state = pair[0];
          var phase = state.phase;
          var percent = state.duration > 0 ? Math.min(100, Math.max(0, (state.progress / state.duration) * 100)) : 0;
          var label = phase === "loading"
            ? t("phase.loading")
            : phase === "playing"
              ? t("phase.playing")
              : phase === "paused"
                ? t("phase.paused")
                : phase === "blocked"
                  ? t("phase.blocked")
                  : state.streaming
                    ? t("phase.generating")
                    : (phase === "idle" ? t("phase.idle") : t("phase.done"));
          var current = state.current;
          var text = current !== null && current.preview
            ? current.preview
            : idleLabel(state, t);
          var voiceName = voiceNameOf(state);
          var total = state.total > 0 ? state.total : 0;
          var index = state.index > 0 ? state.index : 1;
          var counter = total > 1 ? index + "/" + total : (state.queue > 0 ? "+" + state.queue : "");
          var togglePlay = function () {
            if (phase === "playing" || phase === "loading") pause();
            else resume();
          };
          return h("div", { className: "dshLivePanel" },
            h("div", { className: "dshLivePanelHead" },
              h("span", { className: "dshLiveDockDot", "data-phase": phase }),
              h("span", { className: "dshLivePanelTitle" }, label + " · " + voiceName),
              h("span", { className: "dshLivePanelCount" }, counter)
            ),
            h("div", { className: "dshLivePanelText" }, text),
            h("div", { className: "dshLiveBar" },
              h("div", { className: "dshLiveBarFill", style: { width: percent + "%" } })
            ),
            h("div", { className: "dshLivePanelActions" },
              h("button", {
                type: "button",
                className: "dshLivePlay",
                title: (phase === "playing" || phase === "loading") ? t("act.pause") : t("act.play"),
                "aria-label": (phase === "playing" || phase === "loading") ? t("act.pause") : t("act.play"),
                onPointerDown: fire(togglePlay),
                onClick: fire(togglePlay)
              }, (phase === "playing" || phase === "loading") ? h(PauseIcon) : h(PlayIcon)),
              h("button", {
                type: "button",
                className: "dshLiveGhost",
                title: t("act.stop"),
                "aria-label": t("act.stopShort"),
                onPointerDown: fire(function () {
                  stop();
                }),
                onClick: fire(function () {
                  stop();
                })
              }, h(StopIcon)),
              h("button", {
                type: "button",
                className: "dshLiveGhost",
                title: t("act.skip"),
                "aria-label": t("act.skip"),
                onPointerDown: fire(function () {
                  skip();
                }),
                onClick: fire(function () {
                  skip();
                })
              }, h(SkipIcon)),
              h("button", {
                type: "button",
                className: "dshLiveSpeak",
                "data-muted": state.muted === true ? "true" : "false",
                title: state.muted === true ? t("act.unmute") : t("act.mute"),
                "aria-label": state.muted === true ? t("act.unmute") : t("act.mute"),
                // 只绑 click：pointerdown + click 双绑会把切换执行两次，静音等于没切
                onClick: fire(function () {
                  toggleMute();
                })
              }, h(WaveIcon, { muted: state.muted === true })),
              h("span", { className: "dshLivePanelHint" },
                state.queue > 0
                  ? t("hint.queueFull", { n: state.queue })
                  : (state.streaming ? t("hint.livePause") : t("hint.idle"))
              )
            ),
            h("div", { className: "dshLivePanelFoot" }, t("panel.foot"))
          );
        }

        // ── 设置面板（挂在设置页里，一个分区）─────────────────────────
        /**
         * 设置页左侧导航的图标：形状照插件图标（圆角方块 + 声波条），
         * 但只用 currentColor，所以浅色主题下是深色块、深色主题下是浅色块，
         * 第三方皮肤换文字色时也自动跟着走。
         */
        function SettingsIcon(props) {
          var size = props !== null && props !== undefined && Number.isFinite(props.size) ? props.size : 16;
          return h("svg", {
            viewBox: "0 0 16 16",
            width: size,
            height: size,
            "aria-hidden": "true",
            style: { display: "block", fill: "currentColor" }
          },
            // 与侧栏行、卡片标题同一套：四根块状声波（柱宽 2.0、rx 1.0、步距 3.4；左右边界 1.96→14.16、底部 14.16，与宿主九格同边界）
            h("rect", { x: 1.96, y: 7.76, width: 2, height: 6.4, rx: 1 }),
            h("rect", { x: 5.36, y: 2.76, width: 2, height: 11.4, rx: 1 }),
            h("rect", { x: 8.76, y: 5.76, width: 2, height: 8.4, rx: 1 }),
            h("rect", { x: 12.16, y: 9.76, width: 2, height: 4.4, rx: 1 })
          );
        }

        function SettingsRow(props) {
          return h("div", { className: "dshLiveRow" },
            h("div", { className: "dshLiveRowMain" },
              h("strong", {}, props.title),
              props.hint ? h("span", { className: "dshLiveRowHint" }, props.hint) : null
            ),
            props.children
          );
        }

        function SettingsSwitch(props) {
          var toggle = fire(function () {
            props.onChange(!props.on);
          });
          return h("button", {
            type: "button",
            className: "dshLiveSwitch",
            "data-on": props.on ? "true" : "false",
            "aria-pressed": props.on ? "true" : "false",
            "aria-label": props.label,
            onPointerDown: toggle,
            onClick: toggle
          });
        }

        /** 位置卡片里的小示意图：画出导航栏、顶栏和播放条落在哪。 */
        function SettingsThumb(kind) {
          var chip = kind === "top"
            ? { left: "58%", right: "6%", top: "30%", height: "38%" }
            : kind === "sidebar"
              ? { left: "4%", width: "18%", bottom: "8%", height: "38%" }
              : { right: "8%", bottom: "8%", width: "38%", height: "32%" };
          return h("div", { className: "dshLiveDockThumb" },
            h("div", { className: "dshLiveDockThumbNav" }),
            h("div", { className: "dshLiveDockThumbBar" }),
            h("div", { className: "dshLiveDockThumbChip", style: chip })
          );
        }

        function SettingsPanel() {
          var view = useManager();
          var state = view[0];
          var settings = state.settings || {};
          // 播放条位置只保留两种形态：顶栏（嵌进标题栏 actions）/ 左侧导航栏（占有导航行）
          var dock = settings.dock === "top" ? "top" : "sidebar";
          var voices = manager.voices || [];
          // 本机声线清单由宿主探测后下发（三端统一结构：name / id / lang / engine）
          var localVoices = Array.isArray(settings.localVoices) ? settings.localVoices : [];
          var rateValue = parseInt(String(settings.rate || "+0%").replace(/[^0-9-]/gu, ""), 10) || 0;
          var volumePercent = Math.round((settings.playbackVolume || 0.9) * 100);
          // 均衡器当前值：宿主没给或不合法时按全 0（等于不做任何增益）
          var eqValues = (Array.isArray(settings.eq) && settings.eq.length === EQ_BANDS.length)
            ? settings.eq.map(function (v) { var n = Number(v); return Number.isFinite(n) ? n : 0; })
            : EQ_BANDS.map(function () { return 0; });
          // 从数值反推当前是哪个预设，对不上任何一个就是「自定义」
          var eqPresetName = (function () {
            for (var pi = 0; pi < EQ_PRESETS.length; pi += 1) {
              var preset = EQ_PRESETS[pi];
              var same = true;
              for (var pj = 0; pj < eqValues.length; pj += 1) {
                if (Number(preset.eq[pj]) !== Number(eqValues[pj])) { same = false; break; }
              }
              if (same) return preset.id;
            }
            return "custom";
          })();

          function save(patch) {
            // 切换要"立刻"看得见：先本地合并并广播一次重渲染，再交给宿主落盘。
            // 只 POST 不说话的话，得等下一次 600ms 轮询，看起来像"点了不生效"。
            manager.settings = Object.assign({}, manager.settings || {}, patch);
            if (patch.eq !== undefined) applyEq(patch.eq);
            emit();
            if (patch.dock !== undefined) post("/debug", { what: "dock-set", dock: String(patch.dock) });
            post("/settings", patch);
          }

          function setEqValues(next) {
            save({ eq: next.slice() });
          }

          function setEqPreset(name) {
            var preset = null;
            for (var ei = 0; ei < EQ_PRESETS.length; ei += 1) {
              if (EQ_PRESETS[ei].id === name) { preset = EQ_PRESETS[ei]; break; }
            }
            if (preset === null) return;
            save({ eq: preset.eq.slice() });
          }

          var dockOptions = [
            ["top", t("settings.dock.top"), t("settings.dock.top.hint")],
            ["sidebar", t("settings.dock.sidebar"), t("settings.dock.sidebar.hint")]
          ];

          // 播报引擎二选一：线上（Edge 神经声线，失败自动切本地）/ 本地（系统自带声线，零网络零安装）。
          // 数据层仍保留 auto 这一档，做老配置兼容：除 local 之外一律按「线上」显示。
          var engineMode = settings.ttsEngine === "local" ? "local" : "online";
          var engineOptions = [
            ["online", t("settings.engine.online"), t("settings.engine.online.hint")],
            ["local", t("settings.engine.local"), t("settings.engine.local.hint")]
          ];

          return h("div", { className: "dshLiveSettings" },
            h("div", { className: "dshLiveSettingsGroup" },
              h("div", { className: "dshLiveSettingsGroupTitle" }, t("settings.group.behavior")),
              h("div", { className: "dshLiveSettingsCard" },
                h(SettingsRow, { title: t("settings.auto"), hint: t("settings.auto.hint") },
                  h(SettingsSwitch, {
                    on: state.auto === true,
                    label: t("settings.auto"),
                    onChange: function (next) {
                      // 服务端 /auto 读的是 body.auto（原来这里传 on，字段对不上，
                      // 开关点了等于没点），统一走 setAuto 顺带做本地乐观更新。
                      setAuto(next);
                    }
                  })
                ),
                h(SettingsRow, { title: t("settings.realtime"), hint: t("settings.realtime.hint") },
                  h(SettingsSwitch, {
                    on: settings.realtime !== false,
                    label: t("settings.realtime"),
                    onChange: function (next) {
                      save({ realtime: next });
                    }
                  })
                ),
                h(SettingsRow, { title: t("settings.interrupt"), hint: t("settings.interrupt.hint") },
                  h(SettingsSwitch, {
                    on: settings.interruptOnNew !== false,
                    label: t("settings.interrupt"),
                    onChange: function (next) {
                      save({ interruptOnNew: next });
                    }
                  })
                ),
                h(SettingsRow, { title: t("settings.codeQuiet"), hint: t("settings.codeQuiet.hint") },
                  h(SettingsSwitch, {
                    on: settings.codeQuiet !== false,
                    label: t("settings.codeQuiet"),
                    onChange: function (next) {
                      save({ codeQuiet: next });
                    }
                  })
                ),
                h(SettingsRow, { title: t("settings.dockExpanded"), hint: t("settings.dockExpanded.hint") },
                  h(SettingsSwitch, {
                    on: settings.dockExpanded === true,
                    label: t("settings.dockExpanded"),
                    onChange: function (next) {
                      // 这个开关直接管侧栏卡片开局是不是展开的：改完要把"用户手动开合过"
                      // 的标记清掉，否则设置说展开、界面还是收着，等于点了没反应。
                      rowExpandedManual = false;
                      rowExpanded = next === true;
                      save({ dockExpanded: next });
                    }
                  })
                )
              )
            ),

            h("div", { className: "dshLiveSettingsGroup" },
              h("div", { className: "dshLiveSettingsGroupTitle" }, t("settings.group.position")),
              h("div", { className: "dshLiveSettingsCard" },
                h("div", { className: "dshLiveDockPicker" },
                  dockOptions.map(function (option) {
                    var pick = fire(function () {
                      save({ dock: option[0] });
                    });
                    return h("button", {
                      type: "button",
                      key: option[0],
                      className: "dshLiveDockOption",
                      "data-active": dock === option[0] ? "true" : "false",
                      "aria-pressed": dock === option[0] ? "true" : "false",
                      onPointerDown: pick,
                      onClick: pick
                    },
                      SettingsThumb(option[0]),
                      h("span", { className: "dshLiveDockOptionName" }, option[1]),
                      h("span", { className: "dshLiveDockOptionHint" }, option[2])
                    );
                  })
                )
              )
            ),

            h("div", { className: "dshLiveSettingsGroup" },
              h("div", { className: "dshLiveSettingsGroupTitle" }, t("settings.group.engine")),
              h("div", { className: "dshLiveSettingsCard" },
                h("div", { className: "dshLiveDockPicker" },
                  engineOptions.map(function (option) {
                    var pick = fire(function () {
                      // 「线上」就是纯线上：只用神经声线，绝不悄悄换成系统声线
                      save({ ttsEngine: option[0] === "local" ? "local" : "edge" });
                    });
                    return h("button", {
                      type: "button",
                      key: option[0],
                      className: "dshLiveDockOption dshLiveEngineOption",
                      "data-active": engineMode === option[0] ? "true" : "false",
                      "aria-pressed": engineMode === option[0] ? "true" : "false",
                      onPointerDown: pick,
                      onClick: pick
                    },
                      h("span", { className: "dshLiveDockOptionName" }, option[1]),
                      h("span", { className: "dshLiveDockOptionHint" }, option[2])
                    );
                  })
                )
              )
            ),

            h("div", { className: "dshLiveSettingsGroup" },
              h("div", { className: "dshLiveSettingsGroupTitle" }, t("settings.group.voice")),
              h("div", { className: "dshLiveSettingsCard" },
                // 本地引擎念的是系统声线：本机有几条就列几条，让用户自己挑，
                // 装了新语音包点右边「重新检测」立刻重探（宿主那边缓存 5 分钟）。
                h(SettingsRow, {
                  title: t("settings.voice"),
                  hint: engineMode === "local" ? t("settings.voice.localHint") : t("settings.voice.hint")
                },
                  engineMode === "local"
                    ? h("div", { className: "dshLiveVoicePick" },
                        h("select", {
                          className: "dshLiveSelect",
                          value: settings.localVoice || "",
                          onChange: function (event) {
                            save({ localVoice: event.target.value });
                          }
                        },
                          localVoices.length === 0
                            ? h("option", { value: "" }, t("settings.voice.localNone"))
                            : localVoices.map(function (item, index) {
                                // 宿主给的是系统里的原始名（Microsoft Yaoyao Desktop 这种），
                                // 只去掉微软前缀；「Desktop」后缀必须留着——同名的 WinRT 版和
                                // SAPI 版会成对出现（Huihui / Huihui Desktop），剥掉就变成两条
                                // 一模一样、用户分不清选哪条的选项
                                var name = String(item.name || "").replace(/^Microsoft\s+/i, "") || String(item.name || "");
                                var tag = item.lang ? " · " + item.lang : "";
                                // key 用「位置+名字」：同名条目并存时 React 才不会把两条并成一条
                                return h("option", { key: index + ":" + item.name, value: item.name }, name + tag);
                              })
                        ),
                        h("button", {
                          type: "button",
                          className: "dshLiveTestBtn dshLiveVoiceRefresh",
                          onPointerDown: fire(function () {
                            post("/local-voices", {}).then(function () { poll(); }).catch(function () {});
                          }),
                          onClick: fire(function () {
                            post("/local-voices", {}).then(function () { poll(); }).catch(function () {});
                          })
                        }, t("settings.voice.refresh"))
                      )
                    : h("select", {
                        className: "dshLiveSelect",
                        value: settings.voice || "",
                        onChange: function (event) {
                          save({ voice: event.target.value });
                        }
                      },
                        voices.map(function (voice) {
                          // 宿主只给中文标签；非中文界面用插件自己带的英文名（声线本身都是英文 id）
                          var name = UI_LANG === "zh" || !voice.labelEn ? voice.label : voice.labelEn;
                          return h("option", { key: voice.id, value: voice.id }, name);
                        })
                      )
                ),
                h(SettingsRow, { title: t("settings.rate"), hint: t("settings.rate.hint") },
                  h("input", {
                    type: "range",
                    className: "dshLiveRange",
                    min: -50,
                    max: 100,
                    step: 5,
                    value: rateValue,
                    onChange: function (event) {
                      var next = Number(event.target.value);
                      save({ rate: (next >= 0 ? "+" : "") + next + "%" });
                    }
                  }),
                  h("span", { className: "dshLiveValue" }, settings.rate || "+0%")
                ),
                h(SettingsRow, { title: t("settings.chunk"), hint: t("settings.chunk.hint") },
                  h("input", {
                    type: "range",
                    className: "dshLiveRange",
                    min: 40,
                    max: 300,
                    step: 20,
                    value: Number(settings.targetChars) || 120,
                    onChange: function (event) {
                      save({ targetChars: Number(event.target.value) });
                    }
                  }),
                  h("span", { className: "dshLiveValue" }, (Number(settings.targetChars) || 120) + " " + t("settings.chunk.unit"))
                ),
                h(SettingsRow, { title: t("settings.volume"), hint: t("settings.volume.hint") },
                  h("input", {
                    type: "range",
                    className: "dshLiveRange",
                    min: 0,
                    max: 100,
                    step: 5,
                    value: volumePercent,
                    onChange: function (event) {
                      save({ playbackVolume: Number(event.target.value) / 100 });
                    }
                  }),
                  h("span", { className: "dshLiveValue" }, volumePercent + "%")
                ),
                h(SettingsRow, { title: t("settings.preview"), hint: t("settings.preview.hint") },
                  h("button", {
                    type: "button",
                    className: "dshLiveTestBtn",
                    onPointerDown: fire(function () {
                      post("/speak", { text: settings.previewText || t("preview.default") });
                    }),
                    onClick: fire(function () {
                      post("/speak", { text: settings.previewText || t("preview.default") });
                    })
                  }, t("settings.preview.btn"))
                )
              )
            ),

            h("div", { className: "dshLiveSettingsGroup" },
              h("div", { className: "dshLiveSettingsGroupTitle" }, t("settings.group.eq")),
              h("div", { className: "dshLiveSettingsCard" },
                h("div", { className: "dshLiveEqHead" },
                  h("select", {
                    className: "dshLiveSelect dshLiveEqPreset",
                    value: eqPresetName,
                    onChange: function (event) {
                      setEqPreset(event.target.value);
                    }
                  },
                    eqPresetName === "custom" ? h("option", { value: "custom" }, t("settings.eq.custom")) : null,
                    EQ_PRESETS.map(function (preset) {
                      return h("option", { key: preset.id, value: preset.id }, t(preset.label));
                    })
                  ),
                  h("button", {
                    type: "button",
                    className: "dshLiveTestBtn dshLiveEqReset",
                    onPointerDown: fire(function () { setEqPreset("flat"); }),
                    onClick: fire(function () { setEqPreset("flat"); })
                  }, t("settings.eq.reset"))
                ),
                h("div", { className: "dshLiveEqBands" },
                  EQ_BANDS.map(function (freq, band) {
                    var value = Number(eqValues[band]) || 0;
                    return h("div", { className: "dshLiveEqBand", key: freq },
                      h("input", {
                        type: "range",
                        className: "dshLiveEqSlider",
                        min: -12,
                        max: 12,
                        step: 1,
                        value: value,
                        "aria-label": EQ_BAND_LABELS[band] + "Hz",
                        onChange: function (event) {
                          var next = eqValues.slice();
                          next[band] = Number(event.target.value);
                          setEqValues(next);
                        }
                      }),
                      h("span", { className: "dshLiveEqFreq" }, EQ_BAND_LABELS[band]),
                      h("span", { className: "dshLiveEqDb" }, (value > 0 ? "+" : "") + value)
                    );
                  })
                ),
                h("div", { className: "dshLiveEqHint" }, t("settings.eq.hint"))
              )
            )
          );
        }

        // ── apply ───────────────────────────────────────────────────────
        var inject = ["slots", "locale", "uiConversation"];

        function apply(ctx) {
          // 语言跟随：挂载时先读一次当前语言，之后每次切换都重新渲染一次界面
          UI_LANG = readLang(ctx) || "zh";
          post("/debug", { what: "locale", lang: UI_LANG });
          try {
            if (ctx.locale && typeof ctx.locale.register === "function") {
              ctx.locale.register("edgespeak", { zh: TEXT.zh, en: TEXT.en, ja: TEXT.ja });
            }
          } catch {
            // locale 不可用时就只靠本地字典
          }
          try {
            if (ctx.locale && typeof ctx.locale.subscribe === "function") {
              ctx.effect(function () {
                return ctx.locale.subscribe(function () {
                  var next = readLang(ctx) || UI_LANG;
                  if (next === UI_LANG) return;
                  UI_LANG = next;
                  post("/debug", { what: "locale", lang: UI_LANG });
                  // 侧栏行、浮条、设置面板都靠 manager 的订阅重渲染
                  emit();
                });
              }, "live-speak: locale");
            }
          } catch {
            // 订阅不上就保持挂载时的语言
          }

          startPolling();
          // 等首轮 state 落地后再补一条打点：确认声线表拿到了（否则声线名会退回中文）
          setTimeout(function () {
            post("/debug", { what: "locale", lang: UI_LANG, voices: (manager.voices || []).length });
          }, 3000);

          // ── 实时播报：边生成边攒句 ──────────────────────────────────
          // DSH 的逐字增量是 client-only 的 assistant/live-chunk（宿主收不到），
          // 这里订阅它：边收边按标点切句，凑够一句立刻送宿主合成，合成好就播。
          // 不用等整段回复写完才开始念。
          var RE_END = /[。！？；…!?\n]/;
          var RE_SOFT = /[，,、：:]/;
          var stream = { attempt: null, buffer: "", skipBlock: false, sentAttempt: null, firstDone: false };

          function streamEnabled() {
            var settings = manager.settings || {};
            // 自动播报关掉时也不该有声音；实时开关关掉时退回整段播报
            return manager.auto === true && settings.realtime !== false;
          }

          function streamSend(piece) {
            var text = String(piece || "").trim();
            if (text === "") return;
            // 同一条回复里是追加；换了回复就打断旧的
            var append = stream.sentAttempt === stream.attempt;
            stream.sentAttempt = stream.attempt;
            post("/speak", {
              text: text,
              append: append,
              live: true,
              attemptId: stream.attempt
            });
          }

          function streamCut(force) {
            var guard = 0;
            while (stream.buffer.length > 0 && guard < 40) {
              guard += 1;
              // 首句门槛 140 字：这一段能播 26 秒左右，要覆盖的是「模型把整篇吐完的时间
              // ＋ 主文首段在 Edge 排队里的合成时间」，实测这两项加起来 20~30 秒，80 字
              // （16 秒）顶不住，开头会空十几秒；之后再按「段落字数」这个设置值切。
              var need = stream.firstDone ? Math.max(40, Number(settings.targetChars) || 120) : 140;
              var cut = 0;
              var i = 0;
              for (i = 0; i < stream.buffer.length; i += 1) {
                if (RE_END.test(stream.buffer.charAt(i)) && i + 1 >= need) {
                  cut = i + 1;
                  break;
                }
              }
              if (cut === 0) {
                // 没遇到够长的句号就继续攒；攒够 need 字还全是逗号，就在最后一个逗号处硬切。
                // 这里的上限必须跟着 need 走——写死 90 会在门槛 140 时提前软切，门槛形同虚设。
                if (stream.buffer.length < need) break;
                var soft = 0;
                for (i = 0; i < stream.buffer.length; i += 1) {
                  if (RE_SOFT.test(stream.buffer.charAt(i))) soft = i + 1;
                }
                cut = soft > 20 ? soft : need;
              }
              var head = stream.buffer.slice(0, cut);
              stream.buffer = stream.buffer.slice(cut);
              if (head.replace(/\s+/g, "").length >= 2) streamSend(head);
              stream.firstDone = true;
            }
            if (force && stream.buffer.replace(/\s+/g, "").length >= 2) {
              streamSend(stream.buffer);
              stream.buffer = "";
              stream.firstDone = true;
            }
          }

          function onLiveChunk(event) {
            try {
              var data = (event && event.data) || {};
              var chunk = data.chunk;
              if (!chunk) return;
              // 逐条增量打点已删除：一篇长文能写出九百多行、把日志迅速撑到轮转，
              // 反而挤掉了真正要查的 enqueue / synth / play 记录。排查看 block-type。
              manager.streamingAt = Date.now();
              if (manager.streaming !== true) {
                manager.streaming = true;
                emit();
              }
              if (stream.attempt !== data.attemptId) {
                // 换了一条回复：上一条没念完的尾巴直接丢掉，别串到新内容里
                stream.attempt = data.attemptId;
                stream.buffer = "";
                stream.skipBlock = false;
                stream.firstDone = false;
              }
              if (!streamEnabled()) return;
              if (chunk.type === "block-start") {
                // 换块之前先把攒着的尾巴念掉：代码块前面那半句本来已经生成了，
                // 直接清 buffer 会把它永久丢掉（实测「下箭头键：下落方块」之后就没下文）
                streamCut(true);
                var blockType = String(chunk.blockType || "text").toLowerCase();
                // 只跳明确不该念的块；未知类型一律当正文念。
                // 用白名单挡会把宿主将来新增的块类型整段吞掉，静默失声很难查。
                stream.skipBlock = blockType.indexOf("code") >= 0
                  || blockType.indexOf("table") >= 0
                  || blockType.indexOf("chart") >= 0
                  || blockType.indexOf("image") >= 0
                  || blockType.indexOf("tool") >= 0
                  || blockType.indexOf("reason") >= 0;
                if (stream.reported !== blockType) {
                  stream.reported = blockType;
                  // 工具名要一起上报：静音模式的第二个触发点就是 tool-call 块，
                  // 但"读文件/搜资料"和"写文件"是两回事，只靠块类型会把纯文本回复也静音掉。
                  var toolName = "";
                  var chunkKeys = Object.keys(chunk);
                  if (typeof chunk.name === "string") toolName = chunk.name;
                  else if (typeof chunk.toolName === "string") toolName = chunk.toolName;
                  else if (chunk.tool !== null && chunk.tool !== undefined && typeof chunk.tool === "object" && typeof chunk.tool.name === "string") toolName = chunk.tool.name;
                  post("/debug", { what: "block-type", type: blockType, skip: stream.skipBlock === true, name: toolName, keys: chunkKeys.join(",") });
                }
                return;
              }
              if (chunk.type === "text-delta") {
                if (stream.skipBlock) return;
                stream.buffer += String(chunk.text || "");
                streamCut(false);
                return;
              }
              if (chunk.type === "block-end") {
                streamCut(true);
                stream.skipBlock = false;
                return;
              }
            } catch {
              // 增量处理出错绝不能影响界面
            }
          }

          var disposeStream = null;
          try {
            var ui = ctx.uiConversation;
            if (ui && ui.events && typeof ui.events.register === "function") {
              disposeStream = ui.events.register({
                kind: "live-speak-stream",
                match: { "assistant/live-chunk": onLiveChunk }
              });
              post("/debug", { what: "realtime-ready" });
            } else {
              post("/debug", { what: "no-uiConversation", hasUi: ui !== undefined && ui !== null });
            }
          } catch (error) {
            post("/debug", { what: "realtime-error", message: String((error && error.message) || error) });
          }

          try {
            if (ctx.slots && typeof ctx.slots.inject === "function") {
              // 设置页里的一个分区：位置 / 声线 / 语速 / 音量 / 开关都在这儿改
              ctx.slots.inject("settings.section", function () {
                try {
                  return ctx.slots.register({
                    name: "settings.section",
                    id: "live-speak",
                    order: 40,
                    locale: "edgespeak",
                    label: function () {
                      return t("section.title");
                    }
                  }, SettingsPanel);
                } catch {
                  // 设置页没加载也不影响播报本身
                }
              });
              // 导航行图标：id 必须和分区 id 一致，否则会被回退成齿轮
              ctx.slots.inject("settings.section.icon", function () {
                try {
                  var iconHandle = ctx.slots.register({
                    name: "settings.section.icon",
                    id: "live-speak",
                    order: 40,
                    label: function () {
                      return t("section.title");
                    }
                  }, SettingsIcon);
                  post("/debug", { what: "settings-icon-ok" });
                  return iconHandle;
                } catch (iconError) {
                  post("/debug", { what: "settings-icon-fail", message: String(iconError && iconError.message || iconError) });
                }
              });
              // 「顶栏」形态真正嵌在会话标题栏右侧的 actions 槽里
              ctx.slots.inject("conversation.session.header.actions", function () {
                try {
                  return ctx.slots.register({
                    name: "conversation.session.header.actions",
                    id: "live-speak-toggle",
                    order: 92,
                    locale: "edgespeak"
                  }, HeaderCluster);
                } catch {
                  // 单个 slot 失败不影响其他
                }
              });
              // 输入框上方那行不再挂内容（顶栏由标题栏 actions 槽承接）
              // 右下角浮动卡片形态已取消（用户要求不再有浮动播放条），
              // shell.overlay 槽不再注册，避免凭空多出一份播放条。
              // 侧栏导航行：和插件市场用的是同一个槽位，真正由宿主排版占位
              ctx.slots.inject("sidebar.panellist", function () {
                try {
                  return ctx.slots.register({
                    name: "sidebar.panellist",
                    id: LIVE_PANEL_ID,
                    // 与插件市场共用 sidebar.panellist 段（市场是 1）。宿主「自动化任务」
                    // 的 order 明显更大，取 100 才能跨到它后面、又在「更多」之前
                    order: 100,
                    label: function () {
                      return "";
                    },
                    locale: "edgespeak"
                  }, SidebarRow);
                } catch {
                  // 宿主没提供这个槽位时自动退回浮层形态
                }
              });
              // 不注册 main 面板：点侧栏那一行不会把主区域切走，
              // 播放控制全部留在那一行里
            }
          } catch {
            // slot 结构变了，静默退出 UI（播放器逻辑仍可被命令行触发）
          }

          // 监听宿主遮罩（设置页/对话框），展开卡片遇到它就收起
          try {
            watchHostOverlay();
          } catch {
            // 监听起不来就退化为"卡片一直在"，不影响其它功能
          }

          return function () {
            stopPolling();
            try {
              if (typeof disposeStream === "function") disposeStream();
            } catch {
              // 订阅回收失败不影响卸载
            }
            stop({ notifyHost: false });
            manager.listeners = [];
          };
        }

        exports.apply = apply;
        exports.inject = inject;
        // 方便调试：控制台里可以 __edgeSpeak.stop() 直接停
        exports.manager = manager;
        exports.stop = stop;
        return module.exports;
      }
    });
  } catch {
    // 最外层兜底：加载失败不能让 DSH 主界面崩
  }
})();
