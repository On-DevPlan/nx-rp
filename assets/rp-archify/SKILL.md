---
name: rp-archify
description: nx-rp chart archify —— 把 archify skill 产出的图表登记进当前项目（cwd scope），在 nx-rp 面板「图表」tab 切换查看。当用户要求「画架构图/流程图/时序图并放进面板」「登记图表 / 上传图表」「切换图表」时使用。触发词：archify、图表、架构图接入、登记图表、图表切换、chart archify、rp-archify。**不适用于**：只要一张独立 HTML 图（直接用 archify skill 即可，不必登记）、graphviz DOT 交接（用 nx-rp chart save/load）。
---
# rp-archify — 把 archify 图表接入 nx-rp 面板

分工一句话：**archify skill 负责画图**（自包含 HTML，落在 archify 工作目录），
**nx-rp 负责收图**——把产物拷进 scope 存储、登记，面板「图表」tab 下拉切换查看。
图是**只读产物**：改图 = 重跑 archify，不手改 HTML。

登记是**拷贝语义**：`add` 把 HTML 复制进 `~/.nx-rp/archify/<cwd哈希>/`，
之后删源文件不影响面板；`remove` 也只删副本与登记。

## agent SOP（三步：落点 → 画图 → 登记）

1. **选工作目录**：图表默认落在 `~/.nx-rp/.archify-cwd/<type>-<slug>-<YYYYMMDD-HHMMSS>/`（nx-rp 用户目录下），不要把产物放进 cwd（项目仓库）——`discover` 扫的也是这个目录而不是 cwd 的 `.archify/`。
2. **画图**：调用 archify skill（`/archify`），按用户要的类型（architecture / workflow / sequence / dataflow / lifecycle）生成图表。产物形如：
   ```
   ~/.nx-rp/.archify-cwd/architecture-web-20261011-153000/
     candidate.json        ← 结构化事实源（含 meta.title / diagram_type）
     <slug>.html           ← 自包含交付物（内联 SVG + viewer + 字体）
   ```
3. **登记关联到当前项目**（**用绝对路径**——产物不在 cwd）：
   ```bash
   nx-rp chart archify discover    # 看 ~/.nx-rp/.archify-cwd/ 里有哪些未登记产物
   nx-rp chart archify add \
     --file /c/Users/.../.nx-rp/.archify-cwd/architecture-web-20261011-153000/web.html \
     --candidate /c/Users/.../.archify-cwd/.../candidate.json \
     --name "Web 架构"
   nx-rp chart archify list        # 验证：面板「图表」模式可见
   ```
   `--candidate` 建议带上：面板显示的类型/标题元数据来自它；`--name` 缺省用 candidate 标题，再缺省用文件名。

## 命令一览（CLI 与面板「图表」模式同源）

```bash
nx-rp chart archify list                  # 已登记图表（scope 隔离）
nx-rp chart archify discover              # 扫 ~/.nx-rp/.archify-cwd/ 的未登记产物
nx-rp chart archify add --file x.html [--candidate c.json] [--name 名]
nx-rp chart archify remove --id <id>      # 移除登记 + scope 副本（源产物不动）
nx-rp chart archify view --id <id>        # 打印图表 HTML 的绝对路径
```

面板：「图表」tab ——下拉切换、扫描 .archify、移除。
预览/编辑（DOT）模式与图表模式并存：archify 是精排的模块级视图，
dot 是全量文件级视图，互不替代。

## 边界（不变量）

- **不自动生成**：图一律出自 archify skill 的精修流程——本模块不调 archify
  CLI、不从源码自动出图（机器自动生成的架构图不可信）。要「依赖总览」，
  用 archify skill 认真画一张再登记
- **产物出项目**：archify 的 HTML 不落在 cwd（仓库）下，落在 `~/.nx-rp/.archify-cwd/`
  ——`chart archify add` 用绝对路径拷进 scope 存储；删源不影响面板。
  这条设计避免项目目录被生成物污染，也方便按用户目录统一查看所有图表
- **HTML 只读**：登记/展示不改产物内容；改图 = 重跑 archify 重新登记（同名覆盖）
- **scope 隔离**：登记关系按 cwd 哈希分目录，多项目互不干扰；
  面板 iframe 经 `?scope=` 显式透传激活目录（导航请求不带 scope 头）
- **不是图表渲染器**：nx-rp 不解析/不渲染 archify candidate——这里只做
  登记、发现、直出
- **产物校验是软校验**：`add` 检查 HTML 头部的 archify 标识（防手滑收错文件），
  不是安全边界；图表内容信任级 = 本地打开该 HTML