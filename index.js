/**
 * dsh-live-speak — 用高保真神经语音念模型输出，自带播放队列。
 *
 * 与 dsh-big-fish-speak 的根本区别：
 *   - 不依赖 dsh-pet，自己合成、自己排队、自己出声；
 *   - 合成在宿主（Node）侧完成，音频通过 /plugins 路由交给浏览器侧；
 *   - 播放、暂停、恢复、停止全部在浏览器侧（Audio 对象），所以能精确控制。
 *
 * 数据流：
 *   session/event(assistant/message) → 清洗 → 分段 → Edge TTS 合成（串行 + 429 退避）
 *     → ready 队列（内存 Buffer）→ GET /plugins/dsh-live-speak/audio/<id> → 页面播放
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Cordis 里这一行的名字。 */
export const name = 'live-speak'

/** 依赖宿主服务：命令注册与 HTTP 路由。 */
export const inject = ['commands', 'webServer']

const DATA_DIR = path.join(os.homedir(), '.dsh', 'dsh-live-speak')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
const LOG_FILE = path.join(DATA_DIR, 'log.txt')

/** 本插件所有路由的前缀。 */
const ROUTE_PREFIX = '/plugins/dsh-live-speak'

/** ready 队列上限：超过就丢最旧的一段，避免长会话把内存吃满。 */
const MAX_READY = 60
/** ready 项最长保留时间：页面没消费就自己过期。 */
const READY_TTL_MS = 15 * 60 * 1000
/** 单段合成的字数上限（Edge TTS 对长文本会明显变慢）。 */
const MAX_SEGMENT_CHARS = 300
/**
 * 第一段的字数上限。
 *
 * 曾经是 45：为了让第一声尽早出来。但它只播 9~11 秒，几乎是全篇容错窗口最薄的地方——
 * 实测一篇 434 字的文章，首块 45 字播 9.4 秒，第二段 228 字这次 Edge 合成用了 15 秒，
 * 首块播完就空等 5.5 秒，开头直接断。
 *
 * 提到 130：第一声晚 5~6 秒出来，换来开头那段能播 26~30 秒，扛得住一次 8 秒超时加退避。
 * 宁可晚开口，也不能开口之后就断。
 */
const FIRST_CHUNK_CHARS = 130
/**
 * 合成失败的重试次数与基准等待，429 走指数退避。
 *
 * 这一层是"快速自救"：单次 8 秒没数据就算超时，退避 0.9 秒再试一次。
 * 两次都不成，就交给合成泵里那层不放弃的重试（见 pump）。
 * 代价只在失败时：最坏 8 秒超时 + 0.9 秒退避 + 8 秒超时 = 17 秒，仍在一段 60 秒的播报窗口内。
 */
const SYNTH_RETRIES = 2
const SYNTH_RETRY_BASE_MS = 900
/** 不放弃重试的退避上限：一直失败也不会把等待拉到天荒地老，15 秒一次接着试。 */
const SYNTH_RETRY_MAX_MS = 15 * 1000
/** Edge 单次合成「多久没有数据就放弃」：正常 2.5~7 秒，卡住的是 21.5 秒，8 秒足够分辨。 */
const EDGE_TIMEOUT_MS = 8000
/**
 * 单次合成的总时长硬上限（看门狗）。
 *
 * EDGE_TIMEOUT_MS 只管连接/首包——实测把它压到 8 秒，真卡住的那次是 23.4 秒才由
 * WebSocket inactivity 报错，8 秒根本没生效。合成阶段一旦卡死，没有这层就会把整篇
 * 播报永远冻在第一段。正常合成实测 4.5~8.4 秒，20 秒留了两倍余量，超了就当失败重试。
 */
const SYNTH_DEADLINE_MS = 20 * 1000
/** 本地兜底用的 Windows SAPI 声线（老式机器音，作为最后一级兜底）。 */
const LOCAL_VOICE = 'Microsoft Yaoyao'
/** 本地合成的 WAV 落地目录（合成完立刻读回内存并删除）。 */
const LOCAL_AUDIO_DIR = path.join(os.homedir(), '.dsh', 'dsh-live-speak', 'local-audio')
/** 插件自身根目录：ESM 里没有 __dirname，用 import.meta.url 反解。 */
const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url))

/** 三端分派：Windows 走 WinRT/SAPI，macOS 走 say，Linux 走 espeak-ng。 */
const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
const IS_LINUX = process.platform === 'linux'

/**
 * Windows 上调 PowerShell 一律走这个路径，不再让 execFile 按 PATH 去猜。
 *
 * 之前直接写 'powershell.exe'：PATH 被裁剪的环境里（精简启动器、部分终端或
 * 自动化工具拉起的进程，PATH 里可能没有 System32）会直接 ENOENT，探测被
 * catch 成空清单，设置页就显示「未检测到可用声线」——系统里明明装着 Huihui。
 * 面向公众发行时这种机器不少，所以固定用绝对路径，找不到才退回按名查找。
 */
const POWERSHELL_EXE = (() => {
  if (!IS_WIN) return 'powershell.exe'
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const candidates = [
    path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return 'powershell.exe'
})()

/**
 * 用户没指定声线时，按这个顺序挑一条。
 *
 * 前几位是 Windows 11 的「自然语音」——晓晓、晓伊、云希这些神经语音，
 * 音色与 Edge 云端那批同源，但完全在本机推理、不联网、100 毫秒级出音。
 * 它们只能通过 WinRT 的 Windows.Media.SpeechSynthesis 取到；SAPI
 * （System.Speech）那一层看不见它们，这正是早前「本机没有晓晓」误判的来源。
 * 后面三条是 macOS 与 Linux 的中文声线。一个都没命中时，才落到 list[0]。
 */
const LOCAL_VOICE_PREFER = [
  'Xiaoxiao', 'Xiaoyi', 'Yunxi', 'Yunyang', 'Yunjian', 'Yaoyao',
  'Tingting', 'Meijia', 'Sinji', 'Huihui', 'Kangkang',
]
/** 本地声线清单里，语言一律用 BCP-47 风格；这几种都算中文。 */
const RE_ZH_LANG = /^zh|^cmn|^yue|Chinese/i
/** WinRT 脚本落在运行时目录，随插件写出来，不塞进 npm 包体。 */
const WINRT_SYNTH_PS1 = path.join(LOCAL_AUDIO_DIR, 'winrt-synth.ps1')
const WINRT_PROBE_PS1 = path.join(LOCAL_AUDIO_DIR, 'winrt-probe.ps1')
// 同一时刻只有一路合成在途，并且 ready 里最多备 2 段（1 段在播、1 段等播）。
// 300 字一段要播约 60 秒，而合成一段只要 5~10 秒，余量六倍以上，
// "合成下一段"永远赶在"上一段播完"之前。单路顺带解决了两个老问题：
// 并发撞 429，以及两路乱序完成时最小 id 反而最晚落地、把播放口堵住。
const MAX_SYNTH_PARALLEL = 1
/** 合成结果最多领先播放几段。1 = 正在播的那段之后还能备好 1 段。 */
const MAX_SYNTH_LEAD = 2
/*
 * 注意：这里曾经有一个 LIVE_REPLAY_WINDOW_MS = 180_000 的时间窗，用来判断
 * 「实时路径刚刚送过东西，整段落地的消息只补尾巴」。它被删掉了，原因是
 * 写代码/写文件时实时流会断好几分钟（实测 258 秒），窗口一过期就退化成整段重念。
 * 现在一律按文本重合度判定（见 liveOverlap），句柄是 liveSentText 而不是时间。
 */

/** 常用中文/英文声线，避免每次 /edge voice list 都去网上拉列表。 */
const VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声（默认，自然）', labelEn: 'Xiaoxiao · Female (default)' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女声（活泼）', labelEn: 'Xiaoyi · Female' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 男声（温和）', labelEn: 'Yunxi · Male' },
  { id: 'zh-CN-YunjianNeural', label: '云健 · 男声（浑厚）', labelEn: 'Yunjian · Male (deep)' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 男声（新闻播音）', labelEn: 'Yunyang · Male (news)' },
  { id: 'zh-CN-YunxiaNeural', label: '云夏 · 男童声', labelEn: 'Yunxia · Boy' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北话', labelEn: 'Xiaobei · NE accent' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 陕西话', labelEn: 'Xiaoni · Shaanxi' },
  { id: 'zh-HK-HiuMaanNeural', label: '慧敏 · 粤语女声', labelEn: 'HiuMaan · Cantonese F' },
  { id: 'zh-HK-WanLungNeural', label: '云龙 · 粤语男声', labelEn: 'WanLung · Cantonese M' },
  { id: 'zh-TW-HsiaoChenNeural', label: '晓臻 · 台语女声', labelEn: 'HsiaoChen · TW female' },
  { id: 'zh-TW-YunJheNeural', label: '云哲 · 台语男声', labelEn: 'YunJhe · TW male' },
  { id: 'en-US-AriaNeural', label: 'Aria · 美式英语女声', labelEn: 'Aria · US female' },
  { id: 'en-US-GuyNeural', label: 'Guy · 美式英语男声', labelEn: 'Guy · US male' },
  { id: 'en-GB-SoniaNeural', label: 'Sonia · 英式英语女声（伦敦腔）', labelEn: 'Sonia · UK female' },
  { id: 'en-GB-RyanNeural', label: 'Ryan · 英式英语男声（伦敦腔）', labelEn: 'Ryan · UK male' },
  { id: 'en-US-AvaMultilingualNeural', label: 'Ava · 美式女声（能念中文）', labelEn: 'Ava · US F (Chinese)' },
  { id: 'en-US-AndrewMultilingualNeural', label: 'Andrew · 美式男声（能念中文）', labelEn: 'Andrew · US M (Chinese)' },
]

/** 播放条停靠位置的显示名。 */
const DOCK_LABELS = {
  top: '顶栏',
  sidebar: '左侧导航栏',
}

const DEFAULT_SETTINGS = {
  /** 模型输出后是否自动念。 */
  auto: true,
  /** Edge 声线短名。 */
  voice: 'zh-CN-XiaoxiaoNeural',
  /** 语速，Edge 的百分比写法，例如 '+8%'。 */
  rate: '+8%',
  /** 合成侧音量，'-30%' 这种；页面侧的播放音量另算。 */
  volume: '+0%',
  /** 每段目标字数，越小越早出声、暂停粒度越细。 */
  targetChars: 120,
  /** 页面播放音量 0~1。 */
  playbackVolume: 0.9,
  /** 新回复到达时，是否打断还没念完的旧内容。 */
  interruptOnNew: true,
  /** 实时播报：边生成边攒句，每凑够一句就合成播出去，不用等整段回复写完。 */
  realtime: true,
  /**
   * 播放条停靠位置。
   * - top：嵌在会话标题栏右侧的 actions 区，一行横条（默认）
   * - sidebar：贴左侧导航栏，独立一行 + 就地展开卡片
   *
   * 旧版本的 float（右下角浮动卡片）已取消，存量配置里的 float 会在归一化时落回默认。
   */
  dock: 'top',
  /**
   * 写代码类回复的播报策略。
   * - true（默认）：本条回复一旦出现代码痕迹（围栏代码块 / 写文件的工具调用 / 代码行），
   *   立刻停止逐字播报，只把已经排进队列的那一两句念完；等整条回复落地后，
   *   只念末尾的结果说明（最多 320 字），不念开头的铺垫。
   *   代价：写代码期间（实测 4~6 分钟）中间是完全静音的，没事前提示。
   * - false：保持 1.0.173 的行为 —— 实时念一遍，落地只补没念到的尾巴。
   */
  codeQuiet: true,
  /**
   * 侧栏播放条那一行要不要一开始就是展开的。
   * - false（默认）：和之前一样，点行尾那个箭头才展开成卡片。
   * - true：侧栏形态下进来就是展开的；手动点过箭头之后，以手动为准。
   * 只在 dock = sidebar 时有意义，顶栏形态没有展开卡片。
   */
  dockExpanded: false,
  /**
   * 用哪个引擎合成。
   * - 'edge'（默认）：只用 Edge 神经语音，音色自然。慢的时候第一句要等 4~7 秒，
   *   个别段超时会直接跳过——不换成系统声线，保证整篇是同一个人念的。
   * - 'local'：只用 Windows 本地声线。实测 28 字约 282ms，起播最快、长文不断流，
   *   代价是音色是上一代机器音。
   * - 'auto'：老配置遗留值，行为同 'edge'（不再自动降级，避免一篇里两种声音）。
   */
  ttsEngine: 'edge',
  /**
   * 本地档用哪条声线（存声线名，空字符串＝让插件按平台自动挑一条最优的）。
   * 清单由宿主实时探测，用户装了新语音包会出现在设置页里，选谁就用谁。
   */
  localVoice: '',
  /**
   * 播放端均衡器：10 段（31 / 63 / 125 / 250 / 500 / 1k / 2k / 4k / 8k / 16k Hz），
   * 每段增益 -12~+12 dB。
   * 只在客户端播放链路里生效（Web Audio 的 BiquadFilter 串在 Audio 元素之后），
   * 不改合成结果，所以拖动滑块能立刻听到变化、也不用重新合成。
   */
  eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
}

// ──────────────────────────────────────────────────────────────
// 设置读写
// ──────────────────────────────────────────────────────────────

/** 只接受认识字段，非法值退回默认，避免手改配置把插件弄哑。 */
function normalizeSettings(raw) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  const pickBool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const pickNumber = (value, fallback, min, max) => {
    const num = Number(value)
    if (!Number.isFinite(num)) return fallback
    return Math.min(max, Math.max(min, num))
  }
  // 声线只从 VOICES 里认：方言声线 id 形如 zh-CN-liaoning-XiaobeiNeural，
  // 用正则硬校验会把带连字符的子标签判成非法、静默回退成默认晓晓。
  const voice = VOICES.some((item) => item.id === src.voice)
    ? src.voice
    : DEFAULT_SETTINGS.voice
  const rate = typeof src.rate === 'string' && /^[+-]?\d{1,3}%$/u.test(src.rate.trim())
    ? src.rate.trim()
    : DEFAULT_SETTINGS.rate
  const volume = typeof src.volume === 'string' && /^[+-]?\d{1,3}%$/u.test(src.volume.trim())
    ? src.volume.trim()
    : DEFAULT_SETTINGS.volume
  return {
    auto: pickBool(src.auto, DEFAULT_SETTINGS.auto),
    voice,
    rate,
    volume,
    targetChars: Math.round(pickNumber(src.targetChars, DEFAULT_SETTINGS.targetChars, 40, MAX_SEGMENT_CHARS)),
    playbackVolume: pickNumber(src.playbackVolume, DEFAULT_SETTINGS.playbackVolume, 0, 1),
    interruptOnNew: pickBool(src.interruptOnNew, DEFAULT_SETTINGS.interruptOnNew),
    realtime: pickBool(src.realtime, DEFAULT_SETTINGS.realtime),
    codeQuiet: pickBool(src.codeQuiet, DEFAULT_SETTINGS.codeQuiet),
    dockExpanded: pickBool(src.dockExpanded, DEFAULT_SETTINGS.dockExpanded),
    dock: ['top', 'sidebar'].includes(src.dock) ? src.dock : DEFAULT_SETTINGS.dock,
    ttsEngine: ['edge', 'local', 'auto'].includes(src.ttsEngine)
      ? src.ttsEngine
      : DEFAULT_SETTINGS.ttsEngine,
    // 本地声线名：不在这里对照清单校验——清单是运行时探测的，
    // 用户选的那条万一被卸载，取值时再回落到自动挑选，不让配置把插件弄哑。
    localVoice: typeof src.localVoice === 'string' ? src.localVoice.trim().slice(0, 120) : '',
    // 均衡器：固定 10 段，非数字回落 0，越界夹到 ±12 dB
    eq: (() => {
      const arr = Array.isArray(src.eq) ? src.eq : []
      const out = []
      for (let i = 0; i < 10; i += 1) {
        const n = Number(arr[i])
        out.push(Number.isFinite(n) ? Math.max(-12, Math.min(12, Math.round(n * 10) / 10)) : 0)
      }
      return out
    })(),
  }
}

function readSettings(config) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
  } catch {
    parsed = null
  }
  const merged = { ...DEFAULT_SETTINGS, ...(config !== null && typeof config === 'object' ? config : {}) }
  return normalizeSettings({ ...merged, ...(parsed !== null && typeof parsed === 'object' ? parsed : {}) })
}

