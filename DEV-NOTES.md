# 开发笔记（内部记录）

这份笔记记的是**为什么这么改**、**怎么验证的**、**踩过哪些坑**，给以后回看用。
面向用户的说明在 `RELEASE-NOTES.md`，两份不要混。

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
- macOS / Linux 的本地合成路径只做了静态检查和「缺二进制不崩」的兜底，没有实机验证
- Linux 若连 `espeak-ng` 都没装，本地档会完全无声，日志有提示，但设置页还没有可见的提示文案
- `ttsEngine` 的 `auto` 兼容值仍在校验白名单里，行为等同 `edge`，没有清掉
- 实时流式路径（门槛 140 字 + 动态软切）只用整段直喂验证过，真实流式效果没单独测
