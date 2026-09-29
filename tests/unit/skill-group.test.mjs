// skill --group 机制单测：清单装载与降级、两种 --group 写法、冲突/未知报错、
// 多 skill 聚合、skill groups 子命令、get --group。
//
// 隔离纪律：
//   - 安装目标一律 `--to <tmp>`，**绝不碰真实 ~/.claude/skills**
//   - 资产根用 NX_RP_ASSETS_ROOT 指向 tmp 内的伪资产树——这是测「多 skill group /
//     清单缺失 / 清单损坏」这些分支的唯一手段（不能往仓库里写文件）
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..');
const builtinsUrl = pathToFileURL(join(ROOT, 'src', 'runtime', 'builtins.js')).href;

let tmp;
let assets;
let to;

async function loadSkill() {
  const mod = await import(builtinsUrl);
  return mod.BUILTINS.find((c) => c.id === 'skill');
}

// 造一个伪资产树：skills = { 'foo': {'SKILL.md': '...', 'references/x.md': '...'}, ... }
async function seedAssets(skills, groups) {
  await mkdir(assets, { recursive: true });
  for (const [name, files] of Object.entries(skills)) {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(assets, name, rel);
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, content, 'utf8');
    }
  }
  if (groups !== undefined) {
    await writeFile(join(assets, 'groups.json'),
      typeof groups === 'string' ? groups : JSON.stringify(groups), 'utf8');
  }
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'nxrp-group-'));
  assets = join(tmp, 'assets');
  to = join(tmp, 'out');
  process.env.NX_RP_ASSETS_ROOT = assets;
});

afterEach(async () => {
  delete process.env.NX_RP_ASSETS_ROOT;
  await rm(tmp, { recursive: true, force: true });
});

const SKILL_MD = (name) => `---\nname: ${name}\ndescription: test\n---\n\n# ${name}\n`;

// ============================================================
// A. 清单装载与降级
// ============================================================

test('A1 清单缺失 → 降级为目录扫描，install 仍工作', async () => {
  await seedAssets({ foo: { 'SKILL.md': SKILL_MD('foo') } }); // 不写 groups.json
  const skill = await loadSkill();
  const g = await skill.run(['groups']);
  assert.equal(g.length, 1);
  assert.equal(g[0].group, 'foo');
  assert.equal(g[0].source, 'assets-dirs', '降级状态必须显式暴露');
  // 无清单也能按名字装
  const r = await skill.run(['install', 'foo', '--to', to]);
  assert.equal(r.installed, true);
  // 也能按 group 装（目录扫描兜底）
  const r2 = await skill.run(['install', '--group', 'foo', '--to', to]);
  assert.equal(r2.status, 'ok');
});

test('A2 清单是坏 JSON → 降级不崩，仍能用', async () => {
  await seedAssets({ foo: { 'SKILL.md': SKILL_MD('foo') } }, '{ 这不是合法 JSON');
  const skill = await loadSkill();
  const g = await skill.run(['groups']);
  assert.equal(g[0].source, 'assets-dirs');
  const r = await skill.run(['install', 'foo', '--to', to]);
  assert.equal(r.installed, true);
});

test('A3 清单 schema 非法 → 抛 INVALID_INPUT（不静默降级）', async () => {
  await seedAssets({ foo: { 'SKILL.md': SKILL_MD('foo') } }, { version: 1, groups: { bad: ['foo'] } });
  const skill = await loadSkill();
  // groups.bad 是数组而非 {skills:[...]}
  await assert.rejects(() => skill.run(['groups']), (e) => {
    assert.equal(e.code, 'INVALID_INPUT');
    assert.match(e.message, /groups\.json/);
    return true;
  });
});

