# 同读 · 本地阅读空间

一个本地优先、专注阅读、可选共读的 EPUB / PDF / DOCX 阅读器。

## 环境要求

- **Node.js** ≥ 18（推荐 20 LTS）
- Windows / macOS / Linux

## 快速开始

```powershell
# 1. 克隆仓库
git clone https://github.com/pengjizhang/co-reading.git
cd co-reading

# 2. 安装后端依赖
npm install

# 3. 安装前端依赖并构建
cd client
npm install
npm run build
cd ..

# 4. 启动服务
npm start
```

浏览器访问 **http://localhost:3030** 即可开始阅读。

> **Windows 用户**：也可以双击 `启动协同读书.bat`（有控制台窗口）或 `启动协同读书 (无弹窗版).vbs`（后台静默启动）。
>
> **关闭服务**：双击 `关闭协同读书.bat` 或直接 Ctrl+C 终止控制台。

## 使用指南

### 📥 导入书籍

支持 **EPUB / PDF / DOCX** 三种格式。

- **方法一**：点击书架右上角的”导入书籍”按钮，选择文件
- **方法二**：直接将文件拖拽到书库页面（支持多选）
- **方法三**：手动将文件复制到 `co-reading` 同级目录的 `同读书库/` 文件夹，刷新页面

导入时自动校验文件格式、SHA-256 查重，重复书籍默认拦截。

### 📖 阅读

点击书架上的书籍进入阅读器。

**两种阅读模式：**
- **连续模式**：自然滚轮滚动，章首/章末需二次确认跨章，适合长文阅读
- **分页模式**：整页翻动，支持滚轮、键盘（↑↓←→ / PageUp / PageDown / 空格）、触控板滑动，适合逐页精读

模式可在右上角阅读设置中切换并记住个人偏好。

**EPUB 专属**：支持”阅读视图”（可划线、讨论）和”原版视图”（查看 XHTML/CSS/图片原始排版）。

**PDF 专属**：支持”文本模式”（可划线、搜索）和”原版模式”（扫描件完整保真）。

### ✍️ 划线与笔记

1. 在阅读器中用鼠标选中文字
2. 在弹出的工具条中选择颜色标记
3. 可添加文字笔记（支持 Markdown 格式）

左侧边栏可查看、筛选、搜索所有划线。笔记支持导出为 Markdown 文件。

### 👥 共读小组

1. 打开一本书，点击共读面板
2. 创建小组（自动生成 8 位邀请码）
3. 其他成员通过邀请码加入
4. 小组成员可互相看到划线、发起原文讨论、设置阅读里程碑

> 共读在同一台设备上通过不同 userId 区分成员，适合读书会/班级场景。

### 🤖 AI 问书

阅读时选中文字，点击”问这本书”或在输入框直接提问。

- **快速模式**：书内关键词检索，返回可跳转的原文出处
- **深入模式**：结合当前章节上下文综合分析（需配置 AI）

**可选：配置 DeepSeek 获得更智能的回答**

```powershell
# 服务端设置环境变量（不要提交到 git）
$env:DEEPSEEK_API_KEY=”你的密钥”
$env:DEEPSEEK_MODEL=”deepseek-chat”
npm start
```

AI 回答始终标注原文出处、可一键跳转。无法被原文验证的主张会自动过滤。

### 📝 间隔复习

划线笔记会自动进入复习队列，采用间隔调度算法：

- 打开**复习面板**查看待复习条目
- 对每条笔记选择 **Again / Hard / Good / Easy**
- 系统根据评分自动调整下次复习间隔

### 🗂️ 书籍管理

每本书右上角菜单提供：
- **编辑信息**：修改书名、作者、分类
- **归档**：暂时隐藏，笔记和进度保留
- **移出书架**：隐藏但保留全部数据
- **删除文件**：移入回收站（`.co-reading-trash/`），可一键恢复

## 目录结构

```
co-reading/
├── server.js              # 后端入口
├── backend/
│   ├── storage.js         # SQLite 存储层
│   ├── locator.js         # 阅读位置协议
│   └── ai/                # AI 问书模块
├── client/
│   ├── src/
│   │   ├── components/    # React 组件
│   │   ├── hooks/         # 自定义 Hook
│   │   └── lib/           # 工具库
│   └── dist/              # 构建产物（需 npm run build）
├── scripts/               # 自动化回归测试
├── .cache/                # 解析缓存（排除在 git 外）
├── .logs/                 # 运行日志（排除在 git 外）
├── co-reading.sqlite3     # 主数据库（排除在 git 外）
└── db.json                # 数据兼容镜像（排除在 git 外）
```

## 启动

在 `co-reading` 目录运行：

```powershell
npm start
```

然后访问 `http://localhost:3030`。也可以继续使用根目录现有的”启动协同读书”脚本。

