# D2Tunnel 虚拟网盘：需求冻结、有限阶段与验收合同

> 状态截至 2026-10-27，分支 `d2tunnel-disk`。此文档是验收范围和退出条件，不等于实测报告。
> 以实际 GitHub Actions 日志、Wrangler HTTP 结果、Cloudflare 测试环境验证记录为证据。没有运行日志一律记为「未验证」，不能写「通过」。

## 范围冻结

只交付用户最初提出的：现有 ImgBed 上传兼容、分区、无限层级目录及面包屑、同分区/跨分区移动复制、协作者跨分区协作、S3 常用对象 API、分享与撤销、逐文件静态公开链接、预览及 Range/分片读取、Cloudflare Pages 或 Workers 可用。已有文件不迁移到 file-tunnel SQLite，不破坏原 ImgBed 上传方式。

S3 的交付范围是项目文档中公开的常用对象和 Multipart 子集，不承诺 AWS S3 全部 IAM/ACL、版本控制、生命周期、桶创建/删除或未定义的客户端特性；新增这些能力属于新需求，单独立项。对已声明的 API 必须测试与说明限制。

## 有终点的五阶段

| 阶段 | 工作及退出条件 | 目前状态 | 用户何时可验收 |
| --- | --- | --- | --- |
| G0 需求基线 | 本文档锁定需求，生成「需求→API/界面→测试」矩阵；冻结额外特性 | 本次建立，仍需核对实现清单 | 评审需求范围和不做项 |
| G1 本地可复现验收 | `npm ci`、`npm test`、`npm run test:server`、Pages Functions build、Workers dry-run build、`npm run test:wrangler:local` **全部退出码为 0**；保存运行日志和失败清单。每次启动使用独立 D1/KV/R2，不连线上 | **当前下一个阻塞关口**：Wrangler 真实结果未取得 | **首次正式验收**：在本机打开 `/disk.html` 按矩阵试用 |
| G2 云端隔离验收 | 在 Cloudflare **测试** Pages 和 Workers 环境部署；四个 D1 迁移，绑定/密钥隔离；D1/KV/R2 真正持久化；分享、鉴权、缓存、Range、5MiB+ 分片可用；验证跨进程重启与失效票据 | 未开始；需测试账号与绑定/部署权限 | 云端可分享的预览地址，不能使用生产密钥 |
| G3 原需求全量场景验收 | 下表中的所有必验场景留有通过证据，至少一套第三方 S3 客户端真实对接，真实 ImgBed Telegram/Discord/R2 上传兼容、不迁移原文件、不丢引用；禁用权限和过期分享无法读取 | 未开始；需 G1、G2 环境与对应存储渠道 | **功能最终验收**：用户逐项签收 |
| G4 发布与收尾 | 完成备份与回滚演练，合并前审查密钥/安全/迁移，零 P0/P1 缺陷；部署发布说明和已知限制；修复回归后复测，冻结版本 | 未开始 | **项目完成**：签收发布版及文档 |

注意：「已实现」和「通过验收」是两回事。历史开发中虽然已有大量提交、静态检查和测试用例，但 **G1 的真实 Wrangler/CI 证据仍缺失**，因此不可宣称已经通过 G1。

## 原始需求 → 有限验收矩阵

| ID | 原始需求 | 最低必须验证的行为 | 主要验收方式 |
| --- | --- | --- | --- |
| R01 | 原 ImgBed 上传不变 | 原有 R2 和 Telegram/Discord 上传成功，记录可读；可选关联网盘目录，不关联也不受影响 | G1 R2 自动化，G3 真实其他渠道 |
| R02 | 多级目录、面包屑 | 创建 3 层目录、返回各层、空目录可保留、同名冲突提示清晰 | G1 HTTP+UI，G3 |
| R03 | 分区与空间操作 | 新建、改名、删除、列表及分区隔离；未完成 multipart 时不能删分区 | G1/G3 |
| R04 | 移动/复制 | 同分区、跨分区、不同授权分区 copy/move，原始 bytes 不重传；不能复制入子目录形成环 | G1/G3 |
| R05 | 协同 | 只读只看、只写权限受限、8 密钥跨分区、撤销令牌后立即失效，不泄露物理 ID | G1/G3 |
| R06 | 分享 | 文件与文件夹链接、过期/撤销、子树隔离、未授权 403/404 | G1/G3 |
| R07 | 静态资源 | 未公开不可读、单个文件选择公开、关闭公开即失效、R2/非 R2 内容正常 | G1/G3 |
| R08 | 文件预览及流式分段 | 图片、视频、文本、PDF 的 GET/HEAD/Range、suffix、416、If-Range；视频 seek 不需要全文件进内存 | G1/G2/G3 |
| R09 | S3 常用对象 API | SigV4 header/预签名、List/Get/Head/Put/Copy/Delete/BulkDelete、multipart initiate/part/list/complete/abort | G1 自动化、G3 S3 客户端 |
| R10 | 不采用 file-tunnel SQLite 模式 | 网盘元数据 D1，文件字节走原渠道，复制无需转存；不破坏原 ImgBed 数据 | G2/G3 |
| R11 | Cloudflare 两种部署 | Pages、Workers 都能 bundle、启动、绑定 D1/KV/R2，接口和前端真实可用 | G1/G2 |
| R12 | 数据生命周期、安全 | 误删保护、元数据修改引用更新、GC 只回收不被引用的 S3 源文件、备份恢复、过期令牌 | G1/G2/G4 |

