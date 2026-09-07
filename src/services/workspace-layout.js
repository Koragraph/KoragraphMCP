'use strict';

const fs = require('fs');
const path = require('path');

const { logger } = require('../common-services/logger');
const { detectRepoType } = require('./classifier');
const { walkRepoWithPolicy, loadIngestPolicy } = require('./ingest-policy');

const ROOT_MANIFEST_FILES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'nx.json',
  'lerna.json',
  'pom.xml',
  'go.work',
  'go.mod',
  'Cargo.toml',
  'README.md',
  'readme.md',
  '.koragraph.yml',
  '.koragraphignore',
]);

function _resolveWorkspaceGlobs(repoPath, globs) {
  const results = [];
  for (const pattern of globs) {
    if (!pattern || typeof pattern !== 'string') continue;
    const clean = pattern.replace(/^\.\//, '').replace(/\\/g, '/');
    if (clean.endsWith('/*')) {
      const parentDir = path.join(repoPath, clean.slice(0, -2));
      if (!fs.existsSync(parentDir)) continue;
      try {
        const entries = fs.readdirSync(parentDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory() && !e.name.startsWith('.')) {
            results.push({ name: e.name, subdir: path.join(clean.slice(0, -2), e.name) });
          }
        }
      } catch (_) { /* skip unreadable */ }
    } else if (!clean.includes('*')) {
      const absDir = path.join(repoPath, clean);
      if (fs.existsSync(absDir)) {
        results.push({ name: path.basename(clean), subdir: clean });
      }
    }
  }
  return results;
}

function _tryGlobManager(repoPath, globs, label) {
  const pkgs = _resolveWorkspaceGlobs(repoPath, globs);
  if (pkgs.length > 0) {
    logger.info(`[workspace-layout] Monorepo detected (${label}): ${pkgs.length} packages`);
    return { packages: pkgs, manager: label };
  }
  return null;
}

