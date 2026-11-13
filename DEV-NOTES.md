# 开发笔记（内部记录）

这份笔记记的是**为什么这么改**、**怎么验证的**、**踩过哪些坑**，给以后回看用。
面向用户的说明在 `RELEASE-NOTES.md`，两份不要混。

---

## 2026-11-13 · 1.0.5 本地声线探测为空

### 现象

设置页「声线」下拉显示「未检测到可用声线」，点「重新检测」也没用；日志只有一行 `local voices: n=0 pick=none []`。系统里其实装着 Huihui / Yaoyao / Kangkang。

### 根因

探测和合成都是 `execFile('powershell.exe', …)`，按 PATH 找 PowerShell。这台机器上 DSH 是用 `Start-Process` 从当前 shell 拉起的，那个 shell 的 PATH 里没有 `C:\Windows\System32`，于是：

```
synth fail id=8 chars=56 attempt=16 err=spawn powershell.exe ENOENT
```

探测侧 `if (error) { resolve([]); return }` 把 ENOENT 直接吞掉，返回空清单——所以症状是「没声线」而不是「报错」。

不是语音包的问题，也不是 WinRT/SAPI 的问题。用绝对路径手动跑，两条通道都正常：

```
WinRT probe → Microsoft Huihui|zh-CN / Microsoft Yaoyao|zh-CN / Microsoft Kangkang|zh-CN
SAPI  probe → Microsoft Huihui Desktop|zh-CN / Microsoft Zira Desktop|en-US
```

### 改法

新增常量 `POWERSHELL_EXE`：Windows 下先查 `${SystemRoot}\System32\WindowsPowerShell\v1.0\powershell.exe`，再查 `C:\Windows\...`，都没有才退回裸名 `powershell.exe`。四处调用点（WinRT 探测、SAPI 探测、WinRT 合成、SAPI 合成）全部改用它。

不依赖 PATH 也让公众发行更稳：精简启动器、某些终端、以服务方式拉起的进程，PATH 都可能被裁剪过。

### 验证

重启前：`local voices: n=0 pick=none []`，`spawn powershell.exe ENOENT`。

重启后：

```
local voices: n=5 pick=Microsoft Yaoyao/winrt
  [Microsoft Huihui/winrt, Microsoft Yaoyao/winrt, Microsoft Kangkang/winrt,
   Microsoft Huihui Desktop/sapi, Microsoft Zira Desktop/sapi]
```

本地档连续合成 4 段全部成功（41 / 96 / 120 / 14 字），`voice=Microsoft Yaoyao`。

### 教训

探测类代码把错误吞成空数组，等于把「环境有问题」伪装成「本来就没有」。以后这类 catch 至少要留一行日志写清失败原因。

---

## 2026-11-13 · 1.0.2 标题连读修复

### 现象

带小标题的长文，播报时标题和正文粘成一句：

> 听到的是「帘卷西风济南的趵突泉边，如今游人如织」
> 屏幕上明明是两行：`帘卷西风` ＋ 换行 ＋ `济南的趵突泉边，…`

四轮修正都没修好，因为一直在改**标点**，而问题不在标点。

### 根因

`cleanForSpeech()` 里有一处「抹掉中文之间空格」的正则，本意是清理替换文件名后留下的空格（`已保存为 网页` → `已保存为网页`）。它写的是：

```js
text.replace(/([\u4E00-\u9FFF])\s+(?=[\u4E00-\u9FFF])/gu, '$1')
```

`\s` 包含 `\n`。于是「汉字 + 换行 + 汉字」也命中，段落边界被吃掉：

```
老书店的下午\n\n街角那家老书店…   →  老书店的下午街角那家老书店…
```

两行并成一行之后，后面「短行补标点」的分支按长度判断就不再命中——标题永远拿不到标点，只能和正文一起念完。

### 改法

两处，都在 `cleanForSpeech()`：

1. 空白类收紧成行内空白，不含换行：

```js
text.replace(/([\u4E00-\u9FFF])[ \t\u00A0]+(?=[\u4E00-\u9FFF])/gu, '$1')
```

2. 标题补的标点从 `……` 改成 `。`（Markdown `#{1,6}` 标题处、收尾逐行兜底处，两处）。

第 2 条的取舍依据是实测数据，不是感觉：

| 标点 | 24kHz MP3 总时长 |
|---|---|
| 无标点 | 4.94 s |
| 省略号 | 4.87 s ← **比无标点还短，等于零停顿** |
| 句号 | 5.33 s（+0.39 s） |
| 双句号 | 5.33 s |
| 句号 + 换行 | 5.33 s |