前端重新构建：

```powershell
cd client
npm run build
```

## 七个已交付迭代

### 迭代一：可靠阅读

- EPUB 按 OPF spine 顺序解析，不再依赖公网 EPUB.js / PDF.js CDN。
- EPUB、DOCX 使用本地结构化正文；PDF 支持浏览器原始版面和文本模式。
- 章节级挂载避免长书一次渲染数万 DOM 节点。
- 统一章节 / 正文块 / 页码定位器，阅读进度以服务端为事实来源。
- 边栏默认关闭，提供明确章节导航、错误状态和阅读设置。
- 数据读取改为内存事实源，写入使用串行队列和临时文件原子替换。

### 迭代二：阅读与共读闭环

- “继续阅读、在读、未读、读完、有笔记”书库视图。
- 私人划线、小组划线、原文讨论和回复。
- 共读小组创建、邀请码加入、成员与里程碑数据模型。
- 书内全文搜索与稳定原文跳转。
- WebSocket 只负责实时通知，核心数据仍通过持久化 API 保存。

### 迭代三：知识复用

- “问这本书”只执行书内检索并返回可跳转出处，不再随机生成伪 AI 回复。
- 每日划线回顾与 Again / Hard / Good / Easy 间隔调度。
- 跨书划线搜索 API。
- 全部私人笔记可导出 Markdown。

### 迭代四：原书图片保真

交付计划与实际实现按以下顺序完成：

1. 建立统一 `image` 正文块和安全图片资源服务，不把大体积 Base64 塞入正文 JSON。
2. EPUB 按章节相对路径恢复包内图片；DOCX 支持将内嵌图片解码到本地缓存，并保留替代文字/图注。
3. PDF 文本模式按当前页延迟提取嵌入图片；复杂版式、扫描件继续用“原版”模式完整保真。
4. 阅读器增加图片懒加载、失败占位、看大图与 50%–400% 缩放，并允许图片收藏、写笔记和发起讨论。
5. 完成桌面 1280×720、移动 390×844、接口安全、生产构建与真实书籍样本验收。

技术边界：EPUB 图片能保持章节语义顺序；DOCX 图片能力已具备，但当前书库中的有效 DOCX 均没有 `word/media` 图片可作正向样本；PDF 的单图提取不等同于版面重建，所以公式、矢量图、文字环绕和扫描页始终以“原版”模式为准。

### 迭代五：自然翻页

1. 阅读设置增加“连续 / 分页”模式并记住个人选择。
2. 连续模式保留原生滚轮滚动，只在章首或章末确认滚动意图后自然跨章。
3. 分页模式支持鼠标滚轮和高精度触控板；累计位移达到 75px 才翻页，并设置 480ms 防连翻窗口。
4. 支持方向键、PageUp / PageDown、空格键和移动端左右滑动；输入框、边栏、图片弹层打开时暂停键盘翻页。
5. 底部导航改为真实“上一页 / 下一页”，同步显示本章页码和全书进度；连续模式的章节导航弱化显示，减少正文遮挡。
6. 图片延迟加载或窗口尺寸变化后通过 ResizeObserver 自动重新计算页数，尾页不足一屏也能正确显示页码。

验收覆盖按钮翻页、滚轮翻页、键盘翻页、跨章、防误触、动态图片分页，以及 390×844 移动端无横向溢出。

### 迭代六：阅读内核与数据基础

1. 用户数据迁移到 `co-reading.sqlite3`，启用 WAL、事务、schema migration 和 FTS5 正文索引；`db.json` 保留为兼容镜像，首次迁移会生成不可覆盖的 `db.json.migration-backup`。
2. `PublicationLocator v2` 同时记录章节资源、源序号、语义进度、页码、资源 ID，以及精确引文/前缀/后缀；旧 blockId 失效时可通过原文重新锚定。
3. EPUB 增加“阅读 / 原版”双视图。阅读模式是默认主线，支持划线、讨论、图片收藏和统一分页；原版用于按需核对 XHTML、CSS、字体、SVG、表格和图片。
4. EPUB 原版视图使用服务端净化、相对资源路由、`srcdoc`、CSP 和禁脚本 iframe；历史 XHTML 1.1 文件使用浏览器容错 HTML 解析。
5. 阅读器媒体块拆到 `ReaderMedia.jsx`，滚轮、触控和键盘输入拆到 `useReadingInput.js`；服务端拆出 SQLite 存储和定位模块。
6. 补充键盘焦点、高对比度模式、ARIA 状态反馈和最大 38px 字号。
7. 新增 `npm run check` 自动回归，覆盖 EPUB / PDF / DOCX、旧定位恢复、安全 EPUB、SQLite WAL 和全文索引。

### 迭代七：书籍全生命周期管理

