const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..', 'node_modules', '.pnpm');
const results = [];
const seen = new Set(); // name@version 去重

function recordPkg(pkgDir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8');
  } catch {
    return;
  }

  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return;
  }

  if (!pkg.name || !pkg.version) return;

  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) return; // 去重
  seen.add(key);

  results.push({
    name: pkg.name,
    version: pkg.version,
    node: (pkg.engines && pkg.engines.node) || null,
  });
}

function walkNodeModules(nodeModulesDir) {
  let entries;
  try {
    entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // 天然跳过 symlink
    if (entry.name === '.bin') continue;

    if (entry.name.startsWith('@')) {
      const scopeDir = path.join(nodeModulesDir, entry.name);
      let subs;
      try {
        subs = fs.readdirSync(scopeDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subs) {
        if (!sub.isDirectory()) continue;
        recordPkg(path.join(scopeDir, sub.name));
      }
    } else {
      recordPkg(path.join(nodeModulesDir, entry.name));
    }
  }
}

let pnpmEntries;
try {
  pnpmEntries = fs.readdirSync(root, { withFileTypes: true });
} catch (e) {
  console.error(`无法读取 ${root}: ${e.message}`);
  process.exit(1);
}

for (const entry of pnpmEntries) {
  if (!entry.isDirectory()) continue;
  walkNodeModules(path.join(root, entry.name, 'node_modules'));
}

// ---- 排序 ----
results.sort((a, b) =>
  a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)
);

// ---- 总结 ----
const total = results.length;
const withEngines = results.filter((r) => r.node);
const withoutEngines = total - withEngines.length;

// 按包名聚合，找出多版本包
const byName = new Map();
for (const r of results) {
  if (!byName.has(r.name)) byName.set(r.name, new Set());
  byName.get(r.name).add(r.version);
}
const multiVersion = [...byName.entries()]
  .filter(([, versions]) => versions.size > 1)
  .map(([name, versions]) => ({ name, versions: [...versions].sort() }))
  .sort((a, b) => a.name.localeCompare(b.name));

// 按 engines.node 约束分组统计
const byConstraint = new Map();
for (const r of withEngines) {
  if (!byConstraint.has(r.node)) byConstraint.set(r.node, []);
  byConstraint.get(r.node).push(`${r.name}@${r.version}`);
}
const constraintStats = [...byConstraint.entries()]
  .map(([node, pkgs]) => ({ node, count: pkgs.length, packages: pkgs.sort() }))
  .sort((a, b) => b.count - a.count || a.node.localeCompare(b.node));

const summary = {
  scannedAt: new Date().toISOString(),
  root,
  totalPackages: total,
  withNodeEngine: withEngines.length,
  withoutNodeEngine: withoutEngines,
  uniquePackageNames: byName.size,
  multiVersionCount: multiVersion.length,
  constraintGroupCount: constraintStats.length,
};

// ---- 输出 ----
console.log('===== Summary =====');
console.log(JSON.stringify(summary, null, 2));

console.log('\n===== Multi-version Packages =====');
if (multiVersion.length === 0) {
  console.log('(none)');
} else {
  for (const { name, versions } of multiVersion) {
    console.log(`${name}: ${versions.join(', ')}`);
  }
}

console.log('\n===== Node Engine Constraints =====');
for (const { node, count, packages } of constraintStats) {
  console.log(`\n[${node}]  x${count}`);
  for (const p of packages) console.log(`  - ${p}`);
}

console.log('\n===== Packages (with engines.node) =====');
console.log(JSON.stringify(withEngines, null, 2));

// 如需包含全部（含未声明 engines.node 的），取消下面注释：
// console.log('\n===== All Packages =====');
// console.log(JSON.stringify(results, null, 2));

// 如需以 JSON 形式一次性输出总结，取消下面注释：
// console.log(JSON.stringify({ summary, multiVersion, constraintStats, packages: withEngines }, null, 2));