test('A3b 清单里 skills 为空数组 / 含非法名 → 抛错', async () => {
  await seedAssets({ foo: { 'SKILL.md': SKILL_MD('foo') } }, { version: 1, groups: { e: { skills: [] } } });
  const skill = await loadSkill();
  await assert.rejects(() => skill.run(['groups']), /非法/);

  await seedAssets({ foo: { 'SKILL.md': SKILL_MD('foo') } }, { version: 1, groups: { e: { skills: ['../escape'] } } });
  await assert.rejects(() => skill.run(['groups']), /非法 skill 名/);
});

test('A4 清单指向的资产不存在 → 安装时报「未找到」而非崩溃', async () => {
  await seedAssets({ foo: { 'SKILL.md': SKILL_MD('foo') } }, { version: 1, groups: { ghost: { skills: ['ghost'] } } });
  const skill = await loadSkill();
  // groups 能列出来（声明与资产齐备与否是两回事）
  const g = await skill.run(['groups']);
  assert.ok(g.some((x) => x.group === 'ghost'));
  // 但装的时候报错
  await assert.rejects(() => skill.run(['install', '--group', 'ghost', '--to', to]), /未找到内置 skill: ghost/);
});

// ============================================================
// B. --group 解析
// ============================================================

test('B1/B2 两种写法等价：--group=x 与 --group x', async () => {
  await seedAssets({ foo: { 'SKILL.md': SKILL_MD('foo') } }, { version: 1, groups: { foo: { skills: ['foo'], summary: 's' } } });
  const skill = await loadSkill();
  const a = await skill.run(['install', '--group=foo', '--to', to]);
  assert.equal(a.installed, true);
  assert.equal(a.group, 'foo');
  await rm(to, { recursive: true, force: true });
  const b = await skill.run(['install', '--group', 'foo', '--to', to]);
  assert.equal(b.installed, true);
  assert.equal(b.path, join(to, 'foo'));
});

test('B3 --group 缺值 / 空值 → 报错，绝不回落默认', async () => {
  await seedAssets({ 'nx-rp': { 'SKILL.md': SKILL_MD('nx-rp') } }, { version: 1, groups: { 'nx-rp': { skills: ['nx-rp'] } } });
  const skill = await loadSkill();
  await assert.rejects(() => skill.run(['install', '--group', '--to', to]), /--group 需要一个值/);
  await assert.rejects(() => skill.run(['install', '--group=']), /需要一个值/);
});

test('B4 --group 后面跟另一个 flag → 报错（不能把 --force 吞成 group 名）', async () => {
  await seedAssets({ foo: { 'SKILL.md': SKILL_MD('foo') } }, { version: 1, groups: { foo: { skills: ['foo'] } } });
  const skill = await loadSkill();
  await assert.rejects(() => skill.run(['install', '--group', '--force', '--to', to]), /--group 需要一个值/);
});

test('B5/B6 --group 与位置参数同时给 → 冲突报错（含 --force 在前的形态）', async () => {
  await seedAssets({ foo: { 'SKILL.md': SKILL_MD('foo') }, bar: { 'SKILL.md': SKILL_MD('bar') } },
    { version: 1, groups: { foo: { skills: ['foo'] } } });
  const skill = await loadSkill();
  await assert.rejects(() => skill.run(['install', 'foo', '--group=foo', '--to', to]), /二者等价/);
  // 名字与 group 不一致时也不能静默取其一
  await assert.rejects(() => skill.run(['install', 'bar', '--group=foo', '--to', to]), /二者等价/);
});

test('B7 未知 group → 报错含可用列表', async () => {
  await seedAssets({ foo: { 'SKILL.md': SKILL_MD('foo') } }, { version: 1, groups: { foo: { skills: ['foo'] } } });
  const skill = await loadSkill();
  await assert.rejects(() => skill.run(['install', '--group=bogus', '--to', to]), (e) => {
    assert.match(e.message, /未知 group: bogus/);
    assert.match(e.message, /可用: foo/);
    return true;
  });
});