范围边界：尚未获得 G1 自动化证据的条目均记为待验收；R01/R08 的 Telegram、Discord 真实外部 API 验证需测试密钥，不应在 CI 中暴露。

## 缺陷退出规则（杜绝无限开发）

- **P0**：数据永久丢失、认证绕过、公开私有对象、破坏原 ImgBed 数据；出现即停发，必须修复并重跑受影响关口。
- **P1**：原始需求关键操作无法完成、Pages 或 Workers 不能启动、S3 必须实现的协议失败；必须修复才允许进入下一关口。
- **P2**：可规避的次要 UI/兼容问题；明确记录、限定修复回合，不挡最终验收，除非用户决定提升优先级。
- **新功能**：不进入本次验收。单列后续版本，无须等待本次完成。
- 每一阶段最多两轮集中修补；若仍有 P0/P1，阶段明确标为「阻塞 + 缺陷编号 + 责任 + 复现」，不宣布成功也不把开发无限延长。下一轮只修阻塞项。
- 在每次阶段结束更新本文档的「状态、日志/链接、未通过用例」。所有 R01–R12 通过（或用户书面接受明确列出的限制）且 G4 通过，即停止开发本版本。

## 真实验收证据格式

`阶段 | git SHA | 测试环境 | 测试命令/手工场景 | 结果 | 日志链接 | P0/P1/P2 | 复测结果`

本地测试命令：
```sh
npm ci
npm test
npm run test:server
npm run test:wrangler:local
```

线上测试部署必须使用与生产隔离的 Cloudflare 绑定。没有 Cloudflare 测试账户/凭据时，不能用「代码可部署」替代 G2 的真实部署。用户在 G1 可先预验收，在 G3 逐项功能验收，G4 进行发布签收。

## 2026-10-27 验收执行记录（本轮）

- G0：已建立需求矩阵和五阶段验收合同；不自动扩张功能范围。
- G1：未通过。Wrangler Pages/Workers HTTP 测试入口已补齐跨分区复制/移动、分享撤销、三级面包屑，并且 CI 配置将上传 `wrangler-http.log`；然而目前 GitHub API `actions/runs` 返回 **0 条执行记录**，当前助手容器未装 Wrangler 且不能连接 npm registry。因此没有可引用的 HTTP 运行通过证据。
- 建立了仅用于验证、**不会自动合并**的 Draft PR：<https://github.com/Ltre/CloudFlare-ImgBed/pull/1>。如果 Actions 依然为 0，须核查该仓库 Actions 是否启用、是否需要批准执行，以及工作流是否在默认分支注册。G1 必须有真实退出码及日志。
- G2：需要 Cloudflare 隔离测试环境的账户/绑定或部署权限，尚未开始。
- G3/G4：明确待启动，绝不把测试用例存在或源码已提交视为已签收。

### 当前阶段距离（按关口，不猜工作日）

**离首次正式本地验收：** 还需通过 G1 一个关口（含所有本地单测、bundle 和 Wrangler HTTP 真实运行；出现 P0/P1 先修复）。
**离最终功能验收：** 还需 G1、G2、G3 三个关口。
**离完整交付结束：** 还需 G1、G2、G3、G4 四个关口。不能按提交数量换算百分比。


### G1 修补记录：2026-10-27，Range / 本地烟雾测试 HTTP 契约