1. 增加明确的“导入书籍”入口和全页拖拽导入，支持多选 EPUB / PDF / DOCX；导入文件统一复制到 `同读书库/`，不改动来源文件。
2. 服务端先校验文件头/压缩容器，再以 SHA-256 内容哈希查重；重复书默认拦截，用户也可以明确选择保留副本。
3. 新增持久化 `publications` 书目表，将文件发现、显示元数据、阅读数据和书架状态解耦；重新扫描不会覆盖手工编辑的书名、作者和分类。
4. 每本书提供“编辑信息、归档、移出书架、删除文件”菜单；归档仍可阅读，移出只隐藏，均保留原文件、笔记和进度。
5. 文件删除采用可恢复策略：移动到 `.co-reading-trash/`，不做永久删除，并提供原路径一键恢复。
6. 书架提供归档、已移出、文件异常视图；外部移动或删除造成的缺失文件会显式提示，不再静默消失。
7. 新增 `npm run check:iteration7`，用随机临时 EPUB 验收导入、查重、元数据、归档、移出/恢复、文件删除/恢复，并精确清理测试数据。

### EPUB 目录内核修复

- 目录不再由 OPF spine 文件列表冒充：优先解析 EPUB3 Navigation Document，其次解析 EPUB2 NCX，最后才使用正文标题兜底。
- `chapterTitle`、`sectionTitle`、`listTitle*` 等常见出版类名会转换为语义标题，同时保留原始元素 ID 作为目录锚点。
- 正文仍按 spine 文件加载，目录节点通过 `href#fragment` 映射到现有 block，因此不会拆散旧章节或主动删除历史笔记、进度。
- 阅读边栏支持三级及更深层级的展开/折叠、当前小节自动展开与高亮；阅读模式和原版视图使用同一目录定位。
- 《OTN原理与技术》专项回归固定验证 219 个节点、三级层级、零无效目标和章/节/小节跳转。

## 数据和缓存

- 用户数据事实源：`co-reading.sqlite3`（WAL）
- 兼容镜像：`db.json`
- 首次迁移备份：`db.json.migration-backup`
- 解析缓存：`.cache/*.v5.json`
- 图片缓存：`.cache/assets/<bookId>/`（DOCX / PDF；EPUB 直接从原书包按需读取）
- 受管导入书库：上级目录的 `同读书库/`
- 可恢复文件区：上级目录的 `.co-reading-trash/`
- 缓存指纹包含相对路径、文件大小和修改时间，原文件变化后会自动重新解析。
- 旧版 `db.json` 会无损迁移到 SQLite v3 数据结构，旧笔记、进度和讨论不会被删除。

## 主要 API

- `GET /api/library`：聚合书库、进度和笔记统计
- `POST /api/library/import`：校验、查重并导入 EPUB / PDF / DOCX
- `PATCH /api/books/:id/metadata`：修改书架显示的书名、作者和分类
- `POST /api/books/:id/lifecycle`：归档、移出、可恢复删除与恢复
- `GET /api/books/:id/structured-text`：统一章节正文
- `POST /api/books/:id/resolve-locator`：恢复旧定位或漂移后的原文位置
- `GET /api/books/:id/epub-files/*`：受 CSP 保护的 EPUB 原书资源
- `GET /api/books/:id/assets/:assetId`：带路径校验和长缓存的原书图片
- `GET /api/books/:id/pages/:page/images`：按页延迟提取 PDF 嵌入图片
- `GET|POST /api/books/:id/progress`：阅读进度
- `GET|POST /api/books/:id/notes`：私人或小组笔记
- `GET|POST /api/books/:id/discussions`：原文讨论
- `GET|POST /api/rooms`：共读空间
- `POST /api/books/:id/assistant`：有出处的书内检索
- `GET /api/ai/capabilities`：当前问书 Provider、检索器、上下文编译器与降级能力
- `GET /api/review`、`POST /api/review/rate`：复习队列
- `GET /api/export/notes`：Markdown 笔记导出

## 自动回归

先启动服务，再执行：

```powershell
npm run check
npm run check:iteration7
npm run check:toc
npm run check:iteration8
npm run check:iteration9
```

## 迭代 8：可信、可扩展的 AI 问书

问书链路已经从路由中的关键词提示升级为独立领域模块：

1. `QueryPlan` 识别快速/深入模式、问题意图、当前阅读位置和 `bookIds[]`。内部从第一天支持多书输入，后续增加“跨书比较”无需重写协议。
2. `StructureAwareRetriever` 同时利用正文、章节标题、邻近段落、当前章节和图片说明生成证据。
3. `ContextCompiler` 按模式控制证据预算，只把命中的书内片段交给模型。
4. `ProviderRouter` 隔离模型厂商。默认使用本地提取式整理；配置 DeepSeek 后启用远程综合，超时或失败自动回退本地。
5. `AnswerVerifier` 会删除无有效引用或无法由引用支持的主张；没有可信主张时直接拒答。
6. 每次运行仅记录诊断元数据、问题、Provider、耗时和验证结果到 SQLite `ai_runs`，不记录 API 密钥。