test('B8 默认仍装 nx-rp（约束：不影响原命令）', async () => {
  await seedAssets({ 'nx-rp': { 'SKILL.md': SKILL_MD('nx-rp') }, foo: { 'SKILL.md': SKILL_MD('foo') } });
  const skill = await loadSkill();
  const r = await skill.run(['install', '--to', to]);
  assert.equal(r.path, join(to, 'nx-rp'));
  assert.equal(r.group, undefined, '无 --group 时不该多出 group 字段');
});

// ============================================================
// C. 多 skill 聚合
// ============================================================

test('C1 多 skill group → 逐个安装，返回 skills[]', async () => {
  await seedAssets({
    a: { 'SKILL.md': SKILL_MD('a') },
    b: { 'SKILL.md': SKILL_MD('b') },
  }, { version: 1, groups: { mix: { skills: ['a', 'b'], summary: '两个' } } });
  const skill = await loadSkill();
  const r = await skill.run(['install', '--group=mix', '--to', to]);
  assert.equal(r.status, 'ok');
  assert.equal(r.group, 'mix');
  assert.equal(r.skills.length, 2);
  assert.ok(r.skills.every((s) => s.installed));
  assert.ok(r.skills.every((s) => s.name));
});

test('C2 多 skill：部分冲突 → 聚合 status 取 conflict，且不阻塞其余', async () => {
  await seedAssets({
    a: { 'SKILL.md': SKILL_MD('a') },
    b: { 'SKILL.md': SKILL_MD('b') },
  }, { version: 1, groups: { mix: { skills: ['a', 'b'] } } });
  const skill = await loadSkill();
  await skill.run(['install', 'a', '--to', to]);
  await skill.run(['install', 'b', '--to', to]);
  // 篡改其中一个
  await writeFile(join(to, 'b', 'SKILL.md'), 'changed', 'utf8');
  const r = await skill.run(['install', '--group=mix', '--to', to]);
  assert.equal(r.status, 'conflict');
  // 关键：部分冲突不阻塞其余——没被篡改的那个照常判定为 skipped
  assert.equal(r.skills.find((s) => s.name === 'a').skipped, true);
  assert.equal(r.skills.find((s) => s.name === 'b').status, 'conflict');
  // --force 后全部 replaced/ok
  const r2 = await skill.run(['install', '--group=mix', '--to', to, '--force']);
  assert.equal(r2.status, 'ok');
  assert.ok(r2.skills.every((s) => s.status === 'ok'));
});

test('C3 多 skill 幂等：二次安装全 skipped', async () => {
  await seedAssets({ a: { 'SKILL.md': SKILL_MD('a') }, b: { 'SKILL.md': SKILL_MD('b') } },
    { version: 1, groups: { mix: { skills: ['a', 'b'] } } });
  const skill = await loadSkill();
  await skill.run(['install', '--group=mix', '--to', to]);
  const r = await skill.run(['install', '--group=mix', '--to', to]);
  assert.equal(r.skipped, true);
  assert.ok(r.skills.every((s) => s.skipped));
});

test('C4 清单里重复的 skill 名去重，只装一次', async () => {
  await seedAssets({ a: { 'SKILL.md': SKILL_MD('a') } },
    { version: 1, groups: { dup: { skills: ['a', 'a'] } } });
  const skill = await loadSkill();
  const r = await skill.run(['install', '--group=dup', '--to', to]);
  // 去重后只剩一个 → 走单 skill 退化形状
  assert.equal(r.skills, undefined, '去重后应退化为单 skill 形状');
  assert.equal(r.installed, true);
});

// ============================================================
// D. skill groups
// ============================================================

test('D1 groups 输出含两列信息 + source', async () => {
  await seedAssets({ a: { 'SKILL.md': SKILL_MD('a') }, b: { 'SKILL.md': SKILL_MD('b') } },
    { version: 1, groups: { a: { skills: ['a'], summary: '甲' }, b: { skills: ['b'], summary: '乙' } } });
  const skill = await loadSkill();
  const list = await skill.run(['groups']);
  assert.deepEqual(list.map((x) => x.group), ['a', 'b']);
  assert.equal(list[0].summary, '甲');
  const out = skill.render(list);
  assert.match(out, /a\s+甲/);
  assert.match(out, /b\s+乙/);
});