- 修复 S3 Range 对合法越界结束位置返回 416 的问题；现在复用现有 `parseSingleByteRange`，并针对 R2 与 ImgBed 非 R2 渠道统一 `If-Range` 验证语义。
- 修正烟雾测试对目录创建、分享创建响应 201 的误判；加入后缀范围、起始位置不可满足 416、结尾超长裁剪 206 的真实 HTTP 断言。
- 新增 `test/s3-range-route.test.js` 隔离测试。已执行仓库真实范围解析器的 8 个输入测试并全部通过；**新增隔离测试本身未运行**，不可替代完整 Mocha 测试或 workerd。
- 本轮查到 GitHub Actions 运行记录仍为 **0**。下一步必须获取 `npm ci && npm test && npm run test:wrangler:local` 的实际成功日志，然后才允许声称 G1 通过。

 
### G1 迭代记录 · 2026-10-27 S3 列表分页

- 修正 S3 ListObjectsV2 的逻辑目录分组分页：对 CommonPrefixes 先去重再按逻辑键分页，并正确处理 V2 continuation-token/start-after、V1 marker。
- 增加 `test/s3-list-pagination.test.js` 单元回归和 `scripts/wrangler-disk-smoke.mjs` 跨页真实 HTTP 断言，预期 `docs/`、`misc/`、`z.txt` 各出现一次。
- 已直接执行实际 `listBucket`/目录构造代码，V1/V2、前缀、start-after、非法上限的函数级验证通过。
- 尚无 `npm test`、Wrangler Pages/Workers 实际成功证据；GitHub Actions 尚无运行记录。**G1 不能通过，G2 不能开始。**

 
### G1 · 2026-10-27 用户 Windows npm 安装脚本及 Mocha CLI 阻塞

- 真实用户日志：Node v24.17.0，`npm ci` 实际安装 347 个包但阻止 better-sqlite3/esbuild/workerd 原生安装脚本，`npm test` 在启动时因错误 `node_modules/mocha/bin/mocha.js` 返回 ERR_MODULE_NOT_FOUND；上传日志没有实际构建失败堆栈。
- 修复：`package.json` 使用锁文件 Mocha 8.1.3 的真实入口 `bin/mocha`；为用户环境及仓库锁文件出现的原生依赖版本配置 pinned `allowScripts`，不放开所有 npm install scripts。
- 新增：`npm run doctor:local`（验证原生依赖实际可执行）、`npm run build:local`（Pages build + Workers dry-run）、`npm run verify:local`（从环境检查直到双模式 Wrangler HTTP 的完整 G1 流程）和 `test/local-toolchain.test.js`。
- 静态检查：Mocha CLI 与 lockfile bin 一致；锁定的原生依赖版本获准；构建命令包含 --dry-run。**未在用户本机执行重新安装、Mocha 或 Wrangler，G1 尚未完成**。
- Windows 推荐 Node 22 LTS 与 GitHub Actions 基线一致；不要使用 `npm audit fix --force` 强行降级 Miniflare。9 个审计告警保留后续独立治理。

 
### 2026-10-27 用户调整 G1 工作优先级（测试环境暂缓）

- 用户明确要求继续开发业务，**以后再解决本地测试问题**；不视为放弃验收标准，G1 仍记为阻塞、未通过，之后需要完整 `npm test`、Pages/Workers 构建、Wrangler 双模式 HTTP 及缺陷复测。
- 本轮继续修复 R04/R05 协同操作：`disk.html` 依据所选分区实时重算权限，读源+写目标可以跨分区复制，移动仍须双向写授权；目标列表过滤至可写分区。
- 修复 R05/R12 隐私回显：协作者 `mkdir/import/rename/public` 写接口响应与 `browse` 一致，不泄露底层 ImgBed `source_id`；管理员保持完整响应。
- 新增六组协作者/管理员写入 API 响应回归，尚未在 Mocha 实跑。已直接执行源码权限/脱敏函数七项小范围检查，不能据此宣布 G1 通过。


## 2026-10-28 · 用户确认的交付范围修订（覆盖原 R08 全渠道假设）

> 此节是用户后续明确指示，优先级高于上文原始矩阵中可能暗示“所有上传渠道均要同等级 Seek”的描述。保留 G0–G4 五关，不引入无限新增功能。

### 必须完成并验收的功能

