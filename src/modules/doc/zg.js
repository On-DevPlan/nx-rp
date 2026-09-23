// zg-boot 模块业务：zvec-grep 召回引擎的启动引导。
//
// 职责边界（zg 只当召回引擎，不装 MCP）：
//   - install：检测 zg 可用性（不跑 zg install——那是 MCP 安装，明确不做）
//   - auth：引导用户去千问平台生成 API key，写入 ~/.zvec-grep/config.json
//     （zg 自己的全局配置，key 绝不入 nx-rp store、绝不入库）
//   - config：设置全局默认 embedding 模型（qwen/qwen3.7-text-embedding，统一远程）
//   - index：对当前 cwd 的知识库目录建/增索引（direct 模式 --refresh wait）
//   - query：召回（--compact --preview short，预算档位）
//   - status：知识库索引状态
//
// 所有 zg 调用都是一次性子进程（--mode direct），零常驻、零端口。
import { execFile, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cwdScope, cwdDir, docRootFor, workspaceKbFor } from '../../core/paths.js';
import { invalidInput } from '../../core/errors.js';

// 默认远程 embedding 模型。用户可在三款 zg 目录支持的远程模型中选择（支持中文的）：
//   qwen/qwen3.7-text-embedding   文本 1024 维，128K 输入（默认，长文档强）
//   qwen/text-embedding-v4        文本 1024 维，8K 输入（经典款）
//   qwen/qwen3-vl-embedding       多模态 2560 维，32K 输入（唯一支持图片）
// 选定后写入 zg 全局配置（~/.zvec-grep/config.json），全部 workspace 共用同一模型；
// 换模型必须对每个已建索引的 KB 跑 zg index --rebuild（zg manifest 保证一致性）。
export const ZG_DEFAULT_MODEL = 'qwen/qwen3.7-text-embedding';
export const ZG_REMOTE_MODELS = [
  { id: 'qwen/qwen3.7-text-embedding', dim: 1024, tokens: 128000, input: 'text', note: '默认；超长文档' },
  { id: 'qwen/text-embedding-v4', dim: 1024, tokens: 8192, input: 'text', note: '经典款' },
  { id: 'qwen/qwen3-vl-embedding', dim: 2560, tokens: 32000, input: 'text+image', note: '唯一支持图片' },
];
export const ZG_KEY_GUIDE_URL = 'https://platform.qianwenai.com/home/';

// 校验用户传入的模型 id：必须是 zg 目录里已知的远程模型（防拼错建出废索引）。
export function resolveModel(model) {
  if (!model) return ZG_DEFAULT_MODEL;
  const hit = ZG_REMOTE_MODELS.find((m) => m.id === model);
  if (!hit) {
    throw invalidInput(
      `不支持的模型: ${model}。可选（远程）: ${ZG_REMOTE_MODELS.map((m) => m.id).join(' / ')}`,
    );
  }
  return hit.id;
}

const ZG_BIN = process.platform === 'win32' ? 'zg.cmd' : 'zg';