原代码注释写着「省略号停顿明显长一截」，和实测相反。省略号在神经语音里基本不产生停顿，只有句号才断句。所以标题末尾用句号。

### 验证

离线探针（在插件目录写 `.mjs`，`import('./index.js')` 取 `__test__.cleanForSpeech / chunkText`，跑完删掉）：

| 场景 | 改前 | 改后 |
|---|---|---|
| 短行标题（无 `#`） | `老书店的下午街角那家…` | `老书店的下午。` + `街角那家…` |
| Markdown 标题 | `一、推门……` | `一、推门。` |
| 列表项 | `写周报开评审会…` | `写周报。` / `开评审会。` |
| 文件名空格 | `已保存为 网页` | `已保存为网页`（仍然抹掉）✓ |
| 中英混排 | 正常 | 正常（`ttsEngine 字段` 不受影响） |

真实播报（246 字、带一个短行标题）：

```
enqueue seg 1/2 len=127 head="帘卷西风。济南的趵突泉边，如今游"
synth ok id=1 chars=127 dur=27.888
play-start id=1 → play-end id=1 elapsed=27.864
play-start id=2（间隔 2ms）→ play-end id=2 elapsed=24.72
```

零失败、零重试、无跳段。

### 为什么不做「标题单独成段」

能让停顿拉到 1 秒以上的唯一办法，是把标题单独合成成一个音频块，播放时人为插静默。代价：

- 多一次合成请求 → 多一次 429 / 超时的机会
- 标题块 1 秒就播完，正文块还在合成 → 中间反而可能空几秒

用新的断流风险换停顿，不划算。**纯文本能做的上限就是 0.39 秒断句**，这就是第一句读起来的实际空隙。已知局限，不改。

---

## 2026-11-13 · mac/Linux 本地合成路径验证

### 怎么在没有 mac 的机器上验证

`say` 在 Windows 上不存在，无法执行。但 Linux 分支用的 `espeak-ng` 有 Windows 版，**同一个程序、同一套命令行**，可以真跑。

验证方式选**便携解包**，不装进系统：

```
msiexec /a espeak-ng.msi /qb TARGETDIR=<临时目录>\
```

`/a` 是 administrative install，只把文件摊开，不写注册表、不碰 `Program Files`、不改 `PATH`。测完删目录即可完全还原。

**踩坑**：解包出来的 `espeak-ng.exe` 直接跑会崩（`0xC0000005`，访问违例），必须先设

```
ESPEAK_DATA_PATH=<解包目录>
```

设完 `--version` 与 `--voices` 都正常。这个坑对 Linux 同样有参考价值：**数据目录找不到时 espeak-ng 不是报错而是崩**，非标准安装方式（snap / flatpak / AppImage）可能踩到。

### 真实 `--voices` 输出的三个特征

之前按记忆构造的样本是错的，真实输出（223 行）是这样：

```
Pty Language       Age/Gender VoiceName          File                 Other Languages
 5  af              --/M      Afrikaans          gmw\af
 5  cmn             --/M      Chinese_(Mandarin,_latin_as_English) sit\cmn   (zh-cmn 5)(zh 5)
```

1. 性别列是 `--/M` 这种**双字段**形态，不是单个 `M`
2. VoiceName 里的空格被**下划线**转义（`Chinese_(Mandarin,_latin_as_English)`）。所以按空白切列不会切断名字——**之前担心的「显示名截断」并不存在**，那条结论作废
3. File 列 Windows 用反斜杠 `gmw\af`，Linux 用 `gmw/af`

用这份真实输出跑 `probeEspeakVoices` 的解析逻辑：222 条全部正确，中文四条 `cmn` / `cmn-latn-pinyin` / `yue` / `yue`，id 与显示名都对得上。

### 合成 + 读回

```
espeak-ng -w out.wav -f text.txt -s 189 -v cmn
```

41 字中文 → 419762 字节 → **9.517 秒**（4.31 字/秒）。文件是标准 `RIFF/WAVE`，22050Hz / 16bit / 单声道，`byteRate=44100` 正好落在 offset 28，`data` 从 44 起——与 `readWav` 的假设完全一致。

语速对照：Edge 晓晓实测 4.58~4.87 字/秒，espeak 189wpm 约 4.31 字/秒，偏慢一点但同一量级。`localWpm()` 的 180 基线是合理的。

### `readWav` 对异常 WAV 的行为

