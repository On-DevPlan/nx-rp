// skill 子命令单测：install 三态、get 三段拼接、ref 解析、路径穿越防护、--json 形状。
// 路径隔离：每个用例传 `--to <tmp>`，绝不碰真实的 ~/.claude/skills。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..');

const builtinsUrl = pathToFileURL(join(ROOT, 'src', 'runtime', 'builtins.js')).href;

let tmp;
let toArg;

async function loadSkill() {
  // 每个用例 import 一次，确保模块状态干净；hook-skill.test.mjs 用的同款
  const mod = await import(builtinsUrl);
  return mod.BUILTINS.find((c) => c.id === 'skill');
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'nxrp-skill-'));
  toArg = ['--to', tmp];
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// ============================================================
// A. runInstall（共用 helper）—— 通过 `skill install` 子命令走完整路径
// ============================================================

test('A1 install 默认名 → 复制 assets/nx-rp 到 <tmp>/nx-rp', async () => {
  const skill = await loadSkill();
  const r = await skill.run(['install', '--to', tmp]);
  assert.equal(r.status, 'ok');
  assert.equal(r.installed, true);
  assert.equal(r.path, join(tmp, 'nx-rp'));
  assert.ok(r.files > 0, '至少 SKILL.md + references/*.md');
});

test('A2 install 显式名 → 同上', async () => {
  const skill = await loadSkill();
  const r = await skill.run(['install', 'nx-rp', '--to', tmp]);
  assert.equal(r.installed, true);
  assert.equal(r.path, join(tmp, 'nx-rp'));
});

test('A3 install 已存在且一致 → skipped', async () => {
  const skill = await loadSkill();
  await skill.run(['install', '--to', tmp]); // 第一次：装
  const r = await skill.run(['install', '--to', tmp]); // 第二次：一致
  assert.equal(r.status, 'ok');
  assert.equal(r.skipped, true);
  assert.equal(r.files, 0);
});

test('A4 install 存在但内容不同（不带 --force）→ conflict', async () => {
  const skill = await loadSkill();
  await skill.run(['install', '--to', tmp]);
  // 篡改目标
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(tmp, 'nx-rp', 'SKILL.md'), '# tampered\n', 'utf8');
  const r = await skill.run(['install', '--to', tmp]);
  assert.equal(r.status, 'conflict');
  assert.ok(r.files.includes('SKILL.md'));
  assert.equal(r.count, r.files.length);
});

test('A5 install --force → replaced', async () => {
  const skill = await loadSkill();
  await skill.run(['install', '--to', tmp]);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(tmp, 'nx-rp', 'SKILL.md'), '# tampered\n', 'utf8');
  const r = await skill.run(['install', '--to', tmp, '--force']);
  assert.equal(r.status, 'ok');
  assert.equal(r.replaced, true);
});

test('A6 install 未知 skill 名 → 抛错，列出可用', async () => {
  const skill = await loadSkill();
  await assert.rejects(
    () => skill.run(['install', 'bogus-skill', '--to', tmp]),
    (err) => {
      assert.equal(err.code, 'INVALID_INPUT');
      assert.match(err.message, /未找到内置 skill: bogus-skill/);
      assert.match(err.message, /可用:.*nx-rp/);
      return true;
    },
  );
});

// ============================================================
// B. runGet / resolveRefDoc
// ============================================================

test('B1 get 缺省名 → ref="SKILL.md", content 含 frontmatter', async () => {
  const skill = await loadSkill();
  const r = await skill.run(['get', ...toArg]);
  assert.equal(r.skillName, 'nx-rp');
  assert.equal(r.ref, 'SKILL.md');
  assert.match(r.content, /^---\nname: nx-rp/);
  assert.ok(r.contentBytes > 0);
  assert.equal(r.install.installed || r.install.skipped, true);
});

test('B2 get 显式名 → 同 B1', async () => {
  const skill = await loadSkill();
  const r = await skill.run(['get', 'nx-rp', ...toArg]);
  assert.equal(r.ref, 'SKILL.md');
});

test('B3 get references/annotations.md → ref="references/annotations.md"', async () => {
  const skill = await loadSkill();
  const r = await skill.run(['get', 'nx-rp', 'references/annotations.md', ...toArg]);
  assert.equal(r.ref, 'references/annotations.md');
  assert.match(r.content, /annotations · 文件批注/);
});

test('B4 get 裸名 annotations → 命中 references/annotations.md', async () => {
  const skill = await loadSkill();
  const r = await skill.run(['get', 'nx-rp', 'annotations', ...toArg]);
  assert.equal(r.ref, 'references/annotations.md');
});

test('B5 get ./SKILL.md → 等价缺省（label 是 "./SKILL.md"，因为 ref 参数原样保留）', async () => {
  const skill = await loadSkill();
  const r = await skill.run(['get', 'nx-rp', './SKILL.md', ...toArg]);
  assert.equal(r.ref, './SKILL.md');
  assert.match(r.content, /^---\nname: nx-rp/);
});

test('B6 get ../foo.md → 抛 "不允许包含 .."', async () => {
  const skill = await loadSkill();
  await assert.rejects(
    () => skill.run(['get', 'nx-rp', '../foo.md', ...toArg]),
    (err) => {
      assert.equal(err.code, 'INVALID_INPUT');
      assert.match(err.message, /不允许包含 '\.\.'/);
      return true;
    },
  );
});

