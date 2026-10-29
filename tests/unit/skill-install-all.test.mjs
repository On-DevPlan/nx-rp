// skill install --all：装 assets/ 下**全部**可分发的 skill。
//
// 与 --group 的差别只有来源：--group 读清单（groups.json 写了哪几个就装哪几个），
// --all 读目录（含 SKILL.md 的都算）——所以「清单漏写一个新 skill」时 --all 仍能装上。
// 语义与 --group 一致（本仓库的既有取舍）：逐个装、按最重态聚合，
// 部分冲突不阻塞其余，冲突项不写盘。
//
// 隔离纪律同 skill-group.test.mjs：安装目标一律 --to <tmp>，资产根用
// NX_RP_ASSETS_ROOT 指向 tmp 内的伪资产树，绝不碰真实 ~/.claude/skills。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..');
const builtinsUrl = pathToFileURL(join(ROOT, 'src', 'runtime', 'builtins.js')).href;

let tmp;
let assets;
let to;

const loadSkill = async () => (await import(builtinsUrl)).BUILTINS.find((c) => c.id === 'skill');

async function seedAssets(skills, groups) {
  await mkdir(assets, { recursive: true });
  for (const [name, files] of Object.entries(skills)) {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(assets, name, rel);
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, content, 'utf8');
    }
  }
  if (groups !== undefined) await writeFile(join(assets, 'groups.json'), JSON.stringify(groups), 'utf8');
}

const SKILL_MD = (name) => `---\nname: ${name}\ndescription: test\n---\n\n# ${name}\n`;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'nxrp-all-'));
  assets = join(tmp, 'assets');
  to = join(tmp, 'out');
  process.env.NX_RP_ASSETS_ROOT = assets;
});

afterEach(async () => {
  delete process.env.NX_RP_ASSETS_ROOT;
  await rm(tmp, { recursive: true, force: true });
});

test('A1 --all 装齐目录下全部 skill，包括清单里没写的那个', async () => {
  await seedAssets(
    {
      a: { 'SKILL.md': SKILL_MD('a') },
      b: { 'SKILL.md': SKILL_MD('b'), 'references/x.md': '# x\n' },
      orphan: { 'SKILL.md': SKILL_MD('orphan') }, // 刻意不写进 groups.json
      notaskill: { 'README.md': 'no skill here\n' }, // 没有 SKILL.md → 不算
    },
    { version: 1, groups: { a: { skills: ['a'] } } },
  );
  const skill = await loadSkill();
  const r = await skill.run(['install', '--all', '--to', to]);

  assert.equal(r.status, 'ok');
  assert.equal(r.all, true, '多 skill 时必须带显式 all 字段');
  assert.deepEqual(r.skills.map((s) => s.name).sort(), ['a', 'b', 'orphan']);
  assert.ok(r.skills.every((s) => s.installed));
  assert.deepEqual((await readdir(to)).sort(), ['a', 'b', 'orphan'], '三个都真的落盘了');
});

test('A2 --all 幂等：二次安装全 skipped，聚合 skipped=true', async () => {
  await seedAssets({ a: { 'SKILL.md': SKILL_MD('a') }, b: { 'SKILL.md': SKILL_MD('b') } });
  const skill = await loadSkill();
  await skill.run(['install', '--all', '--to', to]);
  const r = await skill.run(['install', '--all', '--to', to]);
  assert.equal(r.status, 'ok');
  assert.equal(r.skipped, true);
  assert.ok(r.skills.every((s) => s.skipped));
});

test('A3 --all：部分冲突 → 聚合 conflict，冲突项不写盘、其余照常判定', async () => {
  await seedAssets({ a: { 'SKILL.md': SKILL_MD('a') }, b: { 'SKILL.md': SKILL_MD('b') } });
  const skill = await loadSkill();
  await skill.run(['install', '--all', '--to', to]);
  await writeFile(join(to, 'b', 'SKILL.md'), 'tampered', 'utf8');

  const r = await skill.run(['install', '--all', '--to', to]);
  assert.equal(r.status, 'conflict');
  assert.equal(r.skills.find((s) => s.name === 'a').skipped, true);
  assert.equal(r.skills.find((s) => s.name === 'b').status, 'conflict');
  assert.equal(
    (await import('node:fs')).readFileSync(join(to, 'b', 'SKILL.md'), 'utf8'),
    'tampered',
    '冲突项不许被静默覆盖',
  );

  const forced = await skill.run(['install', '--all', '--to', to, '--force']);
  assert.equal(forced.status, 'ok');
  assert.ok(forced.skills.every((s) => s.status === 'ok'));
});

test('A4 --all：只有一个 skill 时退化为单 skill 形状，但仍标 all', async () => {
  await seedAssets({ only: { 'SKILL.md': SKILL_MD('only') } });
  const skill = await loadSkill();
  const r = await skill.run(['install', '--all', '--to', to]);
  assert.equal(r.skills, undefined, '单个应退化，不返回 skills 数组');
  assert.equal(r.all, true);
  assert.equal(r.installed, true);
});

test('A5 --all 与位置参数 / --group 互斥', async () => {
  await seedAssets({ a: { 'SKILL.md': SKILL_MD('a') } }, { version: 1, groups: { a: { skills: ['a'] } } });
  const skill = await loadSkill();
  await assert.rejects(() => skill.run(['install', 'a', '--all', '--to', to]), /互斥/);
  await assert.rejects(() => skill.run(['install', '--group=a', '--all', '--to', to]), /互斥/);
});

test('A6 skill get --all → 明确报错（get 一次只出一份文档）', async () => {
  await seedAssets({ a: { 'SKILL.md': SKILL_MD('a') } });
  const skill = await loadSkill();
  await assert.rejects(() => skill.run(['get', '--all', '--to', to]), /不支持 --all/);
});

test('A7 --all 的 render 用「全部 skill」而不是 group 名', async () => {
  await seedAssets({ a: { 'SKILL.md': SKILL_MD('a') }, b: { 'SKILL.md': SKILL_MD('b') } });
  const skill = await loadSkill();
  const r = await skill.run(['install', '--all', '--to', to]);
  const out = skill.render(r);
  assert.match(out, /^全部 skill（2 个 skill/);
  assert.match(out, /已安装: .*a/);
  assert.match(out, /已安装: .*b/);
});