1. **图片、视频、音频、PDF、文本预览**：文件预览不仅有 UI 入口，还须在 **Telegram 存储**的普通文件及分片文件上真实可读；视频/音频拖动、HEAD/GET/206/416、If-Range、部分下载和预览票据均有记录。
2. **大文件分片与 Range**：Telegram 是必须达到可靠 Seek 的目标；**不要求所有存储渠道实现同等 Range/Seek**。R2、Discord 等保留现有能力和已承诺的基础兼容，但不以逐渠道完整 Seek 阻挡本版本。
3. **复用 ImgBed 原上传**：保留原有上传系统，网盘页面普通文件继续走 `/upload`，大文件调用 ImgBed 既有 `initChunked=true`、`chunked=true`、`merge=true`、失败清理，完成后只关联 D1 虚拟文件，不自建第三套存储方式。需验证 Telegram 大文件实际上传后可拖动预览。
4. **双云部署**：Cloudflare Workers 与 Pages 需分别通过真实 bundle、绑定、迁移、上传/浏览、分享和 Telegram Range；必须具有运行日志，不得以本地语法解析取代部署验收。
5. **S3 / Android FolderSync 实际兼容**：FolderSync 的「S3 Compatible」账号连接测试分区，完成列桶/连接、目录浏览、文件上传/下载、覆盖、复制（如客户端有此操作）、删除、增量和双向文件同步、大文件 Multipart、失败及重试；重点核验 SigV4、Path-style、ListObjectsV2 分页、Head/Get/Put/Delete、ETag/LastModified、GetBucketLocation、ListParts/CompleteMultipart。**不扩展为 AWS 全量 S3**。允许客户端设置「禁用目录占位对象」来适配 D1 真实文件夹。
6. **跨分区/跨协同大目录操作**：复制/移动大量节点时不丢源文件、不破坏原 ImgBed 引用；错误中断、同名冲突、权限被撤销、并发变动下应有明确结果和可恢复状态。既有 2000 节点上限须明确说明，不能默默留下不完整的目标目录。

### 已开发但还未获得真正验收证据

- 网盘页面已接入 ImgBed 原生 8 MiB 分片上传，支持 Telegram/R2/S3/Discord，并对失败会话尽力清理；仍需真实浏览器/Telegram 存储验证。HuggingFace/WebDAV 大文件不在新分片流程之内，页面会给出提示。
- Telegram 分片 Range 改为背压流式拉取，只获取请求范围内所需分片；取消读取不会继续预取整文件；独立 Node.js 单元小测已通过 4 项，未替代真实视频 Seek。
- S3 已补 GetBucketLocation / HeadBucket 区域提示；Wrangler HTTP 烟雾测试已增加相应断言，**Android FolderSync 真实连接和双向同步尚未进行**。
- 本地 Windows 构建/依赖问题按用户指示**暂缓到之后集中修复**，G1 状态保留「阻塞/未通过」，不跳关。

### FolderSync 实际验收建议配置（测试环境）

参考 https://foldersync.io/docs/help/cloudservices/ 的 S3 Compatible 选项：

- 服务类型：S3 Compatible；地址：`https://<你的域名>/s3`；Bucket：已由网盘管理员预先创建的分区 UUID；使用 `DISK_S3_ACCESS_KEY` / `DISK_S3_SECRET_KEY`。
- Path-style access：开启；Disable payload signing：开启（对应当前网关 UNSIGNED-PAYLOAD 大文件流）；Disable folder objects：开启（D1 目录不是物理 S3 零字节占位对象）；Region：`us-east-1`；服务端加密：不要开启不受支持的 SSE 参数。
- 用**隔离测试分区**开始；首次先单向上传和下载，确认对象 ETag、LastModified、列表、删除正确后再测试双向同步。FolderSync 针对 S3 无法写回远端文件修改时间，若出现反复同步须收集原始客户端日志。
- 这是一套**预期配置，尚未宣称 Android App 已成功连接**。


### 2026-10-28 · 跨区大目录上限写前预检

- `core.transfer` 已采用 WITH RECURSIVE 在跨区操作前计算完整子树规模，超过 2000 节点即返回 TREE_TOO_LARGE，禁止先复制部分节点再尝试清理；新增对应 `test/disk.test.js` 用例。
- 在独立 SQLite 内存数据库执行同等 SQL，2001 节点的 count 结果正确；**正式 Mocha 和 D1 压测未运行**。仅解决超限早失败，未解决崩溃/并发下的全事务问题。
