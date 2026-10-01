# LaTeX Live 与 Overleaf：适合不同的写作重心

LaTeX Live 的主要价值，是把原生 `.tex` 项目放进 Obsidian 的日常阅读与写作空间：在源文件中读公式和定理，沿证明里的引用查看陈述与证明，再用自己的 TeX 工具链生成 PDF 或自包含阅读 HTML。Overleaf 的主要价值，是让合作者通过浏览器进入同一个论文项目，直接编辑、批注、审阅和回看历史，减少环境配置。

**Overleaf 已有 Visual Editor、自动编译、双向 SyncTeX、AI 工具和 HTML 导出。** 因此，LaTeX Live 的差异应通过具体阅读流程与导出保真证据展示，不能宣传为这些能力的唯一提供者。[编辑器](https://docs.overleaf.com/getting-started/how-do-i-use-overleaf)、[SyncTeX](https://docs.overleaf.com/navigating-in-the-editor/working-with-the-pdf-viewer/moving-between-the-editor-and-pdf)、[AI](https://docs.overleaf.com/integrations-and-add-ons/ai-features)、[格式转换](https://docs.overleaf.com/managing-projects-and-files/importing-and-exporting-files)。

核对日期：**2026-09-30**。本文比较当前仓库的 LaTeX Live 0.1.0 与 Overleaf Cloud 官方公开能力，不是登录后的同稿对照实验。文中的「已验证」来自本仓库代码、回归和运行记录；「官方能力」来自所链接的现行文档；「推断」是由工作方式得出的适用性判断。来源与未核实项记录在 [overleaf-sources.json](overleaf-sources.json)。

## 能力与实际意义

| 维度 | LaTeX Live 当前版 | Overleaf 当前官方能力 | 对选择的意义 |
| --- | --- | --- | --- |
| 源码与阅读式编辑 | **已验证**：源码/实时两种模式；公式、列表、定理框、图片和引用芯片就地显示，光标触及构造时恢复源码；项目宏用于私有 MathJax。复杂构造按支持范围显示 PDF 裁剪或 TeX 片段。 | Code Editor 与 Word 式 Visual Editor 并存，并非只能面对裸源码。[官方说明](https://docs.overleaf.com/getting-started/how-do-i-use-overleaf) | **推断**：本插件适合熟悉 LaTeX、想在同一文件里交替阅读与改源码的人；Overleaf 也照顾不熟悉 LaTeX 的合作者。没有做双方视觉编辑器的同稿操作比较。 |
| 定理与证明引用 | **已验证**：从当前项目证明正文的字面 `\ref` 建图；小窗最多 25 个节点，可展开陈述/证明、继续沿引用浏览、跳回源行；打开卡片不全编译。 | 已有项目上下文 AI Assistant，可围绕选区和项目提问；本次核对的官方文档未找到同形态的确定性证明引用图。[AI Assistant](https://docs.overleaf.com/integrations-and-add-ons/ai-features/ai-assistant) | 这是值得演示的差异。图表示**源码中的证明引用关系**，不是已验证的逻辑依赖；没找到官方入口也不能证明整个 Overleaf/扩展生态没有类似能力。 |
| PDF 与双向定位 | **已验证**：本机 TeX 的真实 PDF；SyncTeX 正向/反向定位、光标跟随、可选深色反色。 | 源码/PDF 双向跳转，PDF 双击与面板箭头；需要 Overleaf PDF viewer。官方列明行级精度、编译后更新及多栏等限制。[SyncTeX](https://docs.overleaf.com/navigating-in-the-editor/working-with-the-pdf-viewer/moving-between-the-editor-and-pdf) | 两者共有的基础能力，不应当作独占卖点；PDF 定位都依赖实际编译结果。 |
| 编辑到编译的流程 | **已验证**：默认停键 400 ms 后保存并请求编译；组字中不保存/编译；编译队列、依赖跟踪、取消与进程清理；pdfLaTeX 可缓存导言区。数学的即时显示与 PDF 编译分开。 | 自动编译可每几秒运行；保留编译辅助文件，提供从头编译、快速草稿和错误日志。[编译选项](https://docs.overleaf.com/getting-started/recompiling-your-project) | 400 ms 是请求延迟，不是 PDF 生成耗时。两者都有缓存，不能据此宣称本地总是更快。 |
| 键盘、补全与诊断 | **已验证**：texlab LSP 补全/悬停；环境、命令、引用、文献及 snippet；统一处理 Tab/Enter 优先级，含列表续写与中文 IME 回归。texlab 需本机可用。 | 有快捷键、自动补全/文献搜索和即时 Code Check；特殊宏可能超出 Code Check 的启发式边界。[快捷键](https://docs.overleaf.com/navigating-in-the-editor/keyboard-shortcuts)、[Code Check](https://docs.overleaf.com/troubleshooting-and-support/code-check) | 本插件提供可接入本地语言服务器的编辑环境；并不意味着 Overleaf 缺少编辑辅助，也未比较两者补全覆盖率。 |
| 笔记与资料工作空间 | **已验证**：Obsidian 原生 `.tex` 视图，文件留在 vault/本地项目中，可与 Markdown 笔记、图片和其他资料共处。LaTeX 标签并不会自动成为 Obsidian 的所有笔记双链。 | 论文项目、文件树、模板与文献工具构成工作空间；可导入 Word/Markdown，导出多种格式。[转换](https://docs.overleaf.com/managing-projects-and-files/importing-and-exporting-files)、[模板](https://docs.overleaf.com/templates/creating-a-project-from-a-template) | **推断**：本插件减少 Obsidian 使用者在笔记和 TeX 工程间的切换；Overleaf 的组织方式更直接围绕投稿项目。 |
| AI 与外部 agent | **已验证**：可选接入 YOLO 插件的 AI ghost text，默认关闭；本插件没有内置项目聊天/审稿 agent。**推断**：普通本地文件便于由用户选定的 CLI agent、脚本和 Git 处理。 | 内置 AI Assistant、Error Assist、学术语言建议、改写、公式/表格生成等；权限与日额度随方案而变。Assistant 可用项目上下文。[AI 工具](https://docs.overleaf.com/integrations-and-add-ons/ai-features)、[Assistant](https://docs.overleaf.com/integrations-and-add-ons/ai-features/ai-assistant) | 本地工具的可组合性与现成学术助手是不同取舍；不能宣传 Overleaf「没有 AI」，也不能把外部 agent 算成本插件已实现的功能。 |
| 阅读 HTML 与格式转换 | **已验证**：单个无 JavaScript 的 HTML，章节/定理/引用/脚注语义重排；图片、SVG 及使用到的数学字体内嵌，脱离 Obsidian 阅读；有警告报告。正文用系统字体，复杂表格/绘图可为 SVG。 | 当前已用 Pandoc 导出 HTML、Word、Markdown；官方说明转换结构而不复现所有 class/package 的视觉样式，复杂宏可能无法转换。[导入/导出](https://docs.overleaf.com/managing-projects-and-files/importing-and-exporting-files) | 差异是**本插件已测的自包含资源、原生编号/引用和模板语义保留**，不是「只有它能导出 HTML」。未实测 Overleaf HTML 的资源封装与同稿保真，不能宣布全面胜出。 |
| 投稿模板与复杂 TeX | **已验证**：PDF 使用未修改的本机 class/package；阅读层/HTML 另有支持边界。PLOS、Springer Nature、REVTeX、AASTeX、AMS、LNCS、ACM、IEEE 的原创短稿共 11 配置验收通过。 | 模板库含出版者官方模板，部分支持直接投稿；云端提供标准 TeX Live 包和历史版本。[模板](https://docs.overleaf.com/templates/creating-a-project-from-a-template)、[TeX Live](https://docs.overleaf.com/troubleshooting-and-support/tex-live) | 本插件不局限于 ElegantBook，但 11 配置不是全部模板兼容声明。两者最终投稿版式均应以原生 PDF 为准。 |
| 引擎、版本与定制工具 | **已验证**：PDF 支持安装好的 pdfLaTeX/XeLaTeX/LuaLaTeX；识别项目引擎设置，使用本机包、字体、BibTeX/Biber/latexmk。**当前 HTML 不支持 LuaLaTeX**。本机环境版本由用户维护。 | 项目可选择 TeX Live 版本及 pdfLaTeX/LaTeX/XeLaTeX/LuaLaTeX；可上传依赖并用 `latexmkrc` 定制规则。年度版本稳定，Labs rolling 为实验环境。[引擎](https://docs.overleaf.com/getting-started/recompiling-your-project/selecting-a-tex-live-version-and-latex-compiler)、[依赖](https://docs.overleaf.com/managing-projects-and-files/adding-latex-dependencies)、[latexmkrc](https://docs.overleaf.com/managing-projects-and-files/the-latexmkrc-file)、[版本](https://docs.overleaf.com/troubleshooting-and-support/tex-live) | **推断**：本机工具链更便于与个人计算/构建流程组合；Overleaf 的共享环境和逐项目版本选择降低合作者之间的配置差异。不能说它不允许自定义编译。 |
| 大工程与性能 | **本机测量**：65 页夹具冷 HTML 导出 11.335 s、新鲜构建导出 2.931 s；5891 行章节的原生方向键样本 p95 6 ms。详见下表。 | 官方当前 Free 编译上限 10 s，premium 240 s；每项目 2000 文件、可编辑材料 7 MB；提供图片/绘图等超时优化指南。[额度](https://docs.overleaf.com/getting-started/free-and-premium-plans/plan-limits)、[超时指南](https://docs.overleaf.com/troubleshooting-and-support/fixing-and-preventing-compile-timeouts) | 超时额度不等于耗时或 CPU 性能。没有同稿、同版本、同缓存态、同档位的 Overleaf 测量，不能作速度排名。本机也受硬件与实现上限限制。 |
| 离线、数据位置与隐私 | **已验证的架构**：源码无需上传即可本机编辑/编译；备份与同步由用户选择。启用外部 AI、同步或工具后的网络行为不由本插件统一保证。 | 可下载源码、通过 premium Git 集成在本地工作再同步；云端项目默认私有。另有自托管 Community Edition/Server Pro。AI 文档说明可能发送必要上下文给第三方且不用于模型训练。[Git](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration)、[共享权限](https://docs.overleaf.com/collaborating/sharing-a-project)、[自托管](https://docs.overleaf.com/on-premises/welcome/server-pro-vs.-community-edition)、[AI 数据说明](https://docs.overleaf.com/integrations-and-add-ons/ai-features) | 选择本机处理可以减少必要的云端源码传输，但不等于整体安全审计。不能把 Overleaf 一概描述为公开或完全没有离线选择。 |
| 实时合著、评论与审阅 | **当前边界**：没有内置多人同时编辑、权限管理、批注线程或审阅修订；外部文件同步/Git 不是这些功能的等价替代。 | 同项目协作、评论/回复/解决、编辑/审阅权限；premium Track Changes 支持接受/拒绝修订，项目拥有者的权限可共享给合作者。[评论](https://docs.overleaf.com/collaborating/commenting)、[修订](https://docs.overleaf.com/collaborating/track-changes)、[共享](https://docs.overleaf.com/collaborating/sharing-a-project) | 需要导师或团队直接在线审阅时，Overleaf 的整合流程更完整。 |
| 历史与可复现 | **当前边界**：普通源码可纳入用户自己的完整 Git 分支/脚本工作流，但插件不自动提供协作历史或锁定 TeX/字体环境。模板测试有版本/校验值收据。 | History 可比较、恢复、下载、标记版本；Free 可看最近 24 小时及标记版本，完整历史属 premium。Git bridge 有分支、tag、LFS 等限制。[历史](https://docs.overleaf.com/writing-and-editing/history-and-versioning)、[Git 边界](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration) | 云端历史与完整本地 Git 各有职责；保留源码不自动保证换机后得到字节一致的 PDF。 |
| 分享、入门与跨设备 | **已验证**：PDF/HTML 可作为独立成果分享；编辑器 desktop-only，最低 Obsidian 1.13.7，需要本机 TeX，texlab 提供增强能力。换机需配置与文件同步；不支持 iPad 编辑。 | 浏览器创建账号即可写作，无需本机装 TeX；可分享只读/编辑链接，查看链接可不登录。支持主流浏览器近 12 月版本，官方提示手机/平板存在限制。[入门](https://docs.overleaf.com/getting-started/how-do-i-use-overleaf)、[共享](https://docs.overleaf.com/collaborating/sharing-a-project)、[浏览器](https://docs.overleaf.com/troubleshooting-and-support/supported-browsers) | **推断**：跨设备直接进入同一论文、临时邀请合作者更适合 Overleaf；本插件的便携阅读成果不等于移动端编辑支持。 |

本插件证据入口：[实现与运行记录](../design.md)、[模板范围与失败复测](../template-compatibility.md)、[源码/回归索引](overleaf-sources.json)。这些记录不能替代未做过的双方基准测试。

## 性能数字应该怎样读

| 本机记录 | 结果 | 测量边界 |
| --- | --- | --- |
| 65 页中文 ElegantBook，含数学、定理、表格、TikZ、文献；冷态完整 HTML 导出 | 11.335 s，其中完整构建 8.240 s、探针 2.463 s | 单个合成项目；包含 PDF 完整构建。冷态 10 s 目标尚未达到。 |
| 同项目，完整构建已经新鲜 | 2.931 s，HTML 相同、零报告项 | 没有重新支付完整 TeX 构建成本；不能替代冷态数字，也不是每次击键编译耗时。 |
| 实际 Obsidian 的 5891 行章节；16 次方向键；另测 190 行定理内 20 次移动 | p95 6 ms / 6.2 ms | 小样本编辑响应；不是完整项目编译或小窗展开延迟。 |
| 5702 行源码的证明引用索引 | 冷读取 42.4 ms、缓存读取 0.7 ms | 单次 Node 数据服务测量，不包括卡片渲染/图片加载或完整 UI。 |

以上沿用本仓库已有测量，**本次未重跑、未上传同稿到 Overleaf**；机器配置与统计采样不足以作跨产品通用基准。Overleaf 的编译上限是套餐资源边界，不能拿「10 s timeout」与「11.335 s 本机导出」比较得出胜负。[本机记录](../design.md)、[官方额度](https://docs.overleaf.com/getting-started/free-and-premium-plans/plan-limits)。

## 成本、适用人群与尚未验证的部分

当前官方 USD 标价如下；年付列是全年账单，不是月付价格。学校/组织资格、地区税费及优惠应按用户实际购买页面核对。两者没有可直接换算的同等计算资源套餐。[价格页，2026-09-30](https://www.overleaf.com/user/subscription/plans)。

| Overleaf 方案 | 月付 | 年付 | 每项目可邀请编辑/审阅者 | 日 AI 额度 / Assistant |
| --- | --- | --- | --- | --- |
| Free | $0 | $0 | 1 | 5 次 / 无 Assistant |
| Student | $13 | $98 | 10 | 5 次 / 有 |
| Standard | $25 | $199 | 10 | 10 次 / 有 |
| Pro | $45 | $399 | 不限 | Max，适用 fair use / 有 |

LaTeX Live 仓库现以 MIT 开源，当前插件代码没有订阅额度；本机硬件、环境维护、Obsidian 的可选服务和外部 AI 的费用仍各自计算。[许可证](../../LICENSE)、[当前配置](../../src/settings.ts)。因此，「无需插件订阅」不能改写成「整个工作流没有成本」。

**更匹配 LaTeX Live 的人**：已经使用 Obsidian、熟悉本地 TeX、主要独立写数学笔记或理论稿件，希望在同一源码中顺着定理与证明读下去，并把阅读版发给别人。**更匹配 Overleaf 的人**：频繁合著、导师在线批注、需要修订/历史与出版者模板入口，或不愿给每个合作者维护 TeX 环境。也可以用本地 `.tex` 负责个人阅读、用 Overleaf 负责共同定稿；这需要双方约定同步与环境版本，当前插件没有自动的双端协作协议。

与通用 VS Code 工作流相比，也不能只用「本地编译、SyncTeX、补全、公式悬停」解释差异：LaTeX Workshop 的官方功能表已经列出这些能力。[LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop/wiki/)。本插件更值得展示的是 **Obsidian 内源文件的阅读式实时层 → 证明引用小窗 → 富内容陈述/证明 → 可携带的阅读 HTML** 这一条连贯流程。这是产品定位判断，不是对所有 VS Code 扩展组合的排他性结论。

当前还应明确以下边界：

- 证明小窗的 Chrome 回归与真实 Obsidian 索引/富内容已验证；2026-10-01 原生窗口录像补充了自动化指针悬停、节点点击和展开的实证。操作系统层跨块拖选未由本次录像替代，不能写成全部原生 UI 已验收。
- 未测的模板/宏不能承诺语义阅读层或 HTML 全支持；实时文献芯片仍是作者/年份摘要，不等于每种期刊的引用样式。复杂图的源码/SVG 回退、LuaLaTeX HTML 限制及系统正文字体均须保留在演示中。
- 未做 Overleaf 的登录后交互、同稿 HTML 保真或性能实测，也未做本插件完整无障碍认证。官方索引已有新的 [Working offline](https://docs.overleaf.com/writing-and-editing/working-offline) 页面，但本次正文读取失败，浏览器短时掉线和持久离线的具体边界尚未核实；不能沿用旧资料断言完全不支持离线编辑。


### 原生录制更新（2026-10-01）

ScreenCaptureKit 的独立窗口原片已录得真实 Obsidian 的指针悬停与节点点击：两节点证明引用图，以及含 17 个数学渲染的陈述/证明展开。录制发现的窗格裁切问题已通过 CodeMirror 官方外部提示窗容器修复。这些是对原生应用的自动化输入，不是同稿 Overleaf 会话或逻辑证明验证；原片及事件/QC 收据保留。操作系统层跨块拖选和上文其他未测边界不由这段录像替代。

另已实录原生双向 SyncTeX、十个论文模板配置的 PDF，以及 YOLO 的实际附件答复、Tab 接受与撤销、Enter 不接受 AI、审阅片段后的原生粘贴和零错误完整构建。成功片保留真实模型等待时间；YOLO 请求超时与录制驱动失败原片也保留。这里的聊天和模型服务来自外部 YOLO，并不是 LaTeX Live 内置助手。最终本仓库完整测试 740/740、浏览器小窗检查 44/44 与生产构建通过。