可选 DeepSeek 配置（均为服务端环境变量，切勿提交密钥）：

```powershell
$env:DEEPSEEK_API_KEY="你的密钥"
$env:DEEPSEEK_MODEL="deepseek-chat"
$env:DEEPSEEK_BASE_URL="https://api.deepseek.com"
npm start
```

主要扩展接口位于 `backend/ai/`：

- `Retriever.retrieve(plan, publications)`
- `ContextCompiler.compile(plan, evidence)`
- `Provider.answer(plan, contextPackage)`
- `AnswerVerifier.verify(candidate, contextPackage)`

替换模型、增加向量检索或重排器时不需要修改阅读、书库、定位器及引用展示逻辑。

## 迭代 9：稳定滚轮翻页

阅读模式的滚轮输入采用独立手势状态机：

- 统一像素、行和整页三种滚轮单位，过滤触控板横向漂移。
- 分页模式按滚动距离持续累计，并由翻页动画限速；不再要求滚轮出现固定时长的完全静默。
- 分页翻页和连续模式跨章都使用“滚动距离 ÷ 当前阅读视口高度”的相对单位，不依赖浏览器缩放后的固定 CSS 像素。
- 动画期间最多保留一个后续翻页意图，既能持续向下翻，也不会形成无限翻页队列。
- 同一次物理手势只允许触发一次翻页，动画期间及其惯性尾部只消费事件。
- 反向滚动会清空之前的累计，不会在稍后意外翻页。
- 翻页等待实际 `scrollend` 或位置稳定后结束，不使用固定时间锁。
- 连续模式在章节边界需要两次独立手势确认，避免触控板惯性直接跨章。
- 字号、行距、侧边栏和图片加载造成重排时，以当前正文块为锚点修正位置。
- 鼠标、键盘和页面按钮统一调用同一个繁忙保护翻页控制器。

基础验收位于 `client/scripts/iteration9-check.mjs`。长时压力测试位于 `client/scripts/iteration9-long-run.mjs`，覆盖高分辨率滚轮1000页、机械滚轮1000页、触控板短滑500轮和衰减惯性500轮。缩放矩阵位于 `client/scripts/iteration9-zoom-check.mjs`，覆盖100%、125%、150%、175%、200%、225%和250%。

## WA-1：WorkAgent 阅读协作

`co-reading` 现在可以把 WorkAgent 作为首选智能体基础设施，同时保持两个项目独立演进。代码只修改本项目，不上传整本书，也不读取或修改 WorkAgent 的内部数据。

协作链路：

1. co-reading 解析问题并检索原书正文、邻近段落、目录节点、图片说明和相关笔记。
2. `ReaderContextAdapter` 将证据转换为带稳定 `coreading://` 来源 URI 的通用上下文。
3. `WorkAgentProvider` 通过 WorkAgent 现有 `/api/gateway/v1/messages` 接口发起任务；深入理解使用异步任务并轮询结果。
4. `AnswerNormalizer` 接收严格 JSON 或带引用的文本，所有书内主张继续经过 `AnswerVerifier`。
5. WorkAgent 离线、超时或回答不可校验时，自动降级为直连 DeepSeek，再失败则使用本地证据整理。
6. WorkAgent 只提出理解结果；笔记、书库和阅读进度仍由 co-reading 管理。

默认探测本机 `http://127.0.0.1:8766`。可选服务端配置：

```powershell
$env:WORKAGENT_ENABLED="true"
$env:WORKAGENT_BASE_URL="http://127.0.0.1:8766"
$env:WORKAGENT_QUICK_MODEL="deepseek:deepseek-chat"
$env:WORKAGENT_DEEP_MODEL="deepseek:deepseek-reasoner"
$env:WORKAGENT_SHARED_SECRET=""
$env:WORKAGENT_QUICK_TIMEOUT_MS="35000"
$env:WORKAGENT_DEEP_TIMEOUT_MS="120000"
$env:WORKAGENT_POLL_INTERVAL_MS="1000"
npm start
```

如果 WorkAgent 的 `co-reading` channel 要求入站签名，两个进程应配置相同的 shared secret。密钥只存在于服务端环境变量，不会发送到浏览器。

验收：

```powershell
npm run check:workagent
npm run check:iteration8
npm --prefix client run build
```

## 后续扩展边界

当前存储层集中在 `backend/storage.js`，定位协议集中在 `backend/locator.js`。未来增加跨设备同步时，应基于增量事件日志扩展，而不是让 WebSocket 直接成为数据事实源。