test('D2 groups 拒绝 --group（它就是用来列 group 的）', async () => {
  await seedAssets({ a: { 'SKILL.md': SKILL_MD('a') } });
  const skill = await loadSkill();
  await assert.rejects(() => skill.run(['groups', '--group=a']), /不接受 --group/);
});

// ============================================================
// E. get --group
// ============================================================

test('E1 get --group=x 等价 get x', async () => {
  await seedAssets({ a: { 'SKILL.md': SKILL_MD('a') } }, { version: 1, groups: { a: { skills: ['a'] } } });
  const skill = await loadSkill();
  const r = await skill.run(['get', '--group=a', '--to', to]);
  assert.equal(r.skillName, 'a');
  assert.equal(r.ref, 'SKILL.md');
  assert.equal(r.group, 'a');
  assert.equal(r.install.path, join(to, 'a'));
});

test('E2 get --group=x <ref>：位置参数左移（第一个位置参数是 ref）', async () => {
  await seedAssets({ a: { 'SKILL.md': SKILL_MD('a'), 'references/extra.md': '# extra\n' } },
    { version: 1, groups: { a: { skills: ['a'] } } });
  const skill = await loadSkill();
  const r = await skill.run(['get', '--group=a', 'extra', '--to', to]);
  assert.equal(r.ref, 'references/extra.md');
  // 位置参数过多 → 报错
  await assert.rejects(() => skill.run(['get', '--group=a', 'extra', 'more', '--to', to]), /位置参数过多/);
});

test('E3 get --group 指向多 skill 的 group → 要求显式指定', async () => {
  await seedAssets({ a: { 'SKILL.md': SKILL_MD('a') }, b: { 'SKILL.md': SKILL_MD('b') } },
    { version: 1, groups: { mix: { skills: ['a', 'b'] } } });
  const skill = await loadSkill();
  await assert.rejects(() => skill.run(['get', '--group=mix', '--to', to]), /含多个 skill/);
});

test('E4 get 不带 --group 时返回形状与今天一致（无 group 字段）', async () => {
  await seedAssets({ a: { 'SKILL.md': SKILL_MD('a') } }, { version: 1, groups: { a: { skills: ['a'] } } });
  const skill = await loadSkill();
  const r = await skill.run(['get', 'a', '--to', to]);
  assert.deepEqual(Object.keys(r).sort(), ['content', 'contentBytes', 'install', 'ref', 'skillName']);
});

// ============================================================
// F. 渲染
// ============================================================

test('F1 多 skill 的 render 每行含路径；单 skill 与今天逐字一致', async () => {
  await seedAssets({ a: { 'SKILL.md': SKILL_MD('a') }, b: { 'SKILL.md': SKILL_MD('b') } },
    { version: 1, groups: { mix: { skills: ['a', 'b'] }, a: { skills: ['a'] } } });
  const skill = await loadSkill();
  const multi = await skill.run(['install', '--group=mix', '--to', to]);
  const out = skill.render(multi);
  assert.match(out, /group mix（2 个 skill/);
  assert.match(out, /已安装: .*a/);
  assert.match(out, /已安装: .*b/);

  // 单 skill group → 退化形状 → render 与既有四分支逐字一致
  const single = await skill.run(['install', '--group=a', '--to', to]);
  assert.equal(skill.render(single), `已是最新: ${join(to, 'a')}（无差异）`);
});

test('F2 用法串覆盖全部子命令（防硬编码文案漂移）', async () => {
  await seedAssets({ a: { 'SKILL.md': SKILL_MD('a') } });
  const skill = await loadSkill();
  await assert.rejects(() => skill.run(['bogus']), (e) => {
    for (const sub of ['install', 'get', 'groups']) {
      assert.match(e.message, new RegExp(`skill ${sub}`), `用法串应提到 ${sub}`);
    }
    return true;
  });
});