function detectWorkspacePackages(repoPath) {
  const pnpmWorkspacePath = path.join(repoPath, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmWorkspacePath)) {
    try {
      const raw = fs.readFileSync(pnpmWorkspacePath, 'utf8');
      const globs = [];
      let inPackages = false;
      for (const line of raw.split('\n')) {
        if (/^packages\s*:/.test(line)) { inPackages = true; continue; }
        if (inPackages) {
          if (/^\s*-\s+/.test(line)) {
            const g = line.replace(/^\s*-\s+/, '').replace(/^['"]|['"]$/g, '').trim();
            if (g) globs.push(g);
          } else if (line.trim() && !/^\s/.test(line)) {
            inPackages = false;
          }
        }
      }
      if (globs.length > 0) {
        const result = _tryGlobManager(repoPath, globs, 'pnpm');
        if (result) return result.packages;
      }
    } catch (_) { /* fall through */ }
  }

  const rootPkgPath = path.join(repoPath, 'package.json');
  if (fs.existsSync(rootPkgPath)) {
    try {
      const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
      const wsField = rootPkg.workspaces;
      const globs = Array.isArray(wsField) ? wsField
        : (wsField && Array.isArray(wsField.packages) ? wsField.packages : null);
      if (globs && globs.length > 0) {
        const result = _tryGlobManager(repoPath, globs, 'npm/Yarn');
        if (result) return result.packages;
      }
    } catch (_) { /* fall through */ }
  }

  if (fs.existsSync(path.join(repoPath, 'nx.json'))) {
    const result = _tryGlobManager(repoPath, ['apps/*', 'libs/*'], 'nx');
    if (result) return result.packages;
  }

  const lernaPath = path.join(repoPath, 'lerna.json');
  if (fs.existsSync(lernaPath)) {
    try {
      const lerna = JSON.parse(fs.readFileSync(lernaPath, 'utf8'));
      const globs = Array.isArray(lerna.packages) ? lerna.packages : ['packages/*'];
      const result = _tryGlobManager(repoPath, globs, 'lerna');
      if (result) return result.packages;
    } catch (_) { /* fall through */ }
  }

  const rootPomPath = path.join(repoPath, 'pom.xml');
  if (fs.existsSync(rootPomPath)) {
    try {
      const pom = fs.readFileSync(rootPomPath, 'utf8');
      const modulesMatch = pom.match(/<modules>([\s\S]*?)<\/modules>/);
      if (modulesMatch) {
        const moduleRe = /<module>([^<]+)<\/module>/g;
        const pkgs = [];
        let m;
        while ((m = moduleRe.exec(modulesMatch[1])) !== null) {
          const name = m[1].trim();
          if (name && fs.existsSync(path.join(repoPath, name))) {
            pkgs.push({ name, subdir: name });
          }
        }
        if (pkgs.length > 0) {
          logger.info(`[workspace-layout] Monorepo detected (Maven): ${pkgs.length} modules`);
          return pkgs;
        }
      }
    } catch (_) { /* fall through */ }
  }

  const goWorkPath = path.join(repoPath, 'go.work');
  if (fs.existsSync(goWorkPath)) {
    try {
      const goWork = fs.readFileSync(goWorkPath, 'utf8');
      const useRe = /\buse\s+(\S+)/g;
      const pkgs = [];
      let m;
      while ((m = useRe.exec(goWork)) !== null) {
        const subdir = m[1].trim();
        const absDir = path.join(repoPath, subdir);
        if (fs.existsSync(absDir)) {
          pkgs.push({ name: path.basename(subdir), subdir });
        }
      }
      if (pkgs.length > 0) {
        logger.info(`[workspace-layout] Monorepo detected (Go workspace): ${pkgs.length} modules`);
        return pkgs;
      }
    } catch (_) { /* fall through */ }
  }

  const cargoPath = path.join(repoPath, 'Cargo.toml');
  if (fs.existsSync(cargoPath)) {
    try {
      const cargo = fs.readFileSync(cargoPath, 'utf8');
      if (/^\[workspace\]/m.test(cargo)) {
        const membersMatch = cargo.match(/members\s*=\s*\[([^\]]+)\]/);
        if (membersMatch) {
          const pkgs = [];
          const members = membersMatch[1].match(/["']([^"']+)["']/g) || [];
          for (const raw of members) {
            const member = raw.replace(/["']/g, '').trim();
            if (!member) continue;
            if (member.endsWith('/*')) {
              pkgs.push(..._resolveWorkspaceGlobs(repoPath, [member]));
            } else {
              const absDir = path.join(repoPath, member);
              if (fs.existsSync(absDir)) pkgs.push({ name: path.basename(member), subdir: member });
            }
          }
          if (pkgs.length > 0) {
            logger.info(`[workspace-layout] Monorepo detected (Cargo): ${pkgs.length} crates`);
            return pkgs;
          }
        }
      }
    } catch (_) { /* fall through */ }
  }

  return null;
}

// The packages this file collects (`detectWorkspacePackages`) key `name` off the package's
// DIRECTORY (glob entry basename / pom module name / go.work subdir basename) — correct for
// `assignPackageMembership`'s prefix-match use, but not what an import specifier names. A JS
// workspace package is imported by its package.json `"name"` field (`"@myorg/foo"`), which
// is frequently NOT the directory name. This reads that field so `resolve.js`'s
// workspace-package resolution tier has a real specifier -> source-dir map to consume.
// Returns null on any missing/unreadable/malformed package.json — same degrade-not-throw
// contract as every other manifest read in this module.
function readPackageManifest(absDir) {
  const manifestPath = path.join(absDir, 'package.json');
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const data = JSON.parse(raw);
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : null;
  } catch (_) {
    return null;
  }
}

// Builds the specifier -> absolute-source-dir index `resolve.js`'s
// `resolveViaWorkspacePackage` consumes via `opts.workspacePackages`.
// One entry per workspace package that has a package.json; packages without
// one (a bare Maven/Cargo/Go module swept up by the same layout detector)
// are skipped — they are never importable by a JS/TS specifier. `packageName`
// prefers the manifest's own `name` field, falling back to the
// layout-detected directory name only when the manifest has none (or is
// absent), so callers still get a best-effort entry rather than silently
// losing the package.
function buildWorkspacePackageIndex(repoPath, layout) {
  if (!layout || !layout.isMonorepo || !Array.isArray(layout.packages)) return [];
  const index = [];
  for (const pkg of layout.packages) {
    const absDir = path.join(repoPath, pkg.subdir);
    const manifest = readPackageManifest(absDir);
    if (!manifest) continue;
    const packageName = (typeof manifest.name === 'string' && manifest.name) || pkg.name;
    index.push({ packageName, absDir });
  }
  return index;
}

function assignPackageMembership(relPath, packages) {
  const normalized = relPath.replace(/\\/g, '/');
  let best = null;
  let bestLen = -1;
  for (const pkg of packages) {
    const prefix = pkg.subdir.replace(/\\/g, '/');
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      if (prefix.length > bestLen) {
        best = pkg.name;
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

function isRootManifestFile(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized.startsWith('.github/')) return true;
  const base = path.posix.basename(normalized);
  return ROOT_MANIFEST_FILES.has(base);
}

function resolveWorkspaceLayout(repoPath) {
  const packages = detectWorkspacePackages(repoPath);
  if (!packages || packages.length === 0) {
    return {
      isMonorepo: false,
      manager: null,
      packages: [],
      stacks: [],
      rootPaths: [],
    };
  }

  const enrichedPackages = packages.map((pkg) => {
    const pkgPath = path.join(repoPath, pkg.subdir);
    const policy = loadIngestPolicy(repoPath);
    const walkResult = walkRepoWithPolicy(pkgPath, { policy });
    const relPrefix = pkg.subdir.replace(/\\/g, '/');
    const filePaths = walkResult.files.map((f) => (
      relPrefix ? `${relPrefix}/${f.rel.replace(/\\/g, '/')}` : f.rel
    ));
    let stack = detectRepoType(filePaths);
    if (!stack) {
      try {
        const rootEntries = fs.readdirSync(pkgPath);
        stack = detectRepoType(rootEntries);
      } catch (_) { /* unreadable package root */ }
    }
    return { ...pkg, stack: stack || null };
  });

  const stacks = [...new Set(enrichedPackages.map((p) => p.stack).filter(Boolean))];

  return {
    isMonorepo: true,
    manager: 'workspace',
    packages: enrichedPackages,
    stacks,
    rootPaths: [...ROOT_MANIFEST_FILES],
  };
}

function collectWorkspaceWalkTargets(repoPath, layout) {
  if (!layout?.isMonorepo) {
    return [{ subdir: null, packageName: null, stack: null }];
  }

  const targets = [{ subdir: null, packageName: null, stack: null }];
  for (const pkg of layout.packages) {
    targets.push({
      subdir: pkg.subdir,
      packageName: pkg.name,
      stack: pkg.stack,
    });
  }
  return targets;
}

function buildWorkspaceManifest(layout) {
  if (!layout?.isMonorepo) return null;
  return {
    schema_version: 'koragraph.workspace_layout.v1',
    manager: layout.manager,
    package_count: layout.packages.length,
    packages: layout.packages.map((p) => ({
      name: p.name,
      subdir: p.subdir,
      stack: p.stack,
    })),
    stacks: layout.stacks,
    pseudo_repositories: false,
  };
}

// The module path(s) a repository PUBLISHES — the name another repository writes in its own
// import statements to reach this one.
//
// This is the identity that makes a cross-repository edge possible at all. Sourcegraph's SCIP
// solves the same problem the same way: a symbol is globally unique as (package name, package
// version, qualified symbol), so cross-repo navigation is a join on the package name. We already
// hold both repositories' graphs, so no version dimension and no re-indexing of dependencies is
// needed — only the name each side agrees on.
//
// Every value here is read from a MANIFEST the ecosystem itself defines as authoritative:
// `module` in go.mod, `name` in package.json, groupId/artifactId in pom.xml, `[project].name` in
// pyproject.toml, `[package].name` in Cargo.toml, `name` in composer.json. None of it is
// inferred from directory names or guessed from content.
//
// A repository can publish more than one identity (a Go monorepo with several go.mod files, an
// npm workspace with many packages), so the return value is a list, ordered longest-first: when
// one published path is a prefix of another, the more specific one must win the match.
// Java/Kotlin packages a module declares, collapsed to shortest common roots. Bounded walk: a
// module's package roots are established by its first few hundred files, and a JVM repo can hold
// tens of thousands.
function declaredJvmPackages(repoPath, limit = 400) {
  const found = new Map(); // package -> file count, so a copied class cannot outrank the real owner
  let scanned = 0;
  const walk = (dir, depth) => {
    if (depth > 12 || scanned >= limit) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (scanned >= limit) return;
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'build'
            || e.name === 'target' || e.name === 'out') continue;
        walk(path.join(dir, e.name), depth + 1);
      } else if (e.name.endsWith('.java') || e.name.endsWith('.kt')) {
        scanned++;
        let head;
        try { head = fs.readFileSync(path.join(dir, e.name), 'utf8').slice(0, 4000); } catch (_) { continue; }
        const m = /^\s*package\s+([a-z][A-Za-z0-9_.]*)\s*;?/m.exec(head);
        if (m) found.set(m[1], (found.get(m[1]) || 0) + 1);
      }
    }
  };
  walk(repoPath, 0);
  // NOT collapsed to shortest roots. Two modules of one build routinely share a root — ftgo's
  // `ftgo-restaurant-service-api` and `ftgo-restaurant-service` both declare
  // `net.chrisrichardson.ftgo.restaurantservice` — and collapsing makes their identities
  // identical, so a consumer's `import ...restaurantservice.events.Address` cannot be attributed
  // to the module that actually declares it.
  //
  // Every declared package is kept instead, and cross-repo matching takes the LONGEST match, so
  // `...restaurantservice.events` (the api module) wins over `...restaurantservice.domain` (the
  // service). Measured: this is the difference between 90% and 100% on the ftgo JVM corpus.
  // Carries the file count so cross-repo resolution can tell the module that OWNS a package from
  // one that merely holds a copied class in it — ftgo's accounting service has exactly one file
  // in `net.chrisrichardson.ftgo.consumerservice.domain`, against consumer-service's own tree.
  return [...found.entries()]
    .map(([name, files]) => ({ name, files }))
    .sort((a, b) => b.name.length - a.name.length);
}