test('B7 get 绝对路径 /etc/passwd → 抛 "ref 越界"', async () => {
  const skill = await loadSkill();
  // Windows 上用 D:\\foo 这种驱动器绝对路径也走同一断言
  const abs = process.platform === 'win32' ? 'D:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/passwd';
  await assert.rejects(
    () => skill.run(['get', 'nx-rp', abs, ...toArg]),
    (err) => {
      assert.equal(err.code, 'INVALID_INPUT');
      assert.match(err.message, /ref 越界/);
      return true;
    },
  );
});

test('B8 get 未知 ref → 抛错，列出可用的 references/*.md（裸名形式）', async () => {
  const skill = await loadSkill();
  await assert.rejects(
    () => skill.run(['get', 'nx-rp', 'nope', ...toArg]),
    (err) => {
      assert.equal(err.code, 'INVALID_INPUT');
      assert.match(err.message, /未找到 ref: nope/);
      assert.match(err.message, /可用:.*annotations.*deps-graph.*prompt-log.*zg-recall/);
      // 不能带 .md 扩展名（用户输入的是裸名，列表对齐）
      assert.doesNotMatch(err.message, /annotations\.md/);
      return true;
    },
  );
});

test('B9 get 裸名带扩展 → 抛未找到（设计取舍：裸名仅查 references/<name>.md）', async () => {
  // 用户的裸名语义是 "references/<x>.md" 简写；带 .md 的应直接走 path 分支（参见 B3）
  // 这里确认裸名不会错误命中根下 SKILL.md（避免歧义）
  const skill = await loadSkill();
  await assert.rejects(
    () => skill.run(['get', 'nx-rp', 'SKILL.md', ...toArg]),
    (err) => {
      assert.equal(err.code, 'INVALID_INPUT');
      assert.match(err.message, /未找到 ref: SKILL.md/);
      return true;
    },
  );
});

test('B10 get 时 dst 已有不同内容 → content 仍打印 + install conflict', async () => {
  const skill = await loadSkill();
  await skill.run(['install', '--to', tmp]); // 先装一份
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(tmp, 'nx-rp', 'SKILL.md'), '# tampered\n', 'utf8');
  const r = await skill.run(['get', '--to', tmp]);
  // content 不受 install 状态影响（永远给文档）
  assert.match(r.content, /^---\nname: nx-rp/);
  // install 状态如实返回 conflict
  assert.equal(r.install.status, 'conflict');
  assert.ok(r.install.files.includes('SKILL.md'));
});

test('B11 get --to <tmp> 自定义目标生效', async () => {
  const skill = await loadSkill();
  const r = await skill.run(['get', '--to', tmp]);
  assert.equal(r.install.path, join(tmp, 'nx-rp'));
});

// ============================================================
// C. 顺序、prefix、--force
// ============================================================

test('C1 get 默认渲染顺序：prefix → doc → install summary', async () => {
  const skill = await loadSkill();
  const r = await skill.run(['get', ...toArg]);
  const out = skill.render(r);
  const prefixIdx = out.indexOf('# === nx-rp skill context ===');
  const sentinelIdx = out.indexOf('# --- begin skill content');
  const docIdx = out.indexOf('---\nname: nx-rp');
  const installHeaderIdx = out.indexOf('-- install 状态 --');
  const installLineIdx = out.indexOf('已安装:') === -1 ? out.indexOf('已是最新:') : out.indexOf('已安装:');
  assert.ok(prefixIdx >= 0 && prefixIdx < sentinelIdx, 'prefix header 在 sentinel 前');
  assert.ok(sentinelIdx < docIdx, 'sentinel 在 doc 前');
  assert.ok(docIdx < installHeaderIdx, 'doc 在 install header 前');
  assert.ok(installHeaderIdx < installLineIdx, 'install header 在 install line 前');
});

test('C2 prefix 含 sentinel "do not modify this line"——agent 截取边界', async () => {
  const skill = await loadSkill();
  const r = await skill.run(['get', ...toArg]);
  const out = skill.render(r);
  assert.match(out, /# --- begin skill content \(do not modify this line\) ---/);
});

test('C3 get --force 被静默忽略，不抛错', async () => {
  const skill = await loadSkill();
  const r = await skill.run(['get', '--to', tmp, '--force']);
  assert.equal(r.skillName, 'nx-rp');
  assert.equal(r.install.installed || r.install.skipped, true);
});

// ============================================================
// D. 渲染 + --json
// ============================================================

test('D1 默认渲染含 prefix / doc / install summary 三段', async () => {
  const skill = await loadSkill();
  const r = await skill.run(['get', ...toArg]);
  const out = skill.render(r);
  assert.match(out, /nx-rp skill context/);
  assert.match(out, /begin skill content/);
  assert.match(out, /install 状态/);
});

test('D2 install 子命令（不带 get 包装）的 render 行为不变', async () => {
  // 防止改 render 时把 install 三态输出弄丢
  const skill = await loadSkill();
  const r1 = await skill.run(['install', ...toArg]);
  const out1 = skill.render(r1);
  assert.match(out1, /已安装:.*\d+ 文件/);

  const r2 = await skill.run(['install', ...toArg]);
  const out2 = skill.render(r2);
  assert.match(out2, /已是最新:.*无差异/);
});

// ============================================================
// E. CLI 派发
// ============================================================

test('E1 unknown subcommand → INVALID_INPUT 错误信息列两个子命令', async () => {
  const skill = await loadSkill();
  await assert.rejects(
    () => skill.run(['bogus']),
    (err) => {
      assert.equal(err.code, 'INVALID_INPUT');
      assert.match(err.message, /nx-rp skill install/);
      assert.match(err.message, /nx-rp skill get/);
      return true;
    },
  );
});