| 样本 | 结果 |
|---|---|
| 22050Hz 标准 44 头，1 秒 | 1.0000 s ✓ |
| 8000Hz，1 秒 | 1.0000 s ✓ |
| 只有 44 字节头、无数据 | 抛 `emptyAudio` ✓（设计意图） |
| 头部多一个 `fact` 块（56 头） | 1.0003 s，偏差 0.3 毫秒，可忽略 |
| 16 字节截断文件 | 抛 `emptyAudio`，上层换声线重试 |

### `say -v ?` 的解析

用真实格式样本（含 `Grandma (Enhanced)`、`Eddy (English (US))`、带重音字符的声线名、表头行、空行）跑正则，6/6 正确。这一步只能是样本验证——`say` 实际输出无法在 Windows 上取得。

### 结论与未覆盖

已验证：Linux 分支的**声线解析**、**合成命令**、**WAV 格式**、**读回算法**全部符合预期，`espeak-ng` 确实能念中文。

未覆盖：

- mac 的 `say`：二进制不存在，只能靠参数审查（`--file-format=WAVE --data-format=LEI16@22050` 规避 AIFF，`-f -o -r -v` 均合法）
- 真 Linux 环境：包管理器装的 espeak-ng 数据目录位置、权限、缺少音频设备的容器里行为
- 实际听感：espeak 的中文合成是机械音，这是工具本身的水平，不是代码问题

---

## 排查手法备忘

**看播报到底念了什么**：插件目录下 `log.txt`（UTC 时间，本地 = UTC+8）里 `enqueue seg i/n len=… head="…" tail="…"`，`head` 就是这一段最前面的二十来字，能直接看出标点和切分对不对。

**不重启也能验清洗逻辑**：插件目录里放个 `.mjs`，`const m = await import('./index.js')`，取 `m.__test__` 跑 `cleanForSpeech` / `chunkText`。放系统临时目录会因为找不到模块报 `ERR_MODULE_NOT_FOUND`。

**在 DSH 页面里发一次播报请求**：宿主对插件的 HTTP 接口有同源校验，外部命令行直接 POST 会 401，必须在页面内的 DevTools 控制台里发同源 `fetch`。长中文文本用 base64 内联比 percent-encoding 短一半：

```js
fetch('/plugins/dsh-live-speak/speak', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    text: new TextDecoder().decode(
      Uint8Array.from(atob('BASE64'), (c) => c.charCodeAt(0))
    )
  })
}).then((r) => r.json()).then((j) => console.log('P1', JSON.stringify(j)))
```

**DevTools 停在 Lighthouse 面板、鼠标点不动标签栏时的进法**：先让窗口拿到焦点，按 `Ctrl+Shift+P` 打开命令面板，输入「控制台」，选第一项「显示控制台」（分类是「面板」），回车。纯键盘可走完，不需要点鼠标。

---

## 2026-11-13 · 1.0.4：合成异常的用户可见提示

**背景**：线上语音服务端从 18:12 起连续不可用（`speech.platform.bing.com` 连得上，但 8 秒内不返回任何数据），插件按「绝不跳段」策略无限重试。用户端完全看不出异常——卡片只写「正在合成下一段…」，静止不动，看起来像插件死了。

**根因**：宿主 `snapshot()` 一直在返回 `error` 与 `failCount`，但客户端 `client.js` **从未读取过 `data.error`**；`manager.error` 只在本机播放失败时被赋值。所以「服务端持续失败」这条链路在界面上是隐形的。

**改法（宿主 `index.js`）**

- 新增 `synthTroubleSince`（连续失败起点，0＝正常）：`synth ok` 清零，catch 里首次失败置位
- `snapshot()` 增 `trouble`：距今 ≥15 秒才返回 `{ seconds, error }`，否则 `null`
- `resetQueue({ epochChange: true })` 一并清零（换一篇不带上上一篇的秒数）
- catch 里置位前加 `epoch === myEpoch` 判断——**清空/换篇之后才返回的旧尝试不算**

**改法（客户端 `client/client.js`）**

- i18n 三语增 `empty.trouble`（zh「语音服务暂无响应，正在重试（已 {s} 秒）」/ en / ja）
- `manager.trouble` + `emit` 透出 + `poll` 里同步（只在 null 变化或秒数变化时重绘）
- `idleLabel()` 加最优先分支；它被主面板（2 处）、顶栏、侧栏共 4 处调用，三种形态全覆盖

**踩到的坑（值得记住）**