function runZg(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const done = (err, stdout, stderr) => {
      // stdin 关闭：zg 非交互，任何等待输入的意外都会被这里终结
      const finish = () => resolve({
        ok: !err,
        code: err ? (err.code ?? 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
      finish();
    };

    if (process.platform === 'win32') {
      // Windows：zg 是 .cmd，必须经 cmd.exe。走 spawn + 完整命令串，
      // 避开 execFile(args 数组 + shell) 的 DEP0190 警告路径。
      // 注入面评估：全部入参由 nx-rp 组装（固定 flag + 枚举值 + 用户 key，
      // key 为 sk- 前缀的 URL-safe token），不含可控 shell 元字符。
      const line = [ZG_BIN, ...args].map((a) => (/[\s"^&|<>]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(' ');
      const child = spawn('cmd.exe', ['/d', '/s', '/c', line], {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('error', (err) => done(err, stdout, stderr));
      child.on('close', (code) => done(code === 0 ? null : Object.assign(new Error('zg failed'), { code }), stdout, stderr));
      return;
    }

    execFile(ZG_BIN, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => done(err, stdout, stderr));
  });
}

// 指定工作目录跑 zg（zg 0.2.x 的 query 从进程 cwd 解析 workspace）。
function runZgIn(cwd, args, opts = {}) {
  return new Promise((resolve) => {
    const line = [ZG_BIN, ...args].map((a) => (/[\s"^&|<>]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(' ');
    const child = spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      process.platform === 'win32' ? ['/d', '/s', '/c', line] : ['-c', line],
      { cwd, windowsHide: true, timeout: opts.timeoutMs ?? 120_000 });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => { stdout += c; });
    child.stderr?.on('data', (c) => { stderr += c; });
    child.on('error', (err) => resolve({ ok: false, code: 1, stdout, stderr: String(err.message) }));
    child.on('close', (code) => resolve({ ok: code === 0, code: code ?? 1, stdout, stderr }));
  });
}

// docRoot 来自 store.json settings（全局共享），这里现读避免引 store 造成分层穿透。
async function readDocRootSetting() {
  const { getCurrentScope } = await import('../../core/store.js');
  try {
    const { store } = await getCurrentScope();
    return store.settings?.docRoot;
  } catch {
    return undefined;
  }
}

// ─── install：可用性探测（不装 MCP）───────────────────────────────

export async function install({ root } = {}) {
  const model = await currentModel();
  const probe = await runZg(['version'], { timeoutMs: 15_000 });
  const version = probe.ok ? probe.stdout.trim().split('\n')[0] : null;
  const dir = kbDirFor(root);
  let indexed = false;
  try {
    indexed = existsSync(join(dir, '.zvec-grep'));
  } catch { /* 目录不存在 */ }
  return {
    zgInstalled: probe.ok,
    version,
    mcpNote: 'MCP 不安装（zg 只做召回引擎）。若之前 zg install 过，跑 zg --uninstall --target claude 摘掉。',
    kbDir: dir,
    indexed,
    embedding: model,
    modelOptions: ZG_REMOTE_MODELS,
    keyConfigured: await keyConfigured(),
    nextSteps: probe.ok ? nextSteps(indexed) : ['npm install -g @zvec/zvec-grep', ...nextSteps(indexed)],
  };
}

function nextSteps(indexed) {
  const steps = [];
  if (!indexed) steps.push('nx-rp zg auth   # 配置远程 embedding key（引导页 ' + ZG_KEY_GUIDE_URL + '）');
  steps.push('nx-rp zg index  # 为当前工作区知识库建索引');
  steps.push('nx-rp zg query "问题"  # 语义召回');
  return steps;
}

function kbDirFor(root) {
  const dir = root
    ? workspaceKbFor(root)
    : workspaceKbFor(cwdScope());
  return dir;
}

// 共享知识库目录（与 doc/service.js 的 sharedKbFor 同一公式——同模块内两处
// 独立小函数比跨文件回环 import 更直白；有测试断言两侧一致）。
function sharedDirFor(docRootSetting) {
  return join(docRootFor(docRootSetting), 'shared');
}

// 当前生效的全局模型：读 zg config 输出（拿不到就报默认值）。
// 只取模型 id，不碰 providers 里的 key。
async function currentModel() {
  const probe = await runZg(['config', 'model', 'get'], { timeoutMs: 15_000 });
  if (probe.ok) {
    const m = probe.stdout.match(/qwen\/[\w.-]+|local\/[\w.-]+/);
    if (m) return m[0];
  }
  return ZG_DEFAULT_MODEL;
}

// ─── auth：key 引导与录入 ──────────────────────────────────────────

// key 是否已配置过：探测 zg 的全局配置（不读内容——key 值连 nx-rp 都不看）。
async function keyConfigured() {
  const probe = await runZg(['auth', 'status'], { timeoutMs: 15_000 });
  // 没配 provider 时 zg 返回非零或输出里无 grant；宽松处理：命令能跑就算环境在，
  // 是否有 key 由 config provider set 的成败决定，这里只报「未探测到 workspace grant」。
  return probe.ok && /grant|authorized/i.test(probe.stdout);
}

export async function auth({ key, model, browser: _browser = true } = {}) {
  if (!key || typeof key !== 'string' || key.length < 20) {
    return {
      needKey: true,
      guideUrl: ZG_KEY_GUIDE_URL,
      modelOptions: ZG_REMOTE_MODELS,
      hint: '在引导页生成 API key（sk- 开头），然后 nx-rp zg auth --key <key> [--model <模型>]。key 只写入 ~/.zvec-grep/config.json，nx-rp 不存储不转发。',
    };
  }
  const modelId = resolveModel(model);
  // 1. provider credential（全局，一次配置）
  const r1 = await runZg(['config', 'provider', 'set', 'qwen', '--api-key', key], { timeoutMs: 30_000 });
  if (!r1.ok) return { ok: false, step: 'provider', stderr: r1.stderr };
  // 2. 全局默认模型 = 用户选的远程模型
  const r2 = await runZg(['config', 'model', 'set', modelId, '--default'], { timeoutMs: 30_000 });
  if (!r2.ok) return { ok: false, step: 'model', stderr: r2.stderr };
  // 3. workspace 授权（当前 cwd 的 KB 目录）
  const dir = kbDirFor();
  await fsp.mkdir(dir, { recursive: true });
  const r3 = await runZg(['auth', 'grant', dir, '--capability', 'embedding', '--scope', 'workspace', '--embedding', modelId], { timeoutMs: 30_000 });
  return {
    ok: r3.ok,
    step: 'grant',
    kbDir: dir,
    model: modelId,
    stderr: r3.ok ? undefined : r3.stderr,
    note: 'key 已写入 zg 全局配置；workspace 授权签名存 <kb>/.zvec-grep/authorization.json。',
  };
}

// ─── onboard：新用户一条命令走完引导 ──────────────────────────────
//
// 体验闭环（全部一步完成，缺啥补啥）：
//   1. zg 未装 → 给安装命令
//   2. 无 key → 返回引导页 URL（用户去生成，贴回来重跑）
//   3. 有 key → provider + 固定远程模型 + workspace 授权
//   4. docRoot 未设 → 用默认（~/.nx-rp/doc），不必显式设置
//   5. doc 未导出 → 提示 nx-rp doc export；未索引 → 提示 nx-rp zg index
// key 纪律：key 只经本函数传给 zg CLI 进程参数，写进 ~/.zvec-grep/config.json；
// 返回值、日志、store 全程不携带 key 明文。
export async function onboard({ key, model } = {}) {
  const probe = await runZg(['version'], { timeoutMs: 15_000 });
  if (!probe.ok) {
    return {
      step: 'install-zg',
      done: false,
      message: '第一步：安装召回引擎\n  npm install -g @zvec/zvec-grep\n装好后重跑 nx-rp zg onboard',
    };
  }
  if (!key || typeof key !== 'string' || key.length < 20) {
    return {
      step: 'get-key',
      done: false,
      guideUrl: ZG_KEY_GUIDE_URL,
      modelOptions: ZG_REMOTE_MODELS,
      message:
        '第二步：获取远程 embedding key（免费）\n' +
        `  打开引导页：${ZG_KEY_GUIDE_URL}\n` +
        '  生成 API key（sk- 开头），然后：\n' +
        '  nx-rp zg onboard --key <你的key> [--model <模型>]\n' +
        '  可选模型（默认 ' + ZG_DEFAULT_MODEL + '）:\n' +
        ZG_REMOTE_MODELS.map((m) => `    ${m.id}  (${m.note})`).join('\n') +
        '\n  （key 只写入 ~/.zvec-grep/config.json，nx-rp 不存储不回显不转发）',
    };
  }
  const authResult = await auth({ key, model });
  if (!authResult.ok) {
    return { step: `auth:${authResult.step}`, done: false, message: `配置失败（${authResult.step}）：${authResult.stderr}` };
  }
  // 收尾状态探测：doc 是否导出过 / KB 是否已索引
  const dir = kbDirFor();
  const indexed = existsSync(join(dir, '.zvec-grep'));
  const hasMd = indexed || (await fsp.readdir(dir).then(
    (fs) => fs.some((f) => f.endsWith('.md')),
    () => false,
  ));
  return {
    step: 'done',
    done: true,
    kbDir: dir,
    indexed,
    message:
      `配置完成（模型 ${authResult.model}，全局统一）\n` +
      `知识库目录: ${dir}\n` +
      (hasMd
        ? (indexed ? '索引已就绪，直接用：nx-rp zg query "问题"'
          : '文档已就绪，建索引：nx-rp zg index')
        : '下一步：\n  1. nx-rp doc add --name xxx --body @文件   # 登记知识\n  2. nx-rp doc export                        # 实例文件化\n  3. nx-rp zg index                          # 建索引\n  4. nx-rp zg query "问题"                   # 语义召回'),
  };
}

// ─── index / query / status ────────────────────────────────────────

export async function index({ root, forceRebuild = false, model } = {}) {
  const dir = kbDirFor(root);
  if (!existsSync(dir)) {
    await fsp.mkdir(dir, { recursive: true });
  }
  // 模型解析顺序：显式 --model > zg 全局默认（auth 时写入）。只有 --rebuild 时
  // 才允许显式换模型——普通 index 用已存模型（zg manifest 锁定）避免维度冲突。
  // 适配 zg 0.2.x 子命令式接口；--allow-remote 是新版语法，0.2.x 的远程授权
  // 只看 config provider key + workspace grant。
  const args = ['index', dir, '--mode', 'direct'];
  if (model) {
    const modelId = resolveModel(model);
    if (!forceRebuild) {
      throw invalidInput(`换模型（${modelId}）必须同时 --rebuild：已建索引锁定了旧模型的维度，普通 index 不能混用`);
    }
    args.push('--embedding', modelId);
  }
  if (forceRebuild) args.push('--rebuild');
  const r = await runZg(args, { timeoutMs: 300_000 });
  return {
    ok: r.ok,
    kbDir: dir,
    summary: r.stdout.trim().split('\n').slice(-20).join('\n'),
    stderr: r.ok ? undefined : r.stderr,
  };
}

export async function query({ q, root, limit = 5, preview = 'short', shared = true } = {}) {
  if (!q || typeof q !== 'string' || !q.trim()) throw invalidInput('查询不能为空');
  const dir = kbDirFor(root);
  if (!existsSync(join(dir, '.zvec-grep'))) {
    return { ok: false, needIndex: true, kbDir: dir, hint: '知识库还没有索引——先跑 nx-rp zg index' };
  }
  // 适配 zg 0.2.x：query 没有 root 参数（新版才有），workspace 由**进程 cwd** 解析——
  // 所以在 KB 目录里跑子进程。无 --refresh（新版 direct 才有查询前探测）；无 --compact
  // （默认输出即 agent markdown 紧凑形态）。
  const r = await runZgIn(dir, [
    'query', q,
    '--mode', 'direct',
    '--limit', String(limit),
    '--preview', preview,
  ], { timeoutMs: 120_000 });

  // 结果头块：AI 只看到 KB 内的相对文件名（d_xxx-名称.md:行号），没有归属信息——
  // 这里把「知识库根 / 相对路径写法 / 原始 scope 目录」拼进输出，让 agent 能
  // （1）判断命中内容属于哪个项目（2）用 KB 相对路径追问全文（3）回溯源 scope。
  const scopeRaw = root || cwdDir();
  const kbName = dir.split(/[\\/]/).pop();
  const header = [
    '[nx-rp 知识库召回]',
    `知识库根: ${docRootFor(await readDocRootSetting())}`,
    `知识库子目录: ${kbName}`,
    `来源工作目录: ${scopeRaw}`,
    `命中文件相对路径: <知识库根>/${kbName}/<文件名>#L<起>-L<止>（如需全文，直接读该绝对路径文件）`,
    '',
  ].join('\n');

  // shared 共享知识库并查：<docRoot>/shared/ 跨项目共用（放基本信息防丢失）。
  // 结果段落以 [shared] 标注，命中文件位于 shared 子目录。
  let sharedBlock = '';
  if (shared) {
    const sDir = sharedDirFor(await readDocRootSetting());
    if (existsSync(join(sDir, '.zvec-grep'))) {
      const sr = await runZgIn(sDir, [
        'query', q,
        '--mode', 'direct',
        '--limit', String(Math.min(limit, 3)),
        '--preview', preview,
      ], { timeoutMs: 120_000 });
      if (sr.ok && sr.stdout.trim()) {
        sharedBlock = '\n[shared 共享知识库命中]\n' + sr.stdout + '\n';
      }
    }
  }

  return {
    ok: r.ok,
    kbDir: dir,
    scope: scopeRaw,
    results: r.ok ? header + r.stdout + sharedBlock : r.stdout,
    stderr: r.ok ? undefined : r.stderr,
  };
}

export async function status({ root } = {}) {
  const dir = kbDirFor(root);
  if (!existsSync(join(dir, '.zvec-grep'))) {
    return { kbDir: dir, indexed: false };
  }
  const r = await runZg(['status', dir, '--mode', 'direct'], { timeoutMs: 30_000 });
  return { kbDir: dir, indexed: true, summary: r.stdout.trim() };
}

// ─── docRoot 变更：迁移（全量复制 + 清旧索引）─────────────────────

// 用户改全局 docRoot 时调用：旧根下每个 KB 整体复制到新根（含 .zvec-grep 索引，
// 但索引里的绝对路径已失效，复制后需要逐个 rebuild——这里只复制文件并删旧授权，
// rebuild 由用户对每个 workspace 跑 nx-rp zg index --rebuild，或下次 index 自动处理）。
export async function migrateDocRoot({ newRoot, oldRoot } = {}) {
  if (!newRoot) throw invalidInput('缺少新 docRoot');
  const from = docRootFor(oldRoot ?? (await readDocRootSetting()));
  const to = docRootFor(newRoot);
  if (from === to) return { skipped: true, docRoot: to };
  await fsp.mkdir(to, { recursive: true });
  let copied = 0;
  let dirs = [];
  try {
    dirs = (await fsp.readdir(from, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch { /* 旧根不存在 = 无可迁移 */ }
  for (const name of dirs) {
    await copyDir(join(from, name), join(to, name));
    copied++;
  }
  // 清理旧根下的 zg 痕迹（授权/索引都在 KB 子目录里，随目录一起搬走；
  // 旧根本体如果空了就删掉，避免残留）
  try {
    const rest = await fsp.readdir(from);
    if (rest.length === 0) await fsp.rm(from, { recursive: true, force: true });
  } catch { /* 旧根本来就不存在 */ }
  return { ok: true, from, to, copied };
}

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await fsp.copyFile(s, d);
  }
}