function writeSettings(settings) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

// ──────────────────────────────────────────────────────────────
// 文本处理
// ──────────────────────────────────────────────────────────────

/** 从 assistant/message 事件里取正文。 */
function assistantTextOf(event) {
  const content = event?.data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const texts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      texts.push(block.text)
    }
  }
  return texts.join('\n')
}

/**
 * 从 user/message 事件里取用户那句话。
 * 只用来判"是不是同一条消息被重发"，取不到就返回空串（表示不做判重）。
 */
function userTextOf(event) {
  const content = event?.data?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts = []
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        texts.push(block.text)
      }
    }
    if (texts.length > 0) return texts.join('\n')
  }
  const plain = event?.data?.text
  return typeof plain === 'string' ? plain : ''
}

/**
 * 形似"文件名"的片段（含相对路径）。清洗时用 fileKindLabel 换成可读名词。
 */
const FILE_REF_RE = /[\w./-]*\.(?:html?|jsx?|tsx?|py|md|json|css|txt|zip|png|jpe?g|gif|svg|webp|csv|xlsx?|docx?|pdf)\b/giu

/**
 * 连续列举的文件引用（"a.html、b.html 和 c.html"）。整串一起处理，
 * 否则会念成"网页、网页和网页"——用户听不出是几个文件，只觉得在重复。
 * 分隔符两侧允许包反引号：真机里文件名是 chip，原文是 `p1.html`、`p2.html`。
 */
const FILE_SEP_SRC = '\\s*`?\\s*(?:[、，,]|和|与|及)\\s*`?\\s*'
const FILE_LIST_RE = new RegExp(
  `${FILE_REF_RE.source}${FILE_SEP_SRC}${FILE_REF_RE.source}(?:${FILE_SEP_SRC}${FILE_REF_RE.source})*`,
  'giu',
)

/**
 * 把"count.html"这类引用换成念得通的名词，而不是删成空。
 * 删空的后果是"已保存为。""已优化。"——听者会问"已保存为什么？"。
 */
function fileKindLabel(file) {
  const ext = String(file ?? '').toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1] ?? ''
  switch (ext) {
    case 'html':
    case 'htm':
      return '网页'
    case 'md':
      return '说明文档'
    case 'css':
      return '样式表'
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
    case 'py':
      return '脚本'
    case 'json':
      return '数据文件'
    case 'txt':
      return '文本文件'
    case 'csv':
    case 'xls':
    case 'xlsx':
      return '表格'
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
      return '图片'
    case 'zip':
      return '压缩包'
    case 'doc':
    case 'docx':
      return '文档'
    case 'pdf':
      return 'PDF 文档'
    default:
      return '文件'
  }
}

/**
 * 把模型输出的 Markdown 洗成"能念的普通话"：
 * 代码块、表格、URL、标记符号都不该被念出来。
 */
/**
 * 标题行没写成 Markdown 时（模型常用加粗或直接独占一行）的补救：逐行补标点那一步，
 * 遇到"短、没有逗号、也没有句末标点"的一行，补省略号而不是句号。
 * 句号的停顿只有 200 毫秒，听起来仍是「帘卷西风济南的趵突泉边」；省略号才够长。
 */
const TITLE_LINE_MAX = 20