第一版只判断「失败超过 15 秒」，没判断「是否还在合成」。结果点清空后 `working` 已经 false、`pending` 已经 0，那行「正在重试」还挂着不动。实测 `/state` 返回过 `{"epoch":5,"pending":0,"working":false,"trouble":{"seconds":119,...}}`。

两处补救：① `snapshot()` 条件加 `|| !working`，pump 不在跑就不报；② 上面那条 `epoch === myEpoch`，防止旧尝试把计时重新点亮。

**实测证据**

| 场景 | 结果 |
|---|---|
| 线上服务端真实故障（18:12 起） | 第 24 秒卡片出现「语音服务暂无响应，正在重试（已 24 秒）」 |
| 本地档无后端（确定性失败） | 第 21 秒出现同一文案 |
| 随后 `/clear` | 提示撤掉，卡片回到「正在合成下一段…」→「没有待播内容」 |
| 服务端恢复（10:39:38 `synth ok`） | `trouble` 自然回 `null`，提示消失 |

**DevTools 操作坑（本轮又踩了）**：console 内容变多后，按坐标点提示符容易点偏，命令会静默不发（光标没落进去）。稳妥流程：先输 `1+1` 确认焦点在 console，再 `cu.hotkey("ctrl","l")` 清屏后重发；`cu.press` 只接受单键，组合键必须用 `cu.hotkey`。

---

## 发版流程（每次都一样）

1. 改 `package.json` 的 `version`，只走最小步长（`1.0.1` → `1.0.2`），不跳版本
2. `RELEASE-NOTES.md` 加一节「x.y.z 更新说明」，末尾的「当前版本」同步改
3. `npm pack --dry-run --json` 看清会打进包里的文件（应为 7 个）
4. `git commit` → `git tag -a vX.Y.Z` → `git push origin main` → `git push origin vX.Y.Z`
5. `npm publish`：`npm` 在这台机器的 shell 里读不到真实 `.npmrc`（`USERPROFILE` 指向别的目录，registry 还是国内镜像），必须把 registry 和 token 显式传给它，否则 `npm whoami` 报 `ENEEDAUTH`
6. 建 GitHub Release，正文用这一版的更新说明
7. 发布后核对：下载 npm tarball 解包，逐个比对 SHA256 与本地源码是否一致

**不要进公开仓库的东西**：本机路径、电脑名、内部台账、带本机路径的重启脚本（`tools/` 已在 `.gitignore`）。

---

## 悬着没做的事

- 均衡器三个预设（clarity / soft / deep）只做了参数，没有真机听感验证；当前配置是全 0
- mac 的 `say` 路径仍无实机验证（二进制在 Windows 上不存在）；Linux 的 espeak 路径已用 Windows 版 espeak-ng 做过等价验证（见上节），但真 Linux 环境差异未覆盖
- Linux 若连 `espeak-ng` 都没装，本地档会完全无声。1.0.3 已把 `ENOENT`/`EACCES` 标成不可重试（退避 60 秒、日志每 10 次一条），但仍然「一直重试、绝不跳段」；设置页仍**没有**「未检测到本机声线」的可见文案，这一条还没做
- espeak-ng 数据目录找不到时会崩溃（`0xC0000005`）而不是报错退出，非标准安装方式可能踩到
- `ttsEngine` 的 `auto` 兼容值仍在校验白名单里，行为等同 `edge`，没有清掉
- 实时流式路径（门槛 140 字 + 动态软切）只用整段直喂验证过，真实流式效果没单独测
- **线上档合成变慢时会出现段间空白（2026-11-13 实测，暂不改）**：青岛那篇 7 段里，服务端把单段合成从 3.5 秒拖到 13~18 秒，而一段只播 21~25 秒，「合成一段 vs 播一段」的余量从六倍掉到不足一倍，出现两处断流（7.4 秒 / 14.1 秒）。三次 `WebSocket inactivity timeout` 都由内层重试救回，没跳段。可选改法：`MAX_SYNTH_LEAD` 从 2 提到 3（多备一段，多约 20 秒缓冲，内存多约 300KB）。用户当时决定先不折腾。注意**这是限流导致的，不是流水线机制错**：服务端正常时段间衔接仍是 1~4ms
- **落单的 `*` 没洗干净**：同一次实测 `enqueue seg 6/7 ... tail="海风酿造的浪漫。*。"`，`**加粗**` 能替换掉，孤立的星号漏了，会被念出一个多余音节。清洗正则应补一条行内孤立 `*` 的处理（注意别误伤乘号与列表符号）