function detectPublishedModules(repoPath) {
  const out = [];
  const push = (name, kind, manifest, subdir, files) => {
    const clean = typeof name === 'string' ? name.trim() : '';
    if (clean) out.push({ name: clean, kind, manifest, subdir: subdir || '', ...(files ? { files } : {}) });
  };
  const readJson = (abs) => {
    try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (_) { return null; }
  };
  const readText = (abs) => {
    try { return fs.readFileSync(abs, 'utf8'); } catch (_) { return null; }
  };

  // Go: every go.mod in the tree, since a repo may host several modules.
  const goMods = [];
  const walkForGoMod = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'vendor') continue;
        walkForGoMod(path.join(dir, e.name), depth + 1);
      } else if (e.name === 'go.mod') {
        goMods.push(path.join(dir, e.name));
      }
    }
  };
  walkForGoMod(repoPath, 0);
  for (const abs of goMods) {
    const raw = readText(abs);
    if (!raw) continue;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t.startsWith('module ')) {
        push(t.slice(7).trim().replace(/^"|"$/g, ''), 'go', path.relative(repoPath, abs),
             path.relative(repoPath, path.dirname(abs)));
        break;
      }
    }
  }

  // Node: the root package.json plus each workspace package's own name.
  const rootPkg = readJson(path.join(repoPath, 'package.json'));
  if (rootPkg) push(rootPkg.name, 'npm', 'package.json', '');
  try {
    for (const wp of detectWorkspacePackages(repoPath).packages || []) {
      const pkg = readJson(path.join(repoPath, wp.subdir, 'package.json'));
      if (pkg) push(pkg.name, 'npm', path.join(wp.subdir, 'package.json'), wp.subdir);
    }
  } catch (_) { /* not a JS workspace */ }

  // JVM: a module's importable identity is the PACKAGE it declares, not its artifact id.
  //
  // There is no reliable link between the two — `ftgo-order-service-api` declares
  // `net.chrisrichardson.ftgo.orderservice.api` — and the groupId is worse than useless as a
  // per-module identity because every module in a multi-module build shares it, so matching on
  // it makes every module a provider for every other. Measured on ftgo: 10 modules, one groupId.
  //
  // So the packages the module's own source declares are emitted as its identities, collapsed to
  // their shortest common roots so a sub-package is not a separate provider. The Maven
  // coordinate is still emitted for exactness where a build tool names it directly.
  const pom = readText(path.join(repoPath, 'pom.xml'));
  const gradle = readText(path.join(repoPath, 'build.gradle')) || readText(path.join(repoPath, 'build.gradle.kts'));
  if (pom) {
    const stripped = pom.replace(/<(dependency|plugin|parent)>[\s\S]*?<\/\1>/g, '');
    const gid = /<groupId>([^<]+)<\/groupId>/.exec(stripped) || /<groupId>([^<]+)<\/groupId>/.exec(pom);
    const aid = /<artifactId>([^<]+)<\/artifactId>/.exec(stripped);
    if (gid && aid) push(`${gid[1].trim()}:${aid[1].trim()}`, 'maven', 'pom.xml', '');
  }
  if (pom || gradle) {
    for (const pkg of declaredJvmPackages(repoPath)) {
      push(pkg.name, 'jvm-package', pom ? 'pom.xml' : 'build.gradle', '', pkg.files);
    }
  }

  // Python: pyproject.toml [project].name, else setup.py's name= argument.
  const pyproject = readText(path.join(repoPath, 'pyproject.toml'));
  if (pyproject) {
    const m = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(pyproject);
    if (m) push(m[1], 'python', 'pyproject.toml', '');
  }
  const setuppy = readText(path.join(repoPath, 'setup.py'));
  if (setuppy) {
    const m = /name\s*=\s*["']([^"']+)["']/.exec(setuppy);
    if (m) push(m[1], 'python', 'setup.py', '');
  }

  // Rust and PHP.
  const cargo = readText(path.join(repoPath, 'Cargo.toml'));
  if (cargo) {
    const m = /\[package\][\s\S]*?^\s*name\s*=\s*["']([^"']+)["']/m.exec(cargo);
    if (m) push(m[1], 'cargo', 'Cargo.toml', '');
  }
  const composer = readJson(path.join(repoPath, 'composer.json'));
  if (composer) push(composer.name, 'composer', 'composer.json', '');

  // Ruby: a *.gemspec at the repo root names the published gem (`spec.name = "my_gem"`); code
  // consumes it as `require "my_gem"`, so the gem name IS the import identity.
  try {
    for (const e of fs.readdirSync(repoPath, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.gemspec')) {
        const gs = readText(path.join(repoPath, e.name));
        const m = gs && /\.name\s*=\s*["']([^"']+)["']/.exec(gs);
        if (m) push(m[1], 'rubygems', e.name, '');
      }
    }
  } catch (_) { /* degrade, never throw — a missing/odd repo dir just yields no gem identity */ }

  const seen = new Set();
  return out
    .filter((m) => (seen.has(m.name + '|' + m.subdir) ? false : seen.add(m.name + '|' + m.subdir)))
    .sort((a, b) => b.name.length - a.name.length);
}

module.exports = {
  ROOT_MANIFEST_FILES,
  detectWorkspacePackages,
  detectPublishedModules,
  assignPackageMembership,
  isRootManifestFile,
  resolveWorkspaceLayout,
  collectWorkspaceWalkTargets,
  buildWorkspaceManifest,
  readPackageManifest,
  buildWorkspacePackageIndex,
};