function cleanForSpeech(raw) {
  let text = String(raw ?? '')
  if (text === '') return ''

  // 围栏代码块、缩进代码块整块丢掉（念代码没有意义）
  text = text.replace(/```[\s\S]*?```/gu, ' ')
  text = text.replace(/~~~[\s\S]*?~~~/gu, ' ')

  // 表格：分隔行丢掉，数据行转成 "a，b" 的口语形式（数字和结论不丢）
  text = text
    .split('\n')
    .filter((line) => !/^\s*\|?[\s:|-]{3,}\|?\s*$/u.test(line))
    .map((line) => {
      if (!/^\s*\|/u.test(line)) return line
      return line
        .replace(/^\s*\|/u, '')
        .replace(/\|\s*$/u, '')
        .split('|')
        .map((cell) => cell.trim())
        .filter((cell) => cell !== '')
        .join('，')
    })
    .join('\n')

  // 图片、链接只留可读文字
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
  text = text.replace(/https?:\/\/\S+/gu, ' ')
  // 标签和声明整段删：<!DOCTYPE html> 这种漏掉会念成"小于号 D O C T Y P E"
  text = text.replace(/<![^>]*>/gu, ' ')
  text = text.replace(/<\/?[A-Za-z][^>]*>/gu, ' ')

  // 文件引用在界面上是文件 chip，念"tetris 点 h t m l"纯粹是噪音。
  // 但不能直接删空 —— 那样会把句子砍成"已保存为。""已优化。"这种残句
  // （用户听成"已保存为什么？"），所以按扩展名换成能念的名词。
  // 连续列举的同类文件（多文件任务里"a.html、b.html 和 c.html"）折叠成"3 个网页"；
  // 如果前文已经数过"5 个页面文件："，这一串列举直接省掉，避免重复报数。
  text = text.replace(FILE_LIST_RE, (match, offset, whole) => {
    const files = String(match).match(new RegExp(FILE_REF_RE.source, 'giu')) ?? []
    if (files.length < 2) return match
    const kinds = files.map((file) => fileKindLabel(file))
    const head = String(whole ?? '').slice(0, Number(offset))
    const counted = head.match(/(\d+)\s*个[^\d：:。]{0,14}[：:]\s*`?\s*$/u)
    if (counted && Number(counted[1]) === files.length) return ''
    if (kinds.every((kind) => kind === kinds[0])) return `${files.length} 个${kinds[0]}`
    return match
  })
  // 列举被省掉后可能留下"文件：。"这种标点堆积（中间还夹着 chip 的残反引号）
  text = text.replace(/[：:，,、][`\s]*([。！？])/gu, '$1')
  text = text.replace(FILE_REF_RE, (file) => fileKindLabel(file))
  // 不带协议的裸域名 + 路径，同样不念
  text = text.replace(/[\w-]+\.(?:com|cn|net|org|io|ai|dev|app)\/\S*/giu, ' ')

  // 行内代码、强调、标题、列表记号
  text = text.replace(/```[\s\S]*?```/gu, '\n')
  // 没写闭合围栏的代码块：从围栏开头整段丢掉（剩下的都是代码，念出来全是花括号分号）
  text = text.replace(/```[\s\S]*$/gu, '\n')
  text = text.replace(/`([^`]*)`/gu, '$1')
  // 标题行不补句号，改补省略号：句号只给 200 毫秒，听起来还是"帘卷西风济南的趵突泉边"一句；
  // 省略号的停顿明显长一截，标题和正文才听得出是两件事。
  // （2026-11 实测推翻上面这条：24kHz MP3 里省略号的停顿比无标点还短，句号才有真正的断句。
  //  所以这里补句号，标题和正文之间才有约 0.39 秒的空隙。）
  text = text.replace(/^\s{0,3}#{1,6}\s+(.+)$/gmu, (match, title) => (/[。！？!?：:,，…]$/u.test(title) ? title : `${title}。`))
  text = text.replace(/^\s{0,3}>\s?/gmu, '')
  text = text.replace(/^\s{0,3}[-*+]\s+/gmu, '')
  text = text.replace(/^\s{0,3}\d+[.)]\s+/gmu, '')
  // 统一规则：markdown 元字符一次性清干净，不再逐条匹配「成对 / 落单」。
  // 这几种都会被 TTS 念成怪音（`*` 念成"星号"，用户实测听到"※"），对听感毫无意义；
  // 被实时首块截断的半对标记（`**核心`）、落单的 `*`，也在这一条里一并消失。
  // 但语言标点（。，！？；：、（）《》）必须留——那是断句的唯一依据，
  // 删了长文会连成一片，标题和正文之间那 0.39 秒的停顿就没了。
  text = text.replace(/[*_~`#>|※★☆]/gu, '')
  text = text.replace(/^\s*[-—–]\s*$/gmu, ' ')
  // 星号删掉后会露出重复标点（"浪漫。*。" → "浪漫。。"），合并成一个，免得念两次停顿
  text = text.replace(/([。！？；：，、])\1+/gu, '$1')

  // 表格里残留的竖线、emoji、各种装饰符号
  text = text.replace(/[|]/gu, ' ')
  text = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, ' ')
  text = text.replace(/[\u200B-\u200D\uFEFF]/gu, '')

  // 收尾：压缩空白，逐行补停顿标点（换行是分段的天然边界）
  text = text.replace(/[ \t\u00A0]+/gu, ' ')
  text = text.replace(/\s+([。！？!?…；;，,])/gu, '$1')
  // 替换文件名后会在中文之间留一个空格（"已保存为 网页"），TTS 会读成停顿，顺手抹掉。
  // 只能抹行内空白：换成 \s 会把换行一起吃掉，把单独一行的标题粘进下一段正文
  // （"老书店的下午" + 换行 + "街角那家……" 变成一整句），短行补省略号的分支就永远走不到。
  text = text.replace(/([\u4E00-\u9FFF])[ \t\u00A0]+(?=[\u4E00-\u9FFF])/gu, '$1')
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    // 没被围栏包住、直接摊在正文里的代码行：念出来是「padding 10 px」「background color」
    .filter((line) => line !== '' && !looksLikeCodeLine(line))
  text = lines
    .map((line) => {
      if (/[。！？!?…；;：:，,]$/u.test(line)) return line
      // 短、没逗号的一行，基本就是没写成 Markdown 的小标题；长句是正文。
      // 两者都补句号——省略号在 Edge 的声线里几乎没有停顿（实测比无标点还短），
      // 只有句号才有断句，标题和正文才听得出是两件事。
      return `${line}。`
    })
    .join('\n')
  return text.trim()
}

/**
 * 判断一行是不是"摊在正文里的代码"。
 * 只按中文里几乎不会出现的特征判（分号、花括号、箭头、HTML 标签、符号密度），
 * 避免把正常句子当代码删掉。
 *
 * 注意：符号密度这一条里，"不算符号"的只保留**中文标点**。
 * 半角引号、逗号、井号、斜杠都要算符号 —— 代码行 `'#FF5733',` 全靠这条才能判出来
 * （之前把半角 `'` 也算作"正常字符"，符号占比掉到 20%，整行就被念出来了）。
 */
function looksLikeCodeLine(line) {
  const t = String(line ?? '').trim()
  if (t === '') return false
  if (/[;{}]/u.test(t)) return true
  if (/=>|\b(?:function|const|let|var|return|import|export|class|await|async|if|else|for|while|switch|case|break|default)\b/u.test(t)) return true
  if (/<[A-Za-z][^>]*>/u.test(t)) return true
  if (/^[.#][A-Za-z0-9_-]+(?:\s*[,{:]|\s*\{)/u.test(t)) return true
  // 含 // 注释的行（中文正文里基本不出现连续两个斜杠）
  if (/\/\//u.test(t)) return true
  // 半角等号（赋值/比较）、函数调用形如 name(...)
  if (/=(?!=)/u.test(t) || /[A-Za-z_$][\w$]*\s*\(/u.test(t)) return true
  // 半角小括号整体包住一段标识符：movePiece(x, y)、setTimeout(fn)
  if (/^[A-Za-z_$][\w$]*\s*\(.*\)/u.test(t)) return true
  if (/^(?:-{2,}\s*)?[A-Za-z-]+\s*:\s*[^。！？\s][^。！？]{0,40}$/u.test(t) && /px|rem|em|%|#|rgba?|solid|flex|none|auto|center/u.test(t)) return true
  // 对象字面量的键：「boardWidth:」「colors: [」「speed: 800,」「shape: shapes[i].shape,」
  // 半角冒号 + 英文键，冒号后面不是中文，基本就是代码（中文正文用的是全角「：」）
  if (/^[A-Za-z_$][\w$\]]*\s*:\s*(?:[^\u4E00-\u9FFF]|$)/u.test(t)) return true
  // 半角方括号：数组下标、数组字面量（中文正文用的是全角「【】」）
  if (/[\[\]]/u.test(t)) return true
  // 属性访问：piece.shape、Math.random
  if (/[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*/u.test(t)) return true
  // 符号密度（中文正常句子里标点占比很低）
  // 允许的只保留"中文会用到的标点"：通用标点区（U+2000–206F，含“”‘’——…）、
  // 中文标点区（U+3000–303F）和全角 ASCII（U+FF01–FF5E）。
  // 半角引号、逗号、井号、斜杠一律算符号 —— 代码行 `'#FF5733',` 就靠这条判出来。
  const total = [...t].length
  if (total >= 6) {
    const symbols = (t.match(/[^\p{L}\p{N}\s\u2000-\u206F\u3000-\u303F\uFF01-\uFF5E…]/gu) || []).length
    // 光"符号多"不够，必须同时出现真正属于代码的半角符号。
    // 否则 `**秋日私语**`（markdown 加粗）、`——他来了。`、`“不早了。”她说。`
    // 这些正常散文短行都会被判成代码 —— 实测把纯文本创作整轮打进静音模式。
    // 注意 `*` 不算：它在 markdown 里是加粗/列表，在代码里也不是判据的关键符号。
    const asciiCodeMark = /[;{}()[\]="$#<>|\\/!'`]/u.test(t)
    if (asciiCodeMark && symbols / total > 0.3) return true
  }
  return false
}

/** 只留"念得出来"的字符（去空白与标点符号），用来比对两段文本念到哪儿了。 */
const NOT_SPEECH = /[\s\p{P}\p{S}]/u
function speechKey(text) {
  return String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '')
}

/**
 * 这段文本里有没有"要写代码"的痕迹。
 *
 * 判据放在**模型输出侧**，不放在用户提问侧：用户那句"这段报错怎么修""解释一下快速排序"
 * 都能沾到代码词汇，靠提问做分类误判率太高。输出侧这三样是硬信号：
 * 1) 围栏代码块 ```；
 * 2) 任意一行被 looksLikeCodeLine 判成代码（HTML/CSS/对象键/注释都走这条）；
 * 3) 工具调用写文件 —— 由调用方用 tool-call 块单独判（见 session/event 里的 block-type）。
 */
function hasCodeTrace(text) {
  const t = String(text ?? '')
  if (t === '') return false
  if (t.includes('```')) return true
  const lines = t.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  if (lines.length === 0) return false
  let hits = 0
  for (const line of lines) if (looksLikeCodeLine(line)) hits += 1
  if (hits === 0) return false
  // 单行整段：就是一串代码（"const a = 1;" 这种）。
  if (lines.length === 1) return true
  // 多行：要么命中两行以上，要么命中一行但占非空行的一半以上。
  // 以前一行命中就整轮静音，散文里偶尔冒一行 `**小标题**` 就能把正常回复打成静音 ——
  // 写代码的回复几乎不可能只沾一行代码，收紧到这条不会漏判真正的代码回复。
  return hits >= 2 || hits / lines.length >= 0.5
}

/** 静音模式收尾：最多念这么多字的结果说明。 */
const RESULT_TAIL_MAX = 320

/**
 * 静音回合收尾前的那一声提示：静了几分钟再突然开口，容易被当成"又重播了"。
 * 45 秒是个折中 —— 十几秒的短回合静默不明显，多响一声反而吵；
 * 写代码的回合通常静默 3~5 分钟，正好需要这一声。
 */
const CHIME_MIN_QUIET_MS = 45_000

/** 中途反问：最多补念几句、合计多少字。 */
const ASK_MAX_ITEMS = 2
const ASK_MAX_CHARS = 110

/** 一个"可能要用户回话"的句子：以问号收尾。英文句号也算句读，否则会把前一句一起吞进来。 */
const ASK_SENTENCE = /[^。！？!?\n.]{4,90}[？?]/gu

/** 只认"真的在等你回话"的问句：带第二人称，或带明确的选项／确认词。
 *  修辞问句（"为什么会这样呢？"）不单独抓，交给结果段就够，否则会平白插入一句。 */
const ASK_HINT = /你|您|要不要|需不需要|是否|还是|请选择|请确认|告诉我|选一个|哪种|哪个|可以吗|行吗|好吗|需要我|\byou\b|\byour\b|want me|shall i|would you|do you/u

/**
 * 从正文里挑出"模型在等用户回话"的问句。
 *
 * 静音回合只念尾部 320 字：模型要是先在正文中间问"你想要哪种风格？"再继续写，
 * 这句就落在尾部之外，用户得盯着屏幕才知道它在等他。这里单独拎出来，收尾时补念。
 * 保守取值：最多两句、合计 110 字，重复的只留一次。
 */
function pendingQuestions(raw) {
  const t = String(raw ?? '').replace(/\r/gu, '')
  const out = []
  let used = 0
  for (const match of t.matchAll(ASK_SENTENCE)) {
    const sentence = String(match[0] ?? '').trim()
    if (sentence === '' || !ASK_HINT.test(sentence)) continue
    if (out.includes(sentence)) continue
    if ([...sentence].length + used > ASK_MAX_CHARS) continue
    out.push(sentence)
    used += [...sentence].length
    if (out.length >= ASK_MAX_ITEMS) break
  }
  return out
}

/** 收尾要不要先响一声提示音：静默够久，并且确实还有内容要念。 */
function shouldChime(quietStartedAt, now, hasContent) {
  if (hasContent !== true) return false
  if (typeof quietStartedAt !== 'number' || quietStartedAt <= 0) return false
  if (typeof now !== 'number') return false
  return now - quietStartedAt >= CHIME_MIN_QUIET_MS
}

/**
 * tool/call 的原始 JSON 里是不是"写文件 / 编辑文件"类的工具。
 * 读文件、搜索、列目录都不算 —— 那些是纯文本回复的常见前置动作，
 * 按它们静音会把正常回复整段吞掉（1.0.183 实机复现）。
 */
const WRITE_TOOL = /"(?:name|toolName|tool)"\s*:\s*"[^"]*(?:write|edit|create|patch|apply|save|update)[^"]*"/iu

function looksLikeWriteTool(raw) {
  return WRITE_TOOL.test(String(raw ?? ''))
}

/**
 * 模型的"反问"在 DSH 里不是正文，而是一个工具调用（ask_user_question / request_user_input）。
 * 1.0.192 实机：模型问"你希望深色模式切换怎么做？"时，正文里一个字都没有，
 * 界面直接弹出选项卡 —— 播报渠道根本收不到，用户不盯屏幕就不知道它在等回复。
 * 所以这里按工具名单独接住，把问题念出来。
 */
const ASK_TOOL = /^(?:ask_user_question|request_user_input|ask_user|ask_question)$/iu

function extractAskQuestions(raw) {
  const out = []
  const push = (value) => {
    const t = String(value ?? '').replace(/\s+/gu, ' ').trim()
    if (t === '') return
    const len = [...t].length
    if (len < 4 || len > 160) return
    if (!/[？?]/u.test(t) && len > 70) return
    if (out.includes(t)) return
    if (out.length >= 3) return
    out.push(t)
  }
  let outer = null
  try { outer = JSON.parse(String(raw ?? '')) } catch { outer = null }
  let args = outer?.data ?? outer
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { args = null }
  }
  if (args && typeof args === 'object' && args.arguments !== undefined) {
    args = args.arguments
    if (typeof args === 'string') {
      try { args = JSON.parse(args) } catch { args = null }
    }
  }
  const walk = (node, depth, loose) => {
    if (node === null || node === undefined || out.length >= 3) return
    if (depth > 6) return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1, loose)
      return
    }
    if (typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string') {
        if (/^(?:question|questions|question_text|prompt|ask|title)$/iu.test(key)) push(value)
        else if (loose === true && /[？?]/u.test(value)) push(value)
        continue
      }
      walk(value, depth + 1, loose)
    }
  }
  walk(args, 0, false)
  // 字段名不认识时的兜底：抓任何"带问号的字符串"。宁可多念一句，也别把提问整段漏掉。
  if (out.length === 0) walk(args, 0, true)
  return out
}

/**
 * 从整段正文里取"结尾的结果说明"。
 * 按句切，从后往前整句累加，超过上限就停 —— 保证从完整句子开头念，不会半句起手。
 */
function resultTail(text) {
  const t = String(text ?? '').trim()
  if (t === '') return ''
  if ([...t].length <= RESULT_TAIL_MAX) return t
  const parts = t.split(/(?<=[。！？!?]|\n)/u).filter((s) => s.trim() !== '')
  let out = ''
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const next = parts[i] + out
    if ([...next].length > RESULT_TAIL_MAX) break
    out = next
  }
  if (out.trim() === '') {
    // 一整句就超过上限：退化成"末尾最长的完整句"，实在没有就取末 N 字
    const last = parts[parts.length - 1] ?? ''
    out = [...last].length > RESULT_TAIL_MAX ? [...last].slice(-RESULT_TAIL_MAX).join('') : last
  }
  return out.trim()
}

/** 切掉原文前 k 个"可念字符"，返回剩下的部分（保留原文里的标点与换行）。 */
function cutAfterSpeechChars(text, k) {
  if (k <= 0) return text
  let seen = 0
  for (let i = 0; i < text.length; i += 1) {
    if (NOT_SPEECH.test(text[i])) continue
    seen += 1
    if (seen === k) return text.slice(i + 1)
  }
  return ''
}

/**
 * 宿主在工具调用之后会**重开 attempt、把正文从头再发一遍**。
 * 这段文本如果跟已经送过的内容重合，就当成续传：只念新增的那一截，绝不重念。
 *
 * @returns {{ replay: boolean, tail: string }}
 */
function liveOverlap(text, sent) {
  const raw = String(text ?? '')
  const ts = speechKey(raw)
  const ss = speechKey(sent)
  if (ts === '' || ss === '') return { replay: false, tail: raw }
  // ① 整段都出现在已送内容里 → 纯重放，丢掉。
  //    只对够长的段这么判：短句（"移动方块。"）在长文本里到处都是，按"包含"判会误杀新内容。
  const pos = ss.indexOf(ts)
  if (pos >= 0 && (ts.length >= 20 || pos <= Math.floor(ss.length * 0.5))) {
    return { replay: true, tail: '' }
  }
  // ② 这段的开头在已送内容里某个位置接上，并一路延伸到已送内容的末尾：
  //    多出来那截才是没念过的（重放的最后一段通常就是这个形状）
  const probe = ts.slice(0, Math.min(12, ts.length))
  const at = ss.indexOf(probe)
  if (at >= 0) {
    let k = 0
    while (k < ts.length && at + k < ss.length && ss[at + k] === ts[k]) k += 1
    if (at + k === ss.length && k >= 8) {
      const rest = cutAfterSpeechChars(raw, k).replace(/^[\s\p{P}\p{S}]+/u, '').trim()
      return { replay: true, tail: speechKey(rest).length >= 2 ? rest : '' }
    }
  }
  // ③ 开头正好接在末尾（普通续传重复）
  for (let k = Math.min(ts.length, 240); k >= 8; k -= 1) {
    if (ss.endsWith(ts.slice(0, k))) {
      const rest = cutAfterSpeechChars(raw, k).replace(/^[\s\p{P}\p{S}]+/u, '').trim()
      return { replay: true, tail: speechKey(rest).length >= 2 ? rest : '' }
    }
  }
  return { replay: false, tail: raw }
}

/**
 * 整段消息落地时，算「实时路径还没念到」的那一截。
 *
 * 不能用「已送文本是不是消息的干净前缀」来判：实时流会被工具调用打断、
 * 会被宿主重放、客户端还会在 attempt 变化时把累计重置掉，所以已送文本经常
 * 是「消息开头 + 一段重复内容」这种脏数据，startsWith 一失败就退化成整段重念。
 * 改成滑窗覆盖：从消息开头逐字推进，看这一窗 12 个字有没有在已送文本里出现过。
 * 只要消息开头的内容确实念过，就一定能推进；推进到哪儿，就从哪儿接着念。
 *
 * @param message 已经 cleanForSpeech 过的整段正文
 * @param sent    实时路径累计送出过的原文（允许脏：重放、重复、截断都行）
 * @returns ''（整段都念过了）或需要补播的尾巴原文
 */
const TAIL_WIN = 12
function speechTail(message, sent) {
  const m = String(message ?? '')
  const ss = speechKey(sent)
  const mk = speechKey(m)
  if (ss === '') return m
  if (mk === '') return ''
  if (ss.length >= TAIL_WIN && mk.length >= TAIL_WIN) {
    const grams = new Set()
    for (let i = 0; i + TAIL_WIN <= ss.length; i += 1) grams.add(ss.slice(i, i + TAIL_WIN))
    let p = 0
    while (p + TAIL_WIN <= mk.length && grams.has(mk.slice(p, p + TAIL_WIN))) p += 1
    // 滑窗在"边界"处必然停：已送文本只到 B 的末尾，B 与 C 跨边界的那个窗凑不出来。
    // 校正一次：把消息从 p 起的开头，与已送文本的末尾做最长重叠，能吃掉几个字就吃掉几个。
    for (let d = TAIL_WIN - 1; d >= 1; d -= 1) {
      const seg = mk.slice(p, p + d)
      if (seg.length === d && ss.endsWith(seg)) {
        p += d
        break
      }
    }
    if (p > 0) {
      // 尾部只剩不到一个窗、或覆盖率已经很高：当作念完了，别为最后十来个字再补一段
      if (p >= mk.length - TAIL_WIN || p / mk.length >= 0.92) return ''
      const tail = cutAfterSpeechChars(m, p).replace(/^[\s\p{P}\p{S}]+/u, '').trim()
      return speechKey(tail).length >= 2 ? tail : ''
    }
    return m
  }
  // 太短的文本没有窗可比，退回前缀判定
  return ss.startsWith(mk) ? '' : m
}

/**
 * 按句末标点/换行切成句子。
 * 引号、书名号、括号里的句号不算句末——「他说："走吧。"」不能被切成两段。
 * 这是**合成/对齐用的句级**，逗号不算边界（Edge 服务端也是这么切的）。
 */
const QUOTE_PAIRS = { '《': '》', '「': '」', '『': '』', '“': '”', '‘': '’', '（': '）', '(': ')', '【': '】', '{': '}', '[': ']' }

function splitSentences(text) {
  const out = []
  const stack = []
  let buf = ''
  for (const ch of text) {
    buf += ch
    if (Object.prototype.hasOwnProperty.call(QUOTE_PAIRS, ch)) {
      stack.push(QUOTE_PAIRS[ch])
      continue
    }
    if (stack.length > 0 && ch === stack[stack.length - 1]) {
      stack.pop()
      continue
    }
    if (stack.length === 0 && '。！？!?…；;\n'.includes(ch)) {
      out.push(buf)
      buf = ''
    }
  }
  if (buf.trim() !== '') out.push(buf)
  return out.map((piece) => piece.trim()).filter((piece) => piece !== '')
}

/**
 * **歌词行**：给卡片里滚动显示用的切分。
 * 比句级更细——逗号、冒号也算一行结束，这样一行不会长到把两句话挤在一行里滚过去；
 * 顿号（、）**不切**，否则「这里有火锅、」「有茶馆。」会把列举词拆成两行，读起来很怪。
 * 括号、引号、书名号里的一律不切（和 splitSentences 同一套配对规则）。
 */
function splitLyricLines(text) {
  const out = []
  const stack = []
  let buf = ''
  for (const ch of text) {
    buf += ch
    if (Object.prototype.hasOwnProperty.call(QUOTE_PAIRS, ch)) {
      stack.push(QUOTE_PAIRS[ch])
      continue
    }
    if (stack.length > 0 && ch === stack[stack.length - 1]) {
      stack.pop()
      continue
    }
    if (stack.length === 0 && '。！？!?…；;\n，,：:'.includes(ch)) {
      out.push(buf)
      buf = ''
    }
  }
  if (buf.trim() !== '') out.push(buf)
  return out.map((piece) => piece.trim()).filter((piece) => piece !== '')
}

/** 句子还是太长时，按逗号/顿号/空格再切一次。 */
function splitLongSentence(sentence, limit) {
  const parts = []
  let buf = ''
  for (const ch of sentence) {
    buf += ch
    // 逗号类断点比硬切自然，但仍要让 buf 不超过 limit 太多
    if ('，、,：: '.includes(ch) && buf.length >= limit * 0.9) {
      parts.push(buf)
      buf = ''
    }
  }
  if (buf !== '') parts.push(buf)
  // 仍然过长的片段硬切
  return parts.flatMap((piece) => {
    if (piece.length <= limit * 1.5) return [piece]
    const hard = []
    for (let i = 0; i < piece.length; i += limit) hard.push(piece.slice(i, i + limit))
    return hard
  })
}

/** 超长句（一行放不下）拆分时用的粒度，仅影响"怎么断"，不影响合成块大小。 */
const LYRIC_LINE_CHARS = 18

/**
 * 切块：**合成单位**。攒到 targetChars 附近才断，保证音频连续、播报不停顿。
 * 句子的划分交给 splitSentences（它是**显示单位**，用来算歌词时间轴），
 * 两者在这里解耦——块内的每一句都会带着自己的时间点交给客户端。
 * @returns {string[]} 可直接送合成的段落。
 */
function chunkText(text, targetChars, firstChunkChars = 0) {
  const limit = Math.min(MAX_SEGMENT_CHARS, Math.max(40, Math.round(targetChars)))
  const sentences = splitSentences(text)
  const chunks = []
  let current = ''

  for (const sentence of sentences) {
    const pieces = sentence.length > limit * 1.5 ? splitLongSentence(sentence, limit) : [sentence]
    for (const piece of pieces) {
      // 标题行到这里已经是普通句子了（cleanForSpeech 在它后面补了省略号）。
      // 不能让它单独成一段：4 个字的标题只播 1.5 秒，而下一段 76 字要合成 8 秒，
      // 播完标题就开始空等——实测就是 5~7 秒的空白，比连读难听得多。
      // 停顿由省略号给，节奏还由 300 字的大块保证。
      if (current !== '' && current.length + piece.length > limit) {
        chunks.push(current)
        current = ''
      }
      current += piece
      if (current.length >= limit) {
        chunks.push(current)
        current = ''
      }
    }
  }
  if (current.trim() !== '') chunks.push(current)

  // 太短的碎片（"好。"）合并到上一块，避免频繁启停
  const merged = []
  for (const chunk of chunks) {
    const piece = chunk.trim()
    if (piece === '') continue
    if (merged.length > 0 && piece.length <= 6 && merged[merged.length - 1].length + piece.length <= limit) {
      merged[merged.length - 1] += piece
    } else {
      merged.push(piece)
    }
  }

  // 首段单独缩短：第一段越快合成完，用户越早听到声音
  if (firstChunkChars > 0 && merged.length > 0 && merged[0].length > firstChunkChars) {
    const head = splitLongSentence(merged[0], Math.max(20, firstChunkChars))
    // 只拿第一小段当前置首块，剩下的整段并回第二块。
    // 以前是把它拆成五六段，结果每一小段都要单独去服务端排一次队：
    // 首句没更快，反而多了五次超时机会（日志里一篇 13 段有 6 段是这种碎片）。
    const lead = head[0]
    const rest = head.slice(1).join('')
    merged.splice(0, 1, ...(rest.trim() === '' ? [lead] : [lead, rest]));
  }
  return merged
}

/** Edge 的时间戳单位是 100ns tick。 */
const TICKS_PER_SECOND = 10000000

/**
 * 把一块文本的歌词行排成 LRC 式时间轴。
 *
 * 关键点：**Edge 只在句末标点处切（sentenceBoundaries），而我们显示时逗号也断**，
 * 所以两边数量平时就不相等。这里做两级映射：先把服务端每句的真实时长，
 * 按字数分给它覆盖的那几行歌词。全程没有"猜"，只有逗号内部的二次均分。
 * @param lines 歌词行（splitLyricLines 的结果）
 * @returns {{t: number, d: number, text: string}[]}
 */
function buildCues(lines, synthResult) {
  const total = Number(synthResult?.duration) || 0
  if (lines.length === 0 || total <= 0) return []
  const stripLen = (s) => String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '').length
  const w = lines.map((line) => Math.max(1, stripLen(line)))
  const sumW = w.reduce((a, b) => a + b, 0)
  const server = Array.isArray(synthResult?.sentenceBoundaries) ? synthResult.sentenceBoundaries : []

  // 一、数量正好相等：直接一句对一句
  if (server.length === lines.length && server.length > 0) {
    const cues = []
    for (let i = 0; i < lines.length; i += 1) {
      cues.push({
        t: (Number(server[i].offset) || 0) / TICKS_PER_SECOND,
        d: (Number(server[i].duration) || 0) / TICKS_PER_SECOND,
        text: lines[i],
      })
    }
    if (cues[0].t > 0.6) cues[0].t = 0
    return cues
  }

  // 二、服务端按句末切、我们按逗号切得更细：把每句的真实区间分给覆盖到的行
  if (server.length > 0 && server.length < lines.length) {
    const eW = server.map((item) => Math.max(0, stripLen(item.text)))
    const eSumW = eW.reduce((a, b) => a + b, 0)
    const usable = eSumW > 0 && server.every((item) => stripLen(item.text) > 0)
    const cues = []
    let cursor = 0
    for (let j = 0; j < server.length; j += 1) {
      const t0 = (Number(server[j].offset) || 0) / TICKS_PER_SECOND
      const dur = (Number(server[j].duration) || 0) / TICKS_PER_SECOND
      // 这一句占多少字（按我们的行字数口径），拿不到服务端文本时就按句数均分
      const budget = usable ? (eW[j] / eSumW) * sumW : sumW / server.length
      const group = []
      let got = 0
      while (cursor < lines.length) {
        group.push(cursor)
        got += w[cursor]
        cursor += 1
        if (got >= budget) break
      }
      const gsum = group.reduce((a, idx) => a + w[idx], 0) || 1
      let acc = 0
      for (const idx of group) {
        const share = (dur * w[idx]) / gsum
        cues.push({ t: t0 + acc, d: share, text: lines[idx] })
        acc += share
      }
    }
    // 兜底：字数额度算偏导致还有行没排上，接在末尾（时长给 0，不影响滚动顺序）
    while (cursor < lines.length) {
      const last = cues.length > 0 ? cues[cues.length - 1] : null
      const t = last ? Math.min(total, last.t + last.d) : 0
      cues.push({ t: t, d: 0, text: lines[cursor] })
      cursor += 1
    }
    if (cues.length > 0 && cues[0].t > 0.6) cues[0].t = 0
    return cues
  }

  // 三、拿不到时间戳：按字数比例铺满整段
  const cues = []
  let t = 0
  for (let i = 0; i < lines.length; i += 1) {
    const d = (total * w[i]) / sumW
    cues.push({ t, d, text: lines[i] })
    t += d
  }
  return cues
}

/** 念出来没意义的段落直接丢掉。 */
function speakable(text) {
  const meaningful = text.replace(/[\s\p{P}\p{S}]/gu, '')
  return meaningful.length >= 2
}

// ──────────────────────────────────────────────────────────────
// 插件主体
// ──────────────────────────────────────────────────────────────

/**
 * 挂载命令、自动播报与 HTTP 路由。所有资源注册在同一个 effect 里，卸载时一起回收。
 */
export function apply(ctx, config = {}) {
  return ctx.effect(() => {
    const disposers = []
    const settings = readSettings(config)

    /** 写一份可读日志：插件出问题时，先看 ~/.dsh/dsh-live-speak/log.txt。 */
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      const stat = fs.statSync(LOG_FILE)
      if (stat.size > 256 * 1024) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`)
    } catch {
      // 文件不存在或没权限都不影响功能
    }
    const log = (...parts) => {
      try {
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${parts.join(' ')}\n`, 'utf8')
      } catch {
        // 日志写不进去就算了
      }
    }
    log('apply: 插件挂载开始', `voice=${settings.voice}`, `auto=${settings.auto}`, `rate=${settings.rate}`)

    /** 已合成、等待播放的音频。key 是自增 id。 */
    const ready = new Map()
    let nextId = 1
    /** 状态版本号：任何变化都 +1，页面只按它判断要不要重绘。 */
    let rev = 0
    /** 内容代次：新回复打断旧内容时 +1，页面据此清空自己的播放队列。 */
    let epoch = 1

    /** 最近一次「实时逐句」上报的时间：用来给整段落地的 assistant/message 去重。 */
    let lastLiveAt = 0
    /** 实时上报所属的 attemptId，只用来写日志排查。 */
    let liveAttempt = null
    /**
     * 本条回复里实时路径已经送出过的文本（按 append 累积）。
     * 整段消息落地时拿它做前缀比对：已经在实时路径念过的不再重念，
     * 只把没送到的尾巴补上（代码块生成期间实时流会断，尾巴就靠这里补）。
     */
    let liveSentText = ''
    /** 上一次整段播过的正文（只留可念字符的指纹）与时间，防同一条正文重复落地被念两遍。 */
    let lastFullKey = ''
    let lastFullAt = 0
    /**
     * 本回合是否"还没开过口"：用户发来新消息时置 true，
     * 第一段实时内容可以打断旧播报；之后同一回合内的 attempt 重开一律续传、不打断。
     */
    let turnFresh = false
    /**
     * 本条回复已判定为"写代码类"，进入静音模式：
     * 不再逐字念，等 assistant/message 落地只念末尾的结果说明。
     * 用户发新消息（user/message）时复位。
     */
    let codeQuietTurn = false
    /**
     * 静音回合的结果段已经念过的时刻（0 = 还没念）。
     * 实机 1.0.174 发现：收尾念完之后，宿主又发来一条稍长的快照，
     * 实时对齐把它当成"还没念的尾巴"补了一遍，末尾那句被念了两次
     * （日志里 "希望你喜欢！" 连着出现两条 cue）。这里立个闸：
     * 同一回合内结果段念过之后，后续 assistant/message 一律不再补播。
     */
    let quietSettledAt = 0
    /** 静音回合里"最后一版正文"，等 turn/end 再念它的结果段。 */
    let quietPending = ''
    let quietPendingTimer = null
    /** 这一轮是什么时候开始静音的（0 = 本轮没进过静音）：收尾据此决定要不要先响一声。 */
    let quietStartedAt = 0
    /** 静音回合里抓到的"在等用户回话"的问句，收尾时补念。 */
    let quietAsk = []
    /** 闸门拦下实时段只打一次日志，避免每段都刷一行。 */
    let quietGateLogged = false
    /** 第几问念过没有：模型重试同一个提问时别重复念。 */
    let lastAskKey = ''
    let lastAskAt = 0
    /** 提问工具的参数结构只打印一次，用来确认问题文本落在哪个字段。 */
    let askProbeSeen = false
    /** tool/call 的结构只打印一次（第一次拿到就能确认工具名字段长什么样）。 */
    let toolProbeSeen = false
    /**
     * 上一条用户消息的指纹与时刻。
     * 实机 1.0.175 看到：模型/宿主会把**同一轮**重开一次（又发一条 user/message），
     * 于是 turnFresh 被重新立起，下一段实时内容带着 interrupt=true 把正在念的
     * 结果段切断，接着把同一篇正文从头再念一遍。同一条用户消息短时间内重复到达，
     * 一律按"同一回合的重试"处理：不复位已送文本、不复位静音闸。
     */
    let lastUserKey = ''
    let lastUserAt = 0
    /** 合成任务队列（文本段）。 */
    const jobs = []
    let working = false
    let lastError = ''
    let synthFailCount = 0
    /**
     * 连续失败是从什么时候开始的（毫秒），0 表示当前正常。
     * 用来给界面一个明确说法：合成卡在门外十几秒时，用户需要知道"它在重试"，
     * 而不是看着一张静止的卡片以为插件死了。
     */
    let synthTroubleSince = 0

    /** Edge TTS 实例懒加载：依赖缺失/网络异常都不该影响 DSH 启动。 */
    let engine = null
    let engineModule = null
    const tts = () => {
      if (engine === null) {
        if (engineModule === null) throw new Error('Edge TTS 模块尚未加载')
        engine = new engineModule.EdgeTTS()
      }
      return engine
    }
    let engineLoading = null
    const ensureEngine = async () => {
      if (engineModule !== null) return engineModule
      if (engineLoading !== null) return engineLoading
      engineLoading = (async () => {
        const mod = await import('@andresaya/edge-tts')
        engineModule = mod
        return mod
      })()
      try {
        return await engineLoading
      } finally {
        engineLoading = null
      }
    }

    const bump = () => {
      rev += 1
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    /** 丢掉所有还没被播放的音频与待合成任务。 */
    const resetQueue = (options = {}) => {
      const { epochChange = false } = options
      ready.clear()
      jobs.length = 0
      if (epochChange) epoch += 1
      // 换一篇就把「合成异常」的计时归零，否则新一篇会带着上一篇的秒数继续报
      if (epochChange) synthTroubleSince = 0
      bump()
    }

    /** 清理过期 / 超量的 ready 项。 */
    const trimReady = () => {
      const now = Date.now()
      let touched = false
      for (const [id, item] of ready) {
        if (now - item.at > READY_TTL_MS) {
          ready.delete(id)
          touched = true
        }
      }
      while (ready.size > MAX_READY) {
        // 两路合成后写入顺序不再等于 id 顺序，按 id 最小删才是真的"最旧"
        let oldestId = null
        for (const id of ready.keys()) {
          if (oldestId === null || id < oldestId) oldestId = id
        }
        if (oldestId === null) break
        ready.delete(oldestId)
        touched = true
      }
      if (touched) bump()
    }

    /**
     * 纯英文声线念中文会被服务端直接拒（返回正文为空），听起来就是没声音；
     * Multilingual 结尾的声线本身能跨语言，所以只有"非 Multilingual 的英文声线
     * + 中文文本"这一种组合才回退到默认中文声线。
     */
    const resolveVoiceFor = (text) => {
      const chosen = settings.voice
      if (/^en-/iu.test(chosen) && !/Multilingual$/iu.test(chosen) && /[\u4e00-\u9fff]/u.test(text)) {
        return DEFAULT_SETTINGS.voice
      }
      return chosen
    }

    const WINRT_SYNTH_SCRIPT = [
      'param([string]$TextFile,[string]$OutWav,[string]$VoiceMatch,[string]$Rate)',
      'Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null',
      "$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
      'function Await($task) {',
      '  $net = $asTaskGeneric.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($task))',
      '  $net.Wait(-1) | Out-Null',
      '  $net.Result',
      '}',
      '[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime]',
      '$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer',
      '$voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices',
      '$target = $null',
      'if ($VoiceMatch) { $target = $voices | Where-Object { $_.DisplayName -like "*$VoiceMatch*" } | Select-Object -First 1 }',
      "if ($null -eq $target) { $target = $voices | Where-Object { $_.Language -like 'zh*' } | Select-Object -First 1 }",
      "if ($null -eq $target) { throw 'NO_LOCAL_VOICE' }",
      '$synth.Voice = $target',
      '$body = Get-Content -LiteralPath $TextFile -Raw -Encoding utf8',
      "if (-not $body) { throw 'EMPTY_TEXT' }",
      '$escaped = [System.Security.SecurityElement]::Escape($body)',
      '$ssml = \'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><prosody rate="\' + $Rate + \'">\' + $escaped + \'</prosody></speak>\'',
      'try { $stream = Await ($synth.SynthesizeSsmlToStreamAsync($ssml)) }',
      'catch { $stream = Await ($synth.SynthesizeTextToStreamAsync($body)) }',
      '$src = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)',
      '$fs = [System.IO.File]::Create($OutWav)',
      '$src.CopyTo($fs)',
      '$fs.Close()',
      '$src.Close()',
      '$synth.Dispose()',
      "'VOICE=' + $target.DisplayName",
    ].join('\r\n')

    const WINRT_PROBE_SCRIPT = [
      '[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime]',
      '$voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices',
      "foreach ($v in $voices) { $v.DisplayName + '|' + $v.Language + '|' + $v.Id }",
    ].join('\r\n')

    /**
     * 两个脚本每次都按内容比对写一遍，内容没变就不落盘。
     * 放在运行时目录而不是插件目录，是为了 npm 包里不带可变文件。
     */
    const ensureWinrtScripts = () => {
      try {
        fs.mkdirSync(LOCAL_AUDIO_DIR, { recursive: true })
        const writeIfChanged = (target, content) => {
          let previous = ''
          try { previous = fs.readFileSync(target, 'utf8') } catch { /* 没有就当空 */ }
          if (previous !== content) fs.writeFileSync(target, content, 'utf8')
        }
        writeIfChanged(WINRT_SYNTH_PS1, WINRT_SYNTH_SCRIPT)
        writeIfChanged(WINRT_PROBE_PS1, WINRT_PROBE_SCRIPT)
      } catch { /* 写不进去就让上层回落到 SAPI */ }
    }

    // ── 本机声线探测（三端统一） ──────────────────────────────
    // 统一结构 { name, id, lang, engine }：
    //   engine = winrt / sapi / say / espeak —— 合成时按它分派到对应后端
    //   id     = 该后端内部指定声线用的值（Windows 用声线名，say/espeak 也用名字）
    // 清单缓存 5 分钟；设置页点「重新检测」会强制清缓存立刻重探。

    /** Windows：WinRT 那一层。自然语音（晓晓这类）只在这里，SAPI 看不见。 */
    const probeWinrtVoices = () => new Promise((resolve) => {
      ensureWinrtScripts()
      execFile(
        POWERSHELL_EXE,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINRT_PROBE_PS1],
        { timeout: 20_000, windowsHide: true },
        (error, stdout) => {
          if (error) {
            log(`voice probe failed: ${String(error?.message ?? error).split('\n')[0]}`)
            resolve([])
            return
          }
          resolve(String(stdout || '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const [name, lang, id] = line.split('|')
              return { name: name || '', id: id || name || '', lang: lang || '', engine: 'winrt' }
            })
            .filter((voice) => voice.name !== ''))
        },
      )
    })

    /** Windows：SAPI 那一层。老式桌面声线（Huihui / Kangkang / Yaoyao）在这里。 */
    const SAPI_PROBE_CMD = [
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      'foreach ($v in $s.GetInstalledVoices()) { if ($v.Enabled) { $i = $v.VoiceInfo; $i.Name + "|" + $i.Culture.Name } }',
      '$s.Dispose()',
    ].join('; ')
    const probeSapiVoices = () => new Promise((resolve) => {
      execFile(
        POWERSHELL_EXE,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SAPI_PROBE_CMD],
        { timeout: 20_000, windowsHide: true },
        (error, stdout) => {
          if (error) {
            log(`voice probe failed: ${String(error?.message ?? error).split('\n')[0]}`)
            resolve([])
            return
          }
          resolve(String(stdout || '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const [name, lang] = line.split('|')
              return { name: name || '', id: name || '', lang: lang || '', engine: 'sapi' }
            })
            .filter((voice) => voice.name !== ''))
        },
      )
    })

    /**
     * macOS：`say -v ?` 的固定列输出，形如
     *   Tingting            zh_CN    # 你好，我叫Tingting。
     * 声线名可能带空格，所以用「空白 + 语言标签 + #」从右侧圈定，避免按列硬切。
     */
    const probeSayVoices = () => new Promise((resolve) => {
      execFile('say', ['-v', '?'], { timeout: 15_000 }, (error, stdout) => {
        if (error) {
          log(`voice probe failed: ${String(error?.message ?? error).split('\n')[0]}`)
          resolve([])
          return
        }
        const list = []
        for (const raw of String(stdout || '').split('\n')) {
          const hit = /^(.+?)\s+([a-zA-Z]{2}[_-][a-zA-Z]{2,3}(?:[_-][A-Za-z0-9]+)?)\s+#/u.exec(raw)
          if (hit === null) continue
          const name = hit[1].trim()
          if (name === '') continue
          list.push({ name, id: name, lang: hit[2], engine: 'say' })
        }
        resolve(list)
      })
    })

    /**
     * Linux：espeak-ng（或老版 espeak）的 --voices 表格，第 2 列语言代码、第 4 列声线名。
     * 优先 espeak-ng，没装再退回 espeak；两个都探不到就返回空清单。
     */
    let espeakBinary = ''
    const probeEspeakVoices = () => new Promise((resolve) => {
      const tryBin = (bin, next) => {
        execFile(bin, ['--voices'], { timeout: 15_000 }, (error, stdout) => {
          if (error) { next(); return }
          espeakBinary = bin
          const list = []
          for (const raw of String(stdout || '').split('\n')) {
            const cols = raw.trim().split(/\s+/u)
            // 表头 "Pty Language Age/Gender VoiceName File ..." 第一列不是数字，直接跳过
            if (cols.length < 4 || !/^\d+$/u.test(cols[0])) continue
            // espeak 的 VoiceName 列本身带空格（如 "Chinese (Mandarin)"），
            // 用语言代码当 id（espeak-ng -v cmn 认这个），显示名把两段拼起来便于辨认
            list.push({ name: `${cols[1]} ${cols[3]}`.trim(), id: cols[1], lang: cols[1], engine: 'espeak' })
          }
          resolve(list)
        })
      }
      // 两个都没有时留一条明确日志：Linux 本地档没声音就是这个原因，别让人猜
      tryBin('espeak-ng', () => tryBin('espeak', () => {
        log('本地语音不可用：本机既没有 espeak-ng 也没有 espeak，装任意一个即可')
        resolve([])
      }))
    })

    /** 按名字去重：同名保留先出现的（Windows 上 WinRT 排在 SAPI 前面，那一份音质更好）。 */
    const dedupeVoices = (list) => {
      const seen = new Set()
      const out = []
      for (const voice of list) {
        const key = String(voice.name || '').toLowerCase()
        if (key === '' || seen.has(key)) continue
        seen.add(key)
        out.push(voice)
      }
      return out
    }

    const probeLocalVoicesNow = () => {
      if (IS_MAC) return probeSayVoices()
      if (IS_WIN) {
        return Promise.all([probeWinrtVoices(), probeSapiVoices()])
          .then(([winrt, sapi]) => dedupeVoices([...winrt, ...sapi]))
      }
      return probeEspeakVoices()
    }

    /** 本机声线清单，缓存 5 分钟（中途装语音包时点「重新检测」可立刻刷新）。 */
    let localVoicesCache = null
    /** 给 /state 与设置页用的快照：挂载后异步探一次。 */
    let localVoicesSnapshot = []
    let localVoiceSnapshot = null
    const probeLocalVoices = () => new Promise((resolve) => {
      const now = Date.now()
      if (localVoicesCache && now - localVoicesCache.at < 5 * 60 * 1000) {
        resolve(localVoicesCache.list)
        return
      }
      probeLocalVoicesNow()
        .then((list) => {
          localVoicesCache = { at: now, list }
          resolve(list)
        })
        .catch(() => resolve([]))
    })

    /**
     * 挑一条要用的本机声线：用户选的那条优先；它被卸载了就按优选顺序重挑。
     * 顺序是「偏好表命中 → 中文声线 → 清单第一条」，保证总有声音，不会因为
     * 用户选过的声线消失而变成哑巴。
     */
    const pickLocalVoice = (list) => {
      if (!Array.isArray(list) || list.length === 0) return null
      const want = String(settings.localVoice || '')
      if (want !== '') {
        const hit = list.find((voice) => voice.name === want || voice.id === want)
        if (hit) return hit
      }
      for (const key of LOCAL_VOICE_PREFER) {
        const hit = list.find((voice) => String(voice.name).toLowerCase().includes(key.toLowerCase()))
        if (hit) return hit
      }
      const zhHit = list.find((voice) => RE_ZH_LANG.test(String(voice.lang || '')))
      return zhHit || list[0]
    }

    /**
     * 本机有没有「自然语音」（晓晓这类神经语音）。
     * Windows 上只有 Huihui/Kangkang/Yaoyao 这几个老式机器音时返回 false。
     */
    const hasNaturalLocalVoice = (list) => list.some((voice) => /Xiaoxiao|Xiaoyi|Yunxi|Yunyang|Yunjian/i.test(voice.name))

    /** 挂载后探一次本机语音，结果同时供 /state 与设置页使用。失败不重试、不影响播报。 */
    const refreshLocalVoices = (force = false) => {
      if (force) localVoicesCache = null
      return probeLocalVoices()
        .then((list) => {
          localVoicesSnapshot = list
          localVoiceSnapshot = pickLocalVoice(list)
          // 这条日志是「本机到底探到几条声线、走哪个后端」的唯一现场证据
          log(`local voices: n=${list.length} pick=${localVoiceSnapshot ? `${localVoiceSnapshot.name}/${localVoiceSnapshot.engine}` : 'none'} [${list.map((voice) => `${voice.name}/${voice.engine}`).join(', ')}]`)
          bump()
          return list
        })
        .catch(() => localVoicesSnapshot)
    }

    /**
     * WinRT 本地合成。自然语音（晓晓这类）只挂在 Windows.Media.SpeechSynthesis 这一层，
     * SAPI 的 GetInstalledVoices 看不见它们，所以这两条路要分开走。
     */
    const synthesizeLocalWinRT = (text, voice) => new Promise((resolve, reject) => {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const txtPath = path.join(LOCAL_AUDIO_DIR, `winrt-${stamp}.txt`)
      const wavPath = path.join(LOCAL_AUDIO_DIR, `winrt-${stamp}.wav`)
      const edgeRate = Number(String(settings.rate || '0').replace('%', '')) || 0
      const rateExpr = `${edgeRate > 0 ? '+' : ''}${Math.max(-50, Math.min(50, edgeRate))}%`
      const cleanup = () => {
        try { fs.unlinkSync(txtPath) } catch { /* 已经不在就算了 */ }
        try { fs.unlinkSync(wavPath) } catch { /* 同上 */ }
      }
      try {
        ensureWinrtScripts()
        fs.writeFileSync(txtPath, text, 'utf8')
      } catch (error) {
        reject(error)
        return
      }
      execFile(
        POWERSHELL_EXE,
        [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINRT_SYNTH_PS1,
          '-TextFile', txtPath, '-OutWav', wavPath, '-VoiceMatch', voice ? voice.name : '', '-Rate', rateExpr,
        ],
        { timeout: 25_000, windowsHide: true },
        (error) => {
          if (error) {
            cleanup()
            reject(error)
            return
          }
          try {
            // 读回 + 校验统一走 readWav：空音频（只有文件头）会在那里抛 emptyAudio，
            // 上层据此换一条能念中文的声线，绝不把 0 秒的段当成功
            const { buffer, duration } = readWav(wavPath)
            cleanup()
            resolve({
              audio: buffer,
              duration,
              sentenceBoundaries: [],
              mime: 'audio/wav',
              voiceName: voice ? voice.name : '',
            })
          } catch (readError) {
            cleanup()
            reject(readError)
          }
        },
      )
    })

    /**
     * 语速换算：Edge 用百分比，say / espeak 用「词/分钟」。
     * 基线 180，'+5%' → 189，'-30%' → 126，夹在 80~420 之间防止离谱值。
     */
    const localWpm = () => {
      const edgeRate = Number(String(settings.rate || '0').replace('%', '')) || 0
      return Math.max(80, Math.min(420, Math.round(180 * (1 + edgeRate / 100))))
    }

    /**
     * 读回后端刚写出的 WAV：offset 28 是 byteRate，data 从 44 起，三端共用这一套算法。
     * 只有一个文件头、没有音频数据时抛 emptyAudio —— 纯英文声线念中文就会这样，
     * 上层据此换一条中文声线重来，绝不静默丢一段。
     */
    const readWav = (wavPath) => {
      const buffer = fs.readFileSync(wavPath)
      const byteRate = buffer.length >= 44 ? buffer.readUInt32LE(28) : 0
      const duration = byteRate > 0 ? Math.max(0, buffer.length - 44) / byteRate : 0
      if (duration <= 0.05) {
        const error = new Error(`synthesis produced empty audio (bytes=${buffer.length})`)
        error.emptyAudio = true
        throw error
      }
      return { buffer, duration }
    }

    /**
     * macOS：用系统自带的 say。
     *
     * 文本走 -f 从文件读——命令行里的中文引号和换行会被切碎。
     * 输出显式指定 RIFF WAVE + 16bit PCM：say 默认写 AIFF，浏览器 Audio 播不了。
     */
    const synthesizeLocalSay = (text, voice) => new Promise((resolve, reject) => {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const txtPath = path.join(LOCAL_AUDIO_DIR, `say-${stamp}.txt`)
      const wavPath = path.join(LOCAL_AUDIO_DIR, `say-${stamp}.wav`)
      const cleanup = () => {
        try { fs.unlinkSync(txtPath) } catch { /* 已经不在就算了 */ }
        try { fs.unlinkSync(wavPath) } catch { /* 同上 */ }
      }
      try {
        fs.mkdirSync(LOCAL_AUDIO_DIR, { recursive: true })
        fs.writeFileSync(txtPath, text, 'utf8')
      } catch (error) {
        reject(error)
        return
      }
      const args = []
      // 没选中声线就不传 -v，交给系统默认，别把空字符串塞进参数
      if (voice && voice.name) args.push('-v', voice.name)
      args.push(
        '-r', String(localWpm()),
        '--file-format=WAVE', '--data-format=LEI16@22050',
        '-f', txtPath, '-o', wavPath,
      )
      execFile('say', args, { timeout: 25_000 }, (error) => {
        if (error) {
          cleanup()
          // say 是系统自带，正常不会缺；被裁剪的发行版或沙盒里可能没有。
          // 这是确定性失败：重试多少次都不会出声，标成 fatal 让合成泵放慢重试。
          if (error.code === 'ENOENT' || error.code === 'EACCES') {
            error.fatal = true
            error.message = `local say unavailable (${error.code})`
          }
          reject(error)
          return
        }
        try {
          const { buffer, duration } = readWav(wavPath)
          cleanup()
          resolve({
            audio: buffer,
            duration,
            sentenceBoundaries: [],
            mime: 'audio/wav',
            voiceName: voice && voice.name ? voice.name : 'say',
          })
        } catch (readError) {
          cleanup()
          reject(readError)
        }
      })
    })

    /**
     * Linux：用 espeak-ng（没装就退回老版 espeak）。
     *
     * -v 认语言代码（cmn / zh），-s 是词/分钟，-w 直接写 WAV，-f 从文件读文本。
     * 音质是这批里最机械的，但它是唯一「装完就有声音、完全离线」的 Linux 方案。
     */
    const synthesizeLocalEspeak = (text, voice) => new Promise((resolve, reject) => {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const txtPath = path.join(LOCAL_AUDIO_DIR, `esp-${stamp}.txt`)
      const wavPath = path.join(LOCAL_AUDIO_DIR, `esp-${stamp}.wav`)
      const cleanup = () => {
        try { fs.unlinkSync(txtPath) } catch { /* 已经不在就算了 */ }
        try { fs.unlinkSync(wavPath) } catch { /* 同上 */ }
      }
      try {
        fs.mkdirSync(LOCAL_AUDIO_DIR, { recursive: true })
        fs.writeFileSync(txtPath, text, 'utf8')
      } catch (error) {
        reject(error)
        return
      }
      const bin = espeakBinary || 'espeak-ng'
      const args = ['-w', wavPath, '-f', txtPath, '-s', String(localWpm())]
      if (voice && voice.id) args.push('-v', voice.id)
      execFile(bin, args, { timeout: 25_000 }, (error) => {
        if (error) {
          cleanup()
          // 二进制根本不在（Linux 上没装 espeak-ng / espeak）：确定性失败。
          // 重试一万次也不会出声，标成 fatal 让合成泵把重试间隔拉到 60 秒，
          // 而不是每 15 秒刷一条日志、整篇却一直静默。
          if (error.code === 'ENOENT' || error.code === 'EACCES') {
            error.fatal = true
            error.message = `local espeak binary unavailable: ${bin} (${error.code})`
          }
          reject(error)
          return
        }
        try {
          const { buffer, duration } = readWav(wavPath)
          cleanup()
          resolve({
            audio: buffer,
            duration,
            sentenceBoundaries: [],
            mime: 'audio/wav',
            voiceName: voice && voice.id ? voice.id : bin,
          })
        } catch (readError) {
          cleanup()
          reject(readError)
        }
      })
    })

    /**
     * 本地合成总入口，按平台 + 声线所选后端分派。
     *
     * Windows：用户选的若是 SAPI 声线就直接走 SAPI；否则先试 WinRT（自然语音音质最好），
     *          失败再落 SAPI，两级都留日志——那是「这台机器实际走哪条路」的唯一证据。
     * macOS：say 一条路。Linux：espeak-ng 一条路。
     * 三端都不联网、不注册、不装运行库。
     */
    const synthesizeLocal = async (text) => {
      // 首次就念、清单还没探到：补探一次（用户可能刚装完语音包）
      if (localVoicesSnapshot.length === 0) {
        await refreshLocalVoices().catch(() => {})
      }
      const voice = pickLocalVoice(localVoicesSnapshot)

      const run = async (target) => {
        if (IS_MAC) return synthesizeLocalSay(text, target)
        if (!IS_WIN) return synthesizeLocalEspeak(text, target)
        if (target && target.engine === 'sapi') {
          return synthesizeLocalSapi(text, target.name)
        }
        try {
          return await synthesizeLocalWinRT(text, target)
        } catch (error) {
          if (error?.emptyAudio) throw error
          log(`winrt→sapi fallback chars=${text.length} err=${String(error?.message ?? error).split('\n')[0]}`)
          return synthesizeLocalSapi(text, target ? target.name : LOCAL_VOICE)
        }
      }

      try {
        return await run(voice)
      } catch (error) {
        // 空音频：多半是用户选了一条纯英文声线去念中文（SAPI 会吐一个只有文件头的空 WAV）。
        // 不静默丢这一段，换清单里的中文声线再合一遍；还是空就抛给合成泵去重试。
        if (error?.emptyAudio) {
          const zhVoice = localVoicesSnapshot.find((item) => RE_ZH_LANG.test(String(item.lang || '')))
          if (zhVoice && (voice === null || zhVoice.name !== voice.name)) {
            log(`本机声线 ${voice ? voice.name : '默认'} 念中文出空音频，改用 ${zhVoice.name} 重试`)
            return run(zhVoice)
          }
          log(`本机声线 ${voice ? voice.name : '默认'} 念中文出空音频，且清单里没有别的中文声线`)
        }
        throw error
      }
    }

    /**
     * 本地兜底合成：调 Windows 自带的 System.Speech 写一个 WAV 出来，再读回内存。
     *
     * 为什么需要它：Edge 那边每段固定要 2.5~7 秒，还有约三分之一概率卡到 21.5 秒超时。
     * 实时路径虽然能把增量文本早早切好送过来，但全都堵在合成这一步上 ——
     * 实测用户按回车到听见第一声要 43~105 秒。本地这一段实测 28 字 282ms，
     * 是让「边生成边念」真正能听见的唯一办法。
     *
     * 代价是音质：Microsoft Huihui 是上一代机器合成，没有 Edge 神经声线自然。
     */
    const synthesizeLocalSapi = (text, voiceName = LOCAL_VOICE) => new Promise((resolve, reject) => {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const wantVoice = String(voiceName || LOCAL_VOICE).trim() || LOCAL_VOICE
      let txtPath = ''
      let wavPath = ''
      try {
        fs.mkdirSync(LOCAL_AUDIO_DIR, { recursive: true })
        txtPath = path.join(LOCAL_AUDIO_DIR, `sapi-${stamp}.txt`)
        wavPath = path.join(LOCAL_AUDIO_DIR, `sapi-${stamp}.wav`)
        // 文本走文件传，别塞进命令行：中文引号和换行会把参数切碎
        fs.writeFileSync(txtPath, text, 'utf8')
      } catch (error) {
        reject(error)
        return
      }
      // SAPI 的 Rate 是 -10~10 整数；Edge 那边 '+10%' 大约相当于 Rate=2
      const edgeRate = Number(String(settings.rate || '0').replace('%', '')) || 0
      const sapiRate = Math.max(-10, Math.min(10, Math.round(edgeRate / 5)))
      const script = [
        'Add-Type -AssemblyName System.Speech',
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
        // 声线名走环境变量：用户装的声线可能带单引号，拼进脚本会把命令切断。
        // 名字不存在（被卸载了）也不让它抛：包一层 try，退回系统默认声线照样出声。
        'try { $s.SelectVoice($env:LS_VOICE) } catch { }',
        `$s.Rate = ${sapiRate}`,
        '$s.SetOutputToWaveFile($env:LS_WAV)',
        '$body = Get-Content -LiteralPath $env:LS_TXT -Raw -Encoding utf8',
        'if ($body) { $s.Speak($body) }',
        '$s.Dispose()',
      ].join('; ')
      execFile(
        POWERSHELL_EXE,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        {
          timeout: 25_000,
          windowsHide: true,
          env: { ...process.env, LS_WAV: wavPath, LS_TXT: txtPath, LS_VOICE: wantVoice },
        },
        (error) => {
          const cleanup = () => {
            try { fs.unlinkSync(txtPath) } catch { /* 已经不在就算了 */ }
            try { fs.unlinkSync(wavPath) } catch { /* 同上 */ }
          }
          if (error) {
            cleanup()
            reject(error)
            return
          }
          try {
            // readWav 在 data 段为空（例如纯英文声线念中文只吐 46 字节文件头）时抛
            // emptyAudio，交给 synthesizeLocal 换中文声线重来，不静默丢这一整段
            const { buffer, duration } = readWav(wavPath)
            cleanup()
            // 本地出的是 WAV，传回去时要让 /audio 路由按真实类型下发，
            // 否则浏览器拿到 Content-Type=audio/mpeg 的 WAV 有可能直接拒绝播
            resolve({ audio: buffer, duration, sentenceBoundaries: [], mime: 'audio/wav', voiceName: wantVoice })
          } catch (readError) {
            cleanup()
            reject(readError)
          }
        },
      )
    })

    /**
     * 调用 Edge 合成一段；429/网络错走指数退避，别一段就把整轮播报拖死。
     * ttsEngine='local' 时整段走本地；其余（'edge' / 老配置的 'auto'）只走 Edge，
     * 失败就抛给合成泵——那一层会一直重试到成功，绝不丢这一段。
     */
    /**
     * 给一次合成套一条总时长硬上限。
     *
     * Edge 那个 timeout 只覆盖连接和首包，合成阶段卡住它管不了；超时就把这次当失败
     * 抛出去，由上面那两层重试接手。底层 socket 收不到取消信号，所以超时后调用方
     * 会把共享实例丢掉（engine = null），下一次重试新建一条干净的连接。
     */
    const withDeadline = (promise, ms) => new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const error = new Error(`合成总时长超限 watchdog timeout ${ms}ms`)
        error.deadline = true
        reject(error)
      }, ms)
      promise.then(
        (value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error)
        },
      )
    })

    const synthesize = async (text, voice) => {
      if (settings.ttsEngine === 'local') return synthesizeLocal(text)
      // 线上档就是纯线上：失败不换成本地声线。宁可这一段跳过去，
      // 也不能让同一篇里一半晓晓一半瑶瑶——那比少一句话难听得多。
      await ensureEngine()
      let last
      for (let attempt = 0; attempt < SYNTH_RETRIES; attempt += 1) {
        try {
          const result = await withDeadline(
            tts().generate(text, voice, {
              rate: settings.rate,
              volume: settings.volume,
              outputFormat: engineModule.Constants.OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3,
              // 卡住的那次是 21.5 秒的 socket 超时；8 秒还没数据就放弃，交给上面的重试
              timeout: EDGE_TIMEOUT_MS,
            }),
            SYNTH_DEADLINE_MS,
          )
          if (!result?.audio || result.audio.length === 0) throw new Error('合成结果为空')
          return result
        } catch (error) {
          last = error
          // 卡死的那条 socket 已经不可信，丢掉实例让下一次重试重连
          if (error?.deadline) engine = null
          const status = Number(error?.status ?? 0)
          const message = String(error?.message ?? error)
          // 内层自救也要留痕：否则日志上只会看到一段莫名多等了二十秒
          log(`synth inner fail chars=${text.length} attempt=${attempt + 1} deadline=${error?.deadline === true} err=${message}`)
          const retryable = status === 429
            || status === 503
            || status === 0
            || /429|too many|rate limit|timeout|ECONN|socket|handshake/i.test(message)
          if (!retryable || attempt === SYNTH_RETRIES - 1) break
          await sleep(SYNTH_RETRY_BASE_MS * 2 ** attempt)
        }
      }
      throw last ?? new Error('合成失败')
    }

    /**
     * 合成泵：单路串行 + 只领先播报一段。
     *
     * 这里曾经是两路并行、一次性把整篇全合成放到 ready 里。它的问题不在"合成不够快"，
     * 而在顺序：播放必须按 id 从小到大取，两路乱序完成时最小的 id 常常最后一个落地，
     * 后面早就合好的段也只能干等（日志实测干等 5.4 秒）。
     *
     * 现在改成"边播边合下一段"的流水线：合成第 n 段成功后立刻接着合第 n+1 段，
     * 但 ready 里最多留 MAX_SYNTH_LEAD 段。300 字播一分钟、合成只要 5~10 秒，
     * 余量足够，所以既不会断，也不会并发去撞 429。
     */
    const pump = async () => {
      if (working) return
      working = true
      bump()
      const worker = async () => {
        // 只领先 MAX_SYNTH_LEAD 段：够下一段马上接上就行，再多只是白占内存。
        // 队列没被推满时会在这里停下，等客户端播完一段、/consume 回掉一段，再继续。
        while (jobs.length > 0 && ready.size < MAX_SYNTH_LEAD) {
          const job = jobs.shift()
          const text = job.text
          // id 在取任务时就分配，保证 id 顺序 == 入队顺序
          const id = nextId
          nextId += 1
          // 内容完整性优先：合不出来就一直等它合出来，绝不丢一段。
          // 唯一的中断条件是新一轮请求把 epoch 推走——那时整篇本来就不该再念了。
          const myEpoch = epoch
          let attempt = 0
          while (true) {
            if (epoch !== myEpoch) break
            try {
              const voice = resolveVoiceFor(text)
              const result = await synthesize(text, voice)
              const item = {
                id,
                text,
                index: job.index,
                total: job.total,
                chars: text.length,
                voice,
                // preview 是给客户端卡片当歌词看的，42 字太短会半句截断；
                // 放宽到 120 字，即使用 3 行小字号也放得下，整段播报不会被省略号切掉
                preview: text.length > 120 ? `${text.slice(0, 120)}…` : text,
                // LRC 时间轴：块内每句的起点/时长（秒），客户端按 currentTime 找当前句
                cues: buildCues(job.lines || splitLyricLines(text), result),
                buffer: Buffer.isBuffer(result.audio) ? result.audio : Buffer.from(result.audio),
                duration: Number(result.duration) || 0,
                // Edge 回来的是 MP3、本地兜底回来的是 WAV，路由按这个下发 Content-Type
                mime: result.mime === 'audio/wav' ? 'audio/wav' : 'audio/mpeg',
                chime: job.chime === true,
                at: Date.now(),
              }
              ready.set(item.id, item)
              lastError = ''
              synthFailCount = 0
              synthTroubleSince = 0
              trimReady()
              // 日志里的声线名要写「真正发声的那条」：本地档是系统声线（瑶瑶/Huihui），
              // 不是 Edge 的 id，否则又会造出「显示晓晓、实际念瑶瑶」那种假记录
              log(`synth ok id=${item.id} voice=${result.voiceName || item.voice} chars=${item.chars} bytes=${item.buffer.length} dur=${item.duration}`)
              bump()
              break
            } catch (error) {
              attempt += 1
              synthFailCount += 1
              // 第一次失败就记下起点，之后一直累积；成功一次就清零（见上面的 synth ok）。
              // 只认当前这一篇的失败：被清空/换篇之后才返回的旧尝试不算，
              // 否则点完"停止"卡片会一直挂着"正在重试"，实际什么都没在做。
              if (epoch === myEpoch && synthTroubleSince === 0) synthTroubleSince = Date.now()
              lastError = String(error?.message ?? error).split('\n')[0]
              bump()
              if (epoch !== myEpoch) break
              // 后端二进制不存在（Linux 没装 espeak-ng，或 mac 上的 say 被裁掉）属于确定性失败：
              // 重试一万次也不会出声，但这一段也不能丢（内容完整性优先）。
              // 所以照样一直重试——用户装上后端、或切回线上档（epoch 变化）就自动恢复——
              // 只把间隔拉到 60 秒、日志每 10 次才报一条，避免整篇静默的同时还在刷屏。
              if (error?.fatal) {
                if (attempt % 10 === 1) {
                  log(`local backend unavailable id=${id} attempt=${attempt} err=${lastError} retry_in=60s`)
                }
                await sleep(60_000)
                continue
              }
              log(`synth fail id=${id} chars=${text.length} attempt=${attempt} err=${lastError}`)
              // 退避翻倍、封顶 15 秒：Edge 恢复后这一段一定能补上，只是可能要等一会儿
              const backoff = Math.min(SYNTH_RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 4), SYNTH_RETRY_MAX_MS)
              log(`synth retry id=${id} attempt=${attempt} retry_in=${backoff}ms`)
              await sleep(backoff)
            }
          }
        }
      }
      try {
        const lanes = Math.min(MAX_SYNTH_PARALLEL, Math.max(1, jobs.length))
        await Promise.all(Array.from({ length: lanes }, worker))
      } finally {
        working = false
        bump()
      }
    }

    /**
     * 把一段文本排进合成队列。
     * @param text 原始文本（会清洗、分段）
     * @param options.interrupt 是否清掉之前没播完的内容
     */
    const enqueue = (text, options = {}) => {
      const { interrupt = false, cleaned = false, chime = false } = options
      // cleaned=true 表示调用方已经过了 cleanForSpeech：别再洗一遍，
      // 否则"记进已送文本的字数"和"真正送去合成的内容"会对不齐，尾巴补播就会重复。
      const spoken = cleaned === true ? String(text ?? '') : cleanForSpeech(text)
      if (spoken === '') return { chunks: 0, chars: 0 }
      const chunks = chunkText(spoken, settings.targetChars, FIRST_CHUNK_CHARS).filter(speakable)
      if (chunks.length === 0) return { chunks: 0, chars: 0 }
      if (interrupt) resetQueue({ epochChange: true })
      const total = chunks.length
      jobs.push(...chunks.map((text, index) => ({
        text,
        index: index + 1,
        total,
        // 歌词行（逗号也断）：合成后会被配上时间点，成为客户端歌词区滚动用的 LRC 时间轴
        lines: splitLyricLines(text),
        // 只给这一段的第一块：静默太久之后重新开口，客户端会在它前面先"叮"一声
        chime: chime === true && index === 0,
      })))
      log(`enqueue chunks=${total} chars=${chunks.reduce((s, c) => s + c.length, 0)} interrupt=${interrupt}`)
      // 每段的头尾各记一小截：排查"标题和正文连读"时，看的就是标题后面到底有没有省略号
      chunks.forEach((piece, i) => log(`enqueue seg ${i + 1}/${total} len=${piece.length} head=${JSON.stringify(piece.slice(0, 16))} tail=${JSON.stringify(piece.slice(-10))}`))
      void pump()
      return { chunks: chunks.length, chars: chunks.reduce((sum, piece) => sum + piece.length, 0) }
    }

    /**
     * 静音回合真正收尾：念最后那一份的结果段。
     * 一轮里模型可能反复重试（每次都落一条 assistant/message），
     * 只在 turn/end（或兜底计时）念一次，就不会连着念好几遍。
     */
    const flushQuietTurn = (reason) => {
      if (quietPendingTimer !== null) {
        clearTimeout(quietPendingTimer)
        quietPendingTimer = null
      }
      const whole = quietPending
      quietPending = ''
      const ask = quietAsk
      quietAsk = []
      const quietStarted = quietStartedAt
      quietStartedAt = 0
      codeQuietTurn = false
      if (whole === '') return
      quietSettledAt = Date.now()
      const tail0 = resultTail(whole)
      // 收尾段可能整段已经在开场那几句里念过：正文本来就短（判定成代码时
      // 全文只剩三五句），开场已经念完，这时再 enqueue 就是整段重播。
      // 实机 1.0.176 出现过「3 句各念两遍」，这里先跟已送文本对一次重合。
      const ov = tail0 === '' ? { replay: true, tail: '' } : liveOverlap(tail0, liveSentText)
      const tail = ov.replay ? ov.tail : tail0
      // 中途反问：结果段只覆盖尾部 320 字，模型在正文中间问的"你想要哪种风格？"
      // 会落在尾部之外，用户得盯着屏幕才知道它在等他。这里把没被覆盖的问句补念。
      const askPending = ask.filter((sentence) => !(tail !== '' && tail.includes(sentence)))
      const askText = askPending.join('')
      const hasContent = tail !== '' || askText !== ''
      const chime = shouldChime(quietStarted, Date.now(), hasContent)
      if (askText !== '' && tail !== '') {
        log(`静音模式：补念中途反问 ${askPending.length} 句 chars=${askText.length}（结果段里没有这几句）`)
      } else if (askText !== '') {
        log(`静音模式：只补念中途反问 ${askPending.length} 句 chars=${askText.length}（结果段已在开场念过）`)
      }
      if (chime) {
        log(`静音模式收尾：静了 ${Math.round((Date.now() - quietStarted) / 1000)}s，开口前先响一声提示音`)
      }
      if (askText !== '') {
        // 问句在前、结果段在后：先让用户听到"它在等你回复"，再听结果
        enqueue(askText, { interrupt: false, cleaned: true, chime })
      }
      if (tail !== '') {
        log(`静音模式收尾（${reason}）：只念结果段 chars=${tail.length}（全文 ${whole.length}）`)
        // interruptOnNew 在这里要关掉：这条尾巴是"同一回合的收尾"，
        // 打断会切掉正在念的那句，用户听到的就是"念到一半又从头"
        enqueue(tail, { interrupt: false, cleaned: true, chime: chime && askText === '' })
        liveSentText = whole
      } else if (tail0 !== '') {
        log(`静音模式收尾（${reason}）：结果段已经在开场念过，不再重播（全文 ${whole.length} 字）`)
        liveSentText = whole
      } else if (askText === '') {
        log(`静音模式收尾（${reason}）：清洗后没有可念内容（全文 ${whole.length} 字）`)
      }
      lastFullKey = speechKey(whole)
      lastFullAt = Date.now()
    }

    const voiceLabel = (voice) => {
      const found = VOICES.find((item) => item.id === voice)
      return found === undefined ? voice : found.label
    }
    /** 只取名字（"晓晓"），用于念出来的句子；固件名带括号描述念出来很怪。 */
    const voiceName = (voice) => {
      const label = voiceLabel(voice)
      const cut = label.split('·')[0]
      return cut.trim() === '' ? voice : cut.trim()
    }

    /**
     * 试听文案得跟声线语言对上：拿英文声线去念中文会被回退成晓晓，
     * 试听就成了"英式声线说中文"的假象，听不出声线本身的区别。
     */
    const previewTextFor = (voice) => {
      const name = voiceName(voice)
      if (/^en-/iu.test(voice)) {
        return `Hello, I am ${name}. This is a preview of dsh-live-speak at speed ${settings.rate}.`
      }
      return `你好，我是${name}。这是 dsh-live-speak 的试听，语速 ${settings.rate}。`
    }

    /** 手动念一段：/live-speak 与 /edge say 共用同一套逻辑。 */
    const speakNow = (raw) => {
      const text = String(raw ?? '').trim()
      if (text === '') return { kind: 'error', text: '用法：/live-speak 你要念的话' }
      const plan = enqueue(text, { interrupt: true })
      if (plan.chunks === 0) {
        return { kind: 'error', text: '这段里没有可念的内容（代码、表格、链接会被跳过）。' }
      }
      return {
        kind: 'success',
        text: `已排入 ${plan.chunks} 段、约 ${plan.chars} 字，用「${voiceLabel(settings.voice)}」念，首段合成好就开始播。`,
      }
    }

    const snapshot = (afterId = 0) => {
      // 两路并行合成时 ready 的写入顺序可能乱，按 id 排回来，客户端才能按顺序播
      const ordered = [...ready.values()].sort((a, b) => a.id - b.id)
      const items = []
      for (const item of ordered) {
        if (item.id <= afterId) continue
        items.push({ id: item.id, chars: item.chars, preview: item.preview, duration: item.duration, index: item.index, total: item.total, cues: item.cues || [], chime: item.chime === true })
      }
      // 「下一句」不依赖合成进度：已合成的取 ready 里 cursor 之后最早那条，还在合成的就取 jobs 队首。
      // 一句一段之后段间空档变长，不这样做歌词区第三排会一直闪空。
      let nextSource = null
      for (const item of ordered) {
        if (item.id > afterId) {
          nextSource = item
          break
        }
      }
      if (nextSource === null && jobs.length > 0) nextSource = jobs[0]
      const nextText = nextSource === null ? '' : (nextSource.preview !== undefined
        ? nextSource.preview
        : (nextSource.text.length > 120 ? `${nextSource.text.slice(0, 120)}…` : nextSource.text))
      // 本机模式下面板和日志要显示真正发声的那条声线，否则写着"晓晓"、实际念的是瑶瑶
      const localDisplay = (localVoiceSnapshot?.name || LOCAL_VOICE)
        .replace(/^Microsoft\s+/i, '')
        .replace(/\s+Desktop$/i, '')
      return {
        ok: true,
        rev,
        epoch,
        auto: settings.auto,
        pending: jobs.length,
        synthesizing: working,
        ready: items,
        nextText,
        oldestId: (() => {
          let min = 0
          for (const id of ready.keys()) if (min === 0 || id < min) min = id
          return min
        })(),
        settings: {
          voice: settings.voice,
          voiceLabel: settings.ttsEngine === 'local' ? `${localDisplay}·本机` : voiceLabel(settings.voice),
          voiceName: settings.ttsEngine === 'local' ? localDisplay : voiceName(settings.voice),
          previewText: settings.ttsEngine === 'local'
            ? `你好，我是${localDisplay}。这是 dsh-live-speak 的试听，语速 ${settings.rate}。`
            : previewTextFor(settings.voice),
          rate: settings.rate,
          volume: settings.volume,
          targetChars: settings.targetChars,
          playbackVolume: settings.playbackVolume,
          interruptOnNew: settings.interruptOnNew,
          realtime: settings.realtime,
          codeQuiet: settings.codeQuiet,
          dockExpanded: settings.dockExpanded,
          dock: settings.dock,
          eq: settings.eq,
          ttsEngine: settings.ttsEngine,
          /** 本机声线清单（三端统一结构：name / id / lang / engine），空数组＝还没探到。 */
          localVoices: localVoicesSnapshot,
          /** 当前实际发声的那条（用户没选时是自动挑出来的），设置页面下拉就选它。 */
          localVoice: localVoiceSnapshot ? localVoiceSnapshot.name : '',
          /** 用户自己选过的那条，空＝让它自动挑。 */
          localVoiceSelected: settings.localVoice,
          /** 实际走的本机后端：winrt / sapi / say / espeak。 */
          localVoiceEngine: localVoiceSnapshot ? localVoiceSnapshot.engine : '',
          hasNaturalLocalVoice: hasNaturalLocalVoice(localVoicesSnapshot),
        },
        /** 设置面板的声线下拉用这份清单，避免客户端自己维护一份。 */
        voices: VOICES,
        error: lastError,
        failCount: synthFailCount,
        /**
         * 合成连续失败超过 15 秒时的状态，正常为 null。
         * 只在"确实还在合成"时报：清空队列、或者这一篇被推走之后，
         * pump 已经不在跑，残留的失败计时不该继续挂在卡片上。
         */
        trouble: (synthTroubleSince === 0 || !working)
          ? null
          : (() => {
            const seconds = Math.round((Date.now() - synthTroubleSince) / 1000)
            return seconds >= 15 ? { seconds, error: lastError } : null
          })(),
      }
    }

    // ── 自动播报 ────────────────────────────────────────────────
    // 事件类型首次出现时记一条日志：用来核实 DSH 到底给了插件哪些事件（尤其有没有流式增量）。
    const seenEventTypes = new Set()
    const eventDisposer = ctx.on('session/event', (session, event) => {
      try {
        const eventType = String(event?.type ?? '?')
        if (!seenEventTypes.has(eventType)) {
          seenEventTypes.add(eventType)
          log(`event 类型首次出现：${eventType}`)
        }
        // 工具调用：只有"写文件 / 编辑文件"这一类才算"要写代码"。
        // 1.0.183 及以前是"一切到 tool-call 块就整轮静音"，于是「读一下这个文件，用中文总结」
        // 这种纯文本请求也被打进静音模式（1.0.183 实机 04:46 就复现了）。
        // 块类型里没有工具名（chunk 只有 type/index/blockType），名字只能从 tool/call 事件拿。
        if (eventType === 'tool/call') {
          const raw = JSON.stringify(event?.data ?? {})
          const toolName = String(event?.data?.name ?? '')
          // 提问工具：正文里没有这段文字，只有一张选项卡。单独念出来，用户不盯屏幕也知道要回话。
          if (ASK_TOOL.test(toolName)) {
            const questions = extractAskQuestions(raw)
            if (askProbeSeen !== true) {
              askProbeSeen = true
              log(`提问工具参数：${String(raw).replace(/\s+/gu, ' ').slice(0, 400)}`)
            }
            const key = questions.join('|')
            if (questions.length === 0) {
              log(`提问播报：拿到提问工具（name=${toolName}）但没解析出问句`)
            } else if (key === lastAskKey && Date.now() - lastAskAt < 120_000) {
              log(`提问播报：同一问题念过（${Math.round((Date.now() - lastAskAt) / 1000)}s 前），不再重复`)
            } else {
              lastAskKey = key
              lastAskAt = Date.now()
              const text = `模型在等你回答：${questions.join('；')}`
              // 提问优先：打断正在念的内容，把问题先送出去
              const plan = enqueue(text, { interrupt: true, cleaned: true, chime: true })
              log(`提问播报：${questions.length} 问 chars=${plan.chars}（正文里没有这几句）`)
            }
            return
          }
          if (toolProbeSeen !== true) {
            toolProbeSeen = true
            // 只记工具名和参数的开头：arguments 里可能是整份文件内容，别整段写进日志
            const name = String(event?.data?.name ?? '?')
            const argHead = String(event?.data?.arguments ?? '').replace(/\s+/g, ' ').slice(0, 40)
            log(`tool/call 结构：keys=${Object.keys(event?.data ?? {}).join(',')} name=${name} args=${argHead}`)
          }
          if (settings.codeQuiet === true && codeQuietTurn !== true && looksLikeWriteTool(raw)) {
            codeQuietTurn = true
            quietStartedAt = Date.now()
            quietAsk = []
            log(`进入静音模式：工具是写文件/编辑文件（name=${String(event?.data?.name ?? '?')}）`)
          }
          return
        }
        // 用户发来新消息 = 一个回合重新开始：已送文本清零、允许下一段实时内容打断旧播报。
        // 只认 user/message：turn/start 在每个 step 都可能再来一次，用它会把"同一回合续写"
        // 当成新回复，正在念的半句就被切断（1.0.172 实机仍出现过一次 interrupt=true）。
        if (eventType === 'user/message') {
          // 同一条用户消息在 2 分钟内重复到达 = 宿主/模型在重试这一轮，不是新回合。
          // 当成新回合会让 turnFresh 重新立起，把正在念的结果段切断并整段重念。
          const userKey = speechKey(userTextOf(event))
          const now = Date.now()
          if (userKey !== '' && userKey === lastUserKey && now - lastUserAt < 120_000) {
            log(`skip user/message：同一条用户消息重复到达（${Math.round((now - lastUserAt) / 1000)}s 前），按同一回合续传处理`)
            return
          }
          lastUserKey = userKey
          lastUserAt = now
          if (quietPendingTimer !== null) {
            clearTimeout(quietPendingTimer)
            quietPendingTimer = null
          }
          quietPending = ''
          quietStartedAt = 0
          quietAsk = []
          quietGateLogged = false
          liveSentText = ''
          turnFresh = true
          codeQuietTurn = false
          quietSettledAt = 0
          lastFullKey = ''
          lastFullAt = 0
          log('user/message：新回合，已复位播报闸门与已送文本')
          return
        }
        // 回合真正结束：静音回合在这里念一次结果段（这是"模型输出完了"的硬信号）。
        if (eventType === 'turn/end') {
          flushQuietTurn('回合结束')
          return
        }
        if (event?.type !== 'assistant/message') return
        if (settings.auto !== true) return
        const text = assistantTextOf(event)
        if (text === '') return
        // 同一条正文重复落地（宿主偶尔会把完整快照发两次）就不要再念一遍
        const fullKey = speechKey(text)
        if (fullKey === lastFullKey && Date.now() - lastFullAt < 300_000) {
          log(`skip assistant/message：同一条正文已念过（${Math.round((Date.now() - lastFullAt) / 1000)}s 前）`)
          return
        }
        // 静音回合：结果段已经念过，同一回合后面再来的快照不要再补播。
        // （实机 1.0.174 这里把末尾一句念了两遍：收尾念完，宿主又发稍长快照，
        //   实时对齐把重复的那几个字当成"新增尾巴"又补了一条 cue。）
        if (quietSettledAt !== 0 && codeQuietTurn !== true && Date.now() - quietSettledAt < 600_000) {
          log(`skip assistant/message：静音回合的结果段已念过（${Math.round((Date.now() - quietSettledAt) / 1000)}s 前），不再补播`)
          lastFullKey = fullKey
          lastFullAt = Date.now()
          return
        }
        // 静音模式（设置项 codeQuiet）：本条回复已经判定成"写代码类"。
        // 这里**只记下待念的结果段，不立即念** —— 一轮里模型可能反复重试，
        // 每试一次就落一条 assistant/message，立刻念就会连着念好几遍结果段
        // （1.0.177 实机：48 字、62 字、313 字各念一遍）。真正的"输出完了"
        // 是 turn/end，那时候再念最后一份。
        if (codeQuietTurn === true) {
          const whole = cleanForSpeech(text)
          quietPending = whole
          // 中途反问在这里一次性抓出来：后面几次重试会把 quietPending 覆盖，
          // 但"在等你回话"的问句哪一版都该念，所以只留存最新一版里挑到的
          quietAsk = pendingQuestions(whole)
          if (whole !== '') {
            log(`静音模式：记下结果段待念（全文 ${whole.length} 字，中途反问 ${quietAsk.length} 句），等 turn/end 一并念`)
            if (quietPendingTimer !== null) clearTimeout(quietPendingTimer)
            // 兜底：万一这条回合没有 turn/end，25 秒后也把它念掉
            quietPendingTimer = setTimeout(() => {
              quietPendingTimer = null
              flushQuietTurn('兜底计时')
            }, 25_000)
            if (typeof quietPendingTimer?.unref === 'function') quietPendingTimer.unref()
          }
          lastFullKey = fullKey
          lastFullAt = Date.now()
          return
        }
        // 实时路径送过内容：只念它没送到的那一截，绝不再整段念一遍。
        // 判据是**文本重合度**，不是时间窗 —— 生成代码、写文件时实时流会断好几分钟，
        // 时间窗一过期就会整段从头重念（用户听到的「从第一句开始念」「第三次重念」都是这个）。
        if (settings.realtime === true && liveSentText !== '') {
          const cleaned = cleanForSpeech(text)
          const sentChars = speechKey(liveSentText).length
          const liveAge = Date.now() - lastLiveAt
          // 先按重合度对齐。assistant/message 带的是**累积全文**，实时送过的是它前面一截，
          // 常见形状是"这段的开头落在已送内容中间、一路延伸到已送末尾"（工具调用后宿主重开
          // attempt 从头重发时就是这样），只有把它裁掉才不会整段重念。
          const overlap = liveOverlap(cleaned, liveSentText)
          if (overlap.replay && overlap.tail !== '') {
            log(`补播 assistant/message 尾巴 chars=${overlap.tail.length}（接在已送末尾，已送 ${sentChars} 字）`)
            enqueue(overlap.tail, { interrupt: false, cleaned: true })
            liveSentText += overlap.tail
            lastLiveAt = Date.now()
            return
          }
          if (overlap.replay) {
            log(`skip assistant/message：实时已全播（${Math.round(liveAge / 1000)}s 前，已送 ${sentChars} 字，attempt=${liveAttempt ?? '?'}）`)
            return
          }
          // 再退回前缀法（已送文本就是这条消息的干净前缀时它更准，能保留原文断句）
          const tail = speechTail(cleaned, liveSentText)
          if (tail === '') {
            log(`skip assistant/message：实时已全播（${Math.round(liveAge / 1000)}s 前，已送 ${sentChars} 字，attempt=${liveAttempt ?? '?'}）`)
            return
          }
          if (tail !== cleaned) {
            log(`补播 assistant/message 尾巴 chars=${tail.length}（实时已送 ${sentChars} 字，attempt=${liveAttempt ?? '?'}）`)
            // 尾巴接在实时队列后面念，不能打断正在播的那句
            enqueue(tail, { interrupt: false, cleaned: true })
            // 补播的尾巴也算"已经送出"：宿主对同一条回复可能连发两条完整快照，
            // 不把它记进去，第二条会从同一个断点再补一遍 —— 那正是用户听到的"第三次重念"
            liveSentText += tail
            lastLiveAt = Date.now()
            return
          }
          log(`assistant/message 与实时内容不重合，按另一条回复整段处理（实时 ${sentChars} 字）`)
        }
        log(`event assistant/message chars=${text.length} session=${session?.header?.id ?? '?'}`)
        // enqueue 与已送文本用同一份清洗结果，尾巴补播的字数才对得上
        const whole = cleanForSpeech(text)
        enqueue(whole, { interrupt: settings.interruptOnNew, cleaned: true })
        liveSentText = whole
        lastFullKey = fullKey
        lastFullAt = Date.now()
      } catch {
        // 事件回调绝不能把异常抛回宿主
      }
    })
    if (typeof eventDisposer === 'function') disposers.push(eventDisposer)

    // ── /live-speak ─────────────────────────────────────────────
    // 不用 /speak、/say、/read 这类通用词：别的播报插件很可能已经注册，重名会让注册失败。
    // 用插件自己的名字做前缀，既直观又不会撞。
    try {
      const speakDisposer = ctx.commands.register({
        name: 'live-speak',
        description: '用 Edge 神经语音念一段话（自带播放，可随时暂停）',
        input: { hint: '<文本>' },
        handler: async ({ rawInput }) => speakNow(rawInput),
      })
      if (typeof speakDisposer === 'function') disposers.push(speakDisposer)
      log('command /live-speak 注册成功')
    } catch (error) {
      log(`command /live-speak 注册失败：${String(error?.message ?? error)}`)
      // 命令注册失败不影响自动播报
    }

    // ── /edge ───────────────────────────────────────────────────
    try {
      const edgeDisposer = ctx.commands.register({
      name: 'edge',
      description: 'Edge 语音播报：开关自动念、换声线、调语速、试听',
      input: { hint: '[on|off|test|say <文本>|voice <声线>|rate <+10%>|list]' },
      handler: async ({ rawInput }) => {
        const arg = String(rawInput ?? '').trim()
        const lower = arg.toLowerCase()

        if (arg === '' || lower === 'status') {
          return {
            kind: 'success',
            text: [
              `声线：${voiceLabel(settings.voice)}（${settings.voice}）`,
              `语速：${settings.rate}　合成音量：${settings.volume}　播放音量：${Math.round(settings.playbackVolume * 100)}%`,
              `自动播报：${settings.auto ? '开' : '关'}${settings.interruptOnNew ? '（新回复会打断旧内容）' : '（不打断）'}`,
              `实时播报：${settings.realtime ? '开（边生成边念，一句一合成）' : '关（等整段写完再念）'}`,
              `播放条位置：${DOCK_LABELS[settings.dock]}`,
              `队列：待播 ${ready.size} 段，待合成 ${jobs.length} 段${working ? '（正在合成）' : ''}${lastError === '' ? '' : `；最近失败：${lastError}`}`,
              '用法：/edge on|off　/edge live on|off　/edge dock top|sidebar　/edge test　/edge say <文本>　/edge voice <短名>　/edge rate +10%　/edge list',
            ].join('\n'),
          }
        }

        if (lower === 'on' || lower === 'off') {
          settings.auto = lower === 'on'
          const saved = writeSettings(settings)
          bump()
          return {
            kind: 'success',
            text: `自动播报已${settings.auto ? '开启' : '关闭'}${saved ? '' : '（写盘失败，重启后会恢复默认）'}。`,
          }
        }

        const liveArg = /^live\s+(on|off)$/iu.exec(arg)
        if (liveArg !== null) {
          settings.realtime = liveArg[1].toLowerCase() === 'on'
          const saved = writeSettings(settings)
          bump()
          return {
            kind: 'success',
            text: `实时播报已${settings.realtime ? '开启（边生成边念，一句一合成）' : '关闭（等整段回复写完再念）'}${saved ? '' : '（写盘失败，重启后会恢复默认）'}。`,
          }
        }

        const dockArg = /^dock\s+(top|sidebar)$/iu.exec(arg)
        if (dockArg !== null) {
          settings.dock = dockArg[1].toLowerCase()
          const saved = writeSettings(settings)
          bump()
          return {
            kind: 'success',
            text: `播放条已停靠到${DOCK_LABELS[settings.dock]}${saved ? '' : '（写盘失败，重启后会恢复默认）'}。`,
          }
        }

        if (lower === 'test') {
          const plan = enqueue(previewTextFor(settings.voice), { interrupt: true })
          return plan.chunks === 0
            ? { kind: 'error', text: '试听文本没能排进队列。' }
            : { kind: 'success', text: '已排入试听，等合成完成就会响。' }
        }

        if (lower === 'list') {
          return {
            kind: 'success',
            text: ['可用声线：', ...VOICES.map((item) => `  ${item.id}　${item.label}`), '换声线：/edge voice zh-CN-YunxiNeural'].join('\n'),
          }
        }

        const voiceArg = /^voice\s+(.+)$/iu.exec(arg)
        if (voiceArg !== null) {
          const candidate = voiceArg[1].trim()
          if (!/^[a-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z]+Neural$/u.test(candidate)) {
            return { kind: 'error', text: `声线短名不对：${candidate}。用 /edge list 看可用的短名。` }
          }
          settings.voice = candidate
          writeSettings(settings)
          bump()
          return { kind: 'success', text: `声线已换成 ${voiceLabel(candidate)}（${candidate}）。` }
        }

        const rateArg = /^rate\s+([+-]?\d{1,3}%?)$/iu.exec(arg)
        if (rateArg !== null) {
          const value = rateArg[1].endsWith('%') ? rateArg[1] : `${rateArg[1]}%`
          const num = Number(value.replace('%', ''))
          if (!Number.isFinite(num) || num < -100 || num > 200) {
            return { kind: 'error', text: '语速范围是 -100% ~ +200%。' }
          }
          settings.rate = num >= 0 ? `+${num}%` : `${num}%`
          writeSettings(settings)
          bump()
          return { kind: 'success', text: `语速已设为 ${settings.rate}。` }
        }

        const volArg = /^volume\s+([+-]?\d{1,3}%)$/iu.exec(arg)
        if (volArg !== null) {
          settings.volume = volArg[1]
          writeSettings(settings)
          bump()
          return { kind: 'success', text: `合成音量已设为 ${settings.volume}。` }
        }

        const playArg = /^play\s+(\d{1,3})%?$/iu.exec(arg)
        if (playArg !== null) {
          const num = Number(playArg[1])
          if (num < 0 || num > 100) return { kind: 'error', text: '播放音量范围是 0% ~ 100%。' }
          settings.playbackVolume = num / 100
          writeSettings(settings)
          bump()
          return { kind: 'success', text: `播放音量已设为 ${num}%。` }
        }

        const sayArg = /^(?:say|speak)\s+(.+)$/isu.exec(arg)
        if (sayArg !== null) return speakNow(sayArg[1])
        if (lower === 'say' || lower === 'speak') return speakNow('')

        if (lower === 'clear') {
          resetQueue({ epochChange: true })
          return { kind: 'success', text: '已清空播放队列。' }
        }

        return { kind: 'error', text: '用法：/edge on|off|live on|off|dock top|sidebar|test|list|clear　/edge say <文本>　/edge voice <短名>　/edge rate +10%　/edge play 80%' }
        },
      })
      if (typeof edgeDisposer === 'function') disposers.push(edgeDisposer)
      log('command /edge 注册成功')
    } catch (error) {
      log(`command /edge 注册失败：${String(error?.message ?? error)}`)
      // 命令名被占用时静默放弃，自动播报和播放条仍然可用
    }

    // ── HTTP 路由 ───────────────────────────────────────────────
    // 页面通过 /plugins/dsh-live-speak/* 读状态、取音频、切开关。
    try {
      const ws = ctx.webServer
      if (ws !== undefined && typeof ws.register === 'function') {
        const sendJson = (res, status, payload) => {
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.statusCode = status
          res.end(JSON.stringify(payload))
        }

        const readBody = (req, limit = 64 * 1024) => new Promise((resolve, reject) => {
          let body = ''
          req.on('data', (chunk) => {
            body += chunk
            if (body.length > limit) {
              req.destroy()
              reject(new Error('body too large'))
            }
          })
          req.on('end', () => {
            try {
              resolve(JSON.parse(body === '' ? '{}' : body))
            } catch (error) {
              reject(error)
            }
          })
          req.on('error', reject)
        })

        const stateRoute = ws.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/state`,
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              sendJson(res, 405, { ok: false, error: 'GET only' })
              return
            }
            const url = new URL(req.url ?? '/', 'http://placeholder')
            const afterId = Number(url.searchParams.get('after') ?? '0')
            sendJson(res, 200, snapshot(Number.isFinite(afterId) ? afterId : 0))
          },
        })
        if (typeof stateRoute === 'function') disposers.push(stateRoute)

        const audioRoute = ws.register({
          kind: 'prefix',
          path: `${ROUTE_PREFIX}/audio`,
          handler: async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://placeholder')
            const id = Number(url.pathname.slice(`${ROUTE_PREFIX}/audio`.length).replace(/^\//u, ''))
            if (!Number.isFinite(id) || id <= 0) {
              sendJson(res, 404, { ok: false, error: 'bad id' })
              return
            }
            const item = ready.get(id)
            if (item === undefined) {
              sendJson(res, 404, { ok: false, error: 'not ready or expired' })
              return
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.setHeader('Allow', 'GET, HEAD')
              sendJson(res, 405, { ok: false, error: 'GET only' })
              return
            }
            const total = item.buffer.length
            const range = String(req.headers.range ?? '')
            res.setHeader('Content-Type', item.mime === 'audio/wav' ? 'audio/wav' : 'audio/mpeg')
            res.setHeader('Accept-Ranges', 'bytes')
            res.setHeader('Cache-Control', 'no-store')
            // 支持单区间 Range：Chromium 的 <audio> 会先要一小段探测时长
            const match = /^bytes=(\d*)-(\d*)$/u.exec(range.trim())
            if (match !== null && (match[1] !== '' || match[2] !== '')) {
              let start = match[1] === '' ? total - Number(match[2]) : Number(match[1])
              let end = match[2] === '' ? total - 1 : Number(match[2])
              if (!Number.isFinite(start) || start < 0) start = 0
              if (!Number.isFinite(end) || end >= total) end = total - 1
              if (start > end) {
                res.setHeader('Content-Range', `bytes */${total}`)
                res.statusCode = 416
                res.end()
                return
              }
              const slice = item.buffer.subarray(start, end + 1)
              res.statusCode = 206
              res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`)
              res.setHeader('Content-Length', String(slice.length))
              res.end(req.method === 'HEAD' ? undefined : slice)
              return
            }
            res.statusCode = 200
            res.setHeader('Content-Length', String(total))
            res.end(req.method === 'HEAD' ? undefined : item.buffer)
          },
        })
        if (typeof audioRoute === 'function') disposers.push(audioRoute)

        const post = (suffix, handler) => {
          const route = ws.register({
            kind: 'exact',
            path: `${ROUTE_PREFIX}${suffix}`,
            handler: async (req, res) => {
              if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, error: 'POST only' })
                return
              }
              let body
              try {
                body = await readBody(req)
              } catch {
                sendJson(res, 400, { ok: false, error: 'invalid json' })
                return
              }
              try {
                const result = await handler(body)
                sendJson(res, result.status ?? 200, result.payload)
              } catch (error) {
                sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
              }
            },
          })
          return route
        }

        const routes = [
          // 开关自动播报
          post('/auto', (body) => {
            // 兼容两种字段名：客户端历史版本传过 on，统一按 auto 落盘
            settings.auto = (body?.auto ?? body?.on) === true
            writeSettings(settings)
            if (settings.auto !== true) resetQueue({ epochChange: true })
            bump()
            return { payload: { ok: true, auto: settings.auto } }
          }),
          // 页面播完一段，让宿主回收缓冲，并把合成队列往前推一段
          post('/consume', (body) => {
            const id = Number(body?.id)
            if (Number.isFinite(id) && ready.delete(id)) {
              bump()
              void pump()
            }
            return { payload: { ok: true } }
          }),
          // 停止：清空还没播的
          post('/clear', () => {
            resetQueue({ epochChange: true })
            // 实时累计也一起清：手动清空之后，整段落地不该再按旧记录补尾巴
            liveSentText = ''
            lastFullKey = ''
            lastFullAt = 0
            return { payload: { ok: true } }
          }),
          // 调设置（音量、语速、声线、分段长度）
          post('/settings', (body) => {
            const patch = body !== null && typeof body === 'object' ? body : {}
            const next = normalizeSettings({ ...settings, ...patch })
            Object.assign(settings, next)
            // 用户刚换了本机声线：立刻按新选择重算"当前发声的那条"，
            // 否则设置页要等下一次探测（最多 5 分钟）才显示对
            localVoiceSnapshot = pickLocalVoice(localVoicesSnapshot)
            writeSettings(settings)
            bump()
            return { payload: { ok: true, settings: snapshot().settings } }
          }),
          // 重新检测本机声线：用户刚装完语音包时点设置页那个按钮，绕开 5 分钟缓存立刻重探
          post('/local-voices', () => refreshLocalVoices(true)
            .then(() => ({ payload: {
              ok: true,
              voices: localVoicesSnapshot,
              localVoice: localVoiceSnapshot ? localVoiceSnapshot.name : '',
              localVoiceEngine: localVoiceSnapshot ? localVoiceSnapshot.engine : '',
            } }))),
          // 界面里手动念一段；append 模式用于流式逐句追加（不打断正在念的）
          post('/speak', (body) => {
            const text = String(body?.text ?? '')
            const append = body?.append === true
            let interrupt = append !== true
            if (body?.live === true) {
              lastLiveAt = Date.now()
              if (typeof body?.attemptId === 'string') liveAttempt = body.attemptId
              // 实时段同样要过一遍清洗：模型把 HTML/CSS 直接写进正文时，
              // 不清洗就会把 padding、background-color、注释整段念出来（实测出现过 122 条 cue）
              const cleaned = cleanForSpeech(text)
              // 判"要写代码"的时机：拿原文判（cleaned 已经把代码删掉了，判不出来）。
              // 触发点一：正文里出现围栏/代码行；触发点二：客户端上报 tool-call 块（写文件型回复，
              // 正文里可能一行代码都没有，只能靠工具调用判）。
              if (settings.codeQuiet === true && codeQuietTurn !== true && hasCodeTrace(text)) {
                codeQuietTurn = true
                quietStartedAt = Date.now()
                quietAsk = []
                // 把命中的行写进日志：判错时能直接看到是哪一行把整轮打成静音的
                const hitLines = String(text).split('\n').filter((line) => looksLikeCodeLine(line))
                  .slice(0, 2).map((line) => line.trim().slice(0, 36))
                const why = String(text).includes('```') ? '围栏代码块' : `行：${hitLines.join(' ／ ')}`
                log(`进入静音模式：本条回复出现代码（已送 ${liveSentText.length} 字，${why}）`)
              }
              // 静音模式下这一段不入队：队列里已经排进来的让它念完，之后自然安静。
              // 收尾念完之后（quietSettledAt 立起来）同一回合的后续增量也一样不入队，
              // 否则模型继续吐字时又会在结果段后面接着念一截。
              if (codeQuietTurn === true || (quietSettledAt !== 0 && Date.now() - quietSettledAt < 600_000)) {
                if (quietGateLogged !== true) {
                  quietGateLogged = true
                  // quietSettledAt=0 时不能直接算差值（0 不是有效时间戳，会打印出十几亿秒）
                  const since = quietSettledAt === 0
                    ? '本回合还没念过结果段'
                    : `安静的 ${Math.round((Date.now() - quietSettledAt) / 1000)}s 前念过结果段`
                  log(`静音闸门拦下实时段 chars=${cleaned.length}（codeQuietTurn=${codeQuietTurn}，${since}）`)
                }
                lastLiveAt = Date.now()
                return { payload: { ok: true, replay: true, chunks: 0, quiet: true } }
              }
              // 只有"用户刚发消息、本回合还没开过口"的第一段才允许打断旧播报。
              // 页面按 attempt id 判新旧（工具调用后宿主会重开 attempt 从头重发），
              // 它看到新 id 就发 append=false —— 那不是新回复，绝不能借机清队列，
              // 否则正在念的半句会被切断。
              const mayBreak = turnFresh === true
              if (mayBreak) turnFresh = false
              interrupt = mayBreak
              // 同一回合内的 attempt 重开一定走续传，累计文本不重置
              const treatAsAppend = mayBreak ? false : true

              // 工具调用之后宿主会重开一个 attempt、把正文从头再发一遍（写代码要几十秒，
              // 页面那边只能看到"换了一个 attempt"，会当成新回复）。这里按文本重合度自己判：
              // 跟已送内容重合 → 续传，只念新增；完全不重合 → 真的换了新回复。
              const overlap = liveOverlap(cleaned, liveSentText)
              if (overlap.replay) {
                log(`实时段重放：裁掉重复 chars=${text.length}→${overlap.tail.length}`)
                if (overlap.tail !== '') {
                  const tailPlan = enqueue(overlap.tail, { interrupt: false })
                  liveSentText = treatAsAppend ? liveSentText + overlap.tail : overlap.tail
                  if (liveSentText.length > 20_000) liveSentText = liveSentText.slice(-20_000)
                  return { payload: { ok: tailPlan.chunks > 0, replay: true, chunks: tailPlan.chunks } }
                }
                return { payload: { ok: true, replay: true, chunks: 0 } }
              }
              liveSentText = treatAsAppend ? liveSentText + cleaned : cleaned
              if (liveSentText.length > 20_000) liveSentText = liveSentText.slice(-20_000)
              const plan = enqueue(cleaned, { interrupt, cleaned: true })
              return { payload: { ok: plan.chunks > 0, chunks: plan.chunks, chars: plan.chars } }
            }
            const plan = enqueue(text, { interrupt })
            return { payload: { ok: plan.chunks > 0, chunks: plan.chunks, chars: plan.chars } }
          }),
          // 浏览器侧把探针信息写进同一个日志文件（页面控制台看不到）
          post('/debug', (body) => {
            // 块类型里只有一种硬信号：正文切到代码块（模型真在写代码）。
            // tool-call 块**不再作为静音依据** —— 块里没有工具名，读文件/搜资料也会走到这里，
            // 一样照静音就把纯文本回复整段吞了（1.0.183 实机即复现）。
            // 工具名改从 tool/call 事件取，见上面 session/event 分支。
            const what = String(body?.what ?? '')
            const type = String(body?.type ?? '')
            if (what === 'block-type' && /code/iu.test(type)
              && settings.codeQuiet === true && codeQuietTurn !== true) {
              codeQuietTurn = true
              quietStartedAt = Date.now()
              quietAsk = []
              log(`进入静音模式：正文切到代码块（block-type=${type}），中间不再逐字念，落地只念结果段`)
            }
            log(`client debug: ${JSON.stringify(body).slice(0, 2000)}`)
            return { payload: { ok: true } }
          }),
        ]
        for (const route of routes) {
          if (typeof route === 'function') disposers.push(route)
        }
        log('routes registered: state, audio, auto, consume, clear, settings, local-voices, speak, debug')
      }
    } catch (error) {
      log(`routes failed: ${String(error?.message ?? error)}`)
      // webServer 不可用时静默跳过：命令行功能仍然可用
    }

    // 定时清理过期音频；卸载时一并停掉
    const cleanupTimer = setInterval(() => {
      try {
        trimReady()
      } catch {
        // 清理失败不影响播报
      }
    }, 60_000)
    if (typeof cleanupTimer?.unref === 'function') cleanupTimer.unref()
    disposers.push(() => clearInterval(cleanupTimer))
    // 静音模式的兜底计时器也要在卸载时清掉，否则热重载会留下一个悬空定时器
    disposers.push(() => {
      if (quietPendingTimer !== null) {
        clearTimeout(quietPendingTimer)
        quietPendingTimer = null
      }
    })

    log(`apply: 插件挂载完成，注册 ${disposers.length} 项资源`)

    // 启动时就把 Edge TTS 依赖探一次：依赖解析不了要在日志里立刻看到，
    // 而不是等用户第一次听播报时才发现没声音。
    void ensureEngine()
      .then((mod) => log('edge-tts 依赖加载 OK', `EdgeTTS=${typeof mod?.EdgeTTS}`, `Constants=${typeof mod?.Constants}`))
      .catch((error) => log('edge-tts 依赖加载失败', String(error?.message ?? error)))

    // 同时探一次本机语音：设置页要在「只装了机器音」时给出装晓晓的引导，
    // 播报时也按探测结果挑最自然的那一个。
    void refreshLocalVoices()

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 单个资源回收失败不拦其余清理
        }
      }
    }
  }, 'live-speak: edge-tts auto speech + playback queue')
}

/** 给测试用：把内部文本处理暴露出来，方便脱离宿主验证。 */
export const __test__ = { cleanForSpeech, chunkText, splitSentences, normalizeSettings }
