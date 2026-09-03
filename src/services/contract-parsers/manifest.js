'use strict';

// Deterministic (zero-token) reader for build manifests — the DECLARED
// dependency list, with versions.
//
// The graph already knows which packages the code IMPORTS (resolveImportFacts
// mints a DEPENDENCY node per import module). It did not know which packages
// the project DECLARES, or at what version, and it could not connect the two.
// That gap makes a whole class of question unanswerable: "we are bumping
// spring-boot-starter-web, what breaks", "which declared dependency provides
// this import", "what do we ship that nobody imports".
//
// This is deterministic, covers nine ecosystems, and costs no tokens.
//
// Contract: parseManifest(relPath, content) -> {ecosystem, entries:[{name, version, scope}]} | null
// Never throws; returns null for a path it does not handle or content it
// cannot read.

const path = require('path');

function dedupe(entries) {
  const seen = new Map();
  for (const e of entries) {
    if (!e || !e.name) continue;
    const key = `${e.name}`.trim();
    if (!key || seen.has(key)) continue;
    seen.set(key, { name: key, version: e.version || null, scope: e.scope || null });
  }
  return [...seen.values()];
}

// Maven. Read with a scanner rather than an XML parser: a pom is the one file
// where <dependency> blocks are trivially delimited, and this avoids making the
// ingest tail depend on an XML library it otherwise does not need. Only
// <dependencies> blocks are read — <plugin> and <dependencyManagement> version
// pins are build machinery, not what the application links against.
function parsePom(content) {
  const entries = [];
  const withoutManagement = content.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '');
  const withoutBuild = withoutManagement.replace(/<build>[\s\S]*?<\/build>/g, '');
  const blockRe = /<dependency>([\s\S]*?)<\/dependency>/g;
  let m;
  while ((m = blockRe.exec(withoutBuild)) !== null) {
    const block = m[1];
    const group = /<groupId>\s*([^<]+?)\s*<\/groupId>/.exec(block);
    const artifact = /<artifactId>\s*([^<]+?)\s*<\/artifactId>/.exec(block);
    const version = /<version>\s*([^<]+?)\s*<\/version>/.exec(block);
    const scope = /<scope>\s*([^<]+?)\s*<\/scope>/.exec(block);
    if (!artifact) continue;
    const name = group ? `${group[1]}:${artifact[1]}` : artifact[1];
    entries.push({ name, version: version ? version[1] : null, scope: scope ? scope[1] : null });
  }
  return { ecosystem: 'maven', entries: dedupe(entries) };
}

// Gradle, Groovy and Kotlin DSL both:
//   implementation 'group:artifact:version'
//   testImplementation("group:artifact:version")
//   api group: 'g', name: 'a', version: 'v'
const GRADLE_CONFIGS = 'implementation|api|compileOnly|runtimeOnly|testImplementation|testCompileOnly|testRuntimeOnly|annotationProcessor|kapt|ksp|developmentOnly|compile|testCompile|runtime|classpath';
function parseGradle(content) {
  const entries = [];
  const coordRe = new RegExp(`\\b(${GRADLE_CONFIGS})\\s*[( ]\\s*["']([^"']+)["']`, 'g');
  let m;
  while ((m = coordRe.exec(content)) !== null) {
    const scope = m[1];
    const parts = m[2].split(':');
    if (parts.length < 2) continue;
    entries.push({ name: `${parts[0]}:${parts[1]}`, version: parts[2] || null, scope });
  }
  const mapRe = new RegExp(`\\b(${GRADLE_CONFIGS})\\s+group:\\s*["']([^"']+)["']\\s*,\\s*name:\\s*["']([^"']+)["'](?:\\s*,\\s*version:\\s*["']([^"']+)["'])?`, 'g');
  while ((m = mapRe.exec(content)) !== null) {
    entries.push({ name: `${m[2]}:${m[3]}`, version: m[4] || null, scope: m[1] });
  }
  return { ecosystem: 'maven', entries: dedupe(entries) };
}

function parsePackageJson(content) {
  let doc;
  try { doc = JSON.parse(content); } catch (_) { return null; }
  if (!doc || typeof doc !== 'object') return null;
  const entries = [];
  const sections = [
    ['dependencies', 'runtime'],
    ['devDependencies', 'dev'],
    ['peerDependencies', 'peer'],
    ['optionalDependencies', 'optional'],
  ];
  for (const [key, scope] of sections) {
    const section = doc[key];
    if (!section || typeof section !== 'object') continue;
    for (const [name, version] of Object.entries(section)) {
      entries.push({ name, version: typeof version === 'string' ? version : null, scope });
    }
  }
  return { ecosystem: 'npm', entries: dedupe(entries) };
}

// PEP 508 requirement line: `Django>=4.2,<5 ; python_version >= "3.9"`.
// Environment markers, extras and comments are stripped; `-r other.txt` and
// `-e .` lines are directives, not requirements.
function parseRequirementLine(line) {
  let s = line.split('#')[0].trim();
  if (!s || s.startsWith('-')) return null;
  s = s.split(';')[0].trim();
  const m = /^([A-Za-z0-9._-]+)\s*(\[[^\]]*\])?\s*(.*)$/.exec(s);
  if (!m) return null;
  const version = m[3] ? m[3].trim() : '';
  return { name: m[1], version: version || null, scope: 'runtime' };
}

function parseRequirementsTxt(content) {
  const entries = [];
  for (const line of content.split(/\r?\n/)) {
    const e = parseRequirementLine(line);
    if (e) entries.push(e);
  }
  return { ecosystem: 'pypi', entries: dedupe(entries) };
}

// pyproject.toml without a TOML parser: read the two array-of-strings forms
// PEP 621 and Poetry use. A full TOML dependency is a table, so Poetry's
// `package = "^1.0"` lines are read positionally inside their section header.
function parsePyproject(content) {
  const entries = [];
  const depsArray = /(?:^|\n)\s*dependencies\s*=\s*\[([\s\S]*?)\]/g;
  let m;
  while ((m = depsArray.exec(content)) !== null) {
    for (const q of m[1].matchAll(/["']([^"']+)["']/g)) {
      const e = parseRequirementLine(q[1]);
      if (e) entries.push(e);
    }
  }
  const optional = /\[project\.optional-dependencies\]([\s\S]*?)(?=\n\[|$)/.exec(content);
  if (optional) {
    for (const q of optional[1].matchAll(/["']([^"']+)["']/g)) {
      const e = parseRequirementLine(q[1]);
      if (e) entries.push({ ...e, scope: 'optional' });
    }
  }
  const poetryRe = /\[tool\.poetry\.(?:group\.[\w-]+\.)?dependencies\]([\s\S]*?)(?=\n\[|$)/g;
  while ((m = poetryRe.exec(content)) !== null) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^\s*([A-Za-z0-9._-]+)\s*=\s*(.+)$/.exec(line.split('#')[0]);
      if (!kv || kv[1] === 'python') continue;
      const raw = kv[2].trim();
      const ver = /^["']([^"']*)["']/.exec(raw);
      const inline = /version\s*=\s*["']([^"']*)["']/.exec(raw);
      entries.push({ name: kv[1], version: (ver && ver[1]) || (inline && inline[1]) || null, scope: 'runtime' });
    }
  }
  return { ecosystem: 'pypi', entries: dedupe(entries) };
}

// go.mod: `require x v1` lines plus `require ( ... )` blocks.
function parseGoMod(content) {
  const entries = [];
  const blockRe = /require\s*\(([\s\S]*?)\)/g;
  let m;
  while ((m = blockRe.exec(content)) !== null) {
    for (const line of m[1].split(/\r?\n/)) {
      const t = line.split('//')[0].trim();
      if (!t) continue;
      const p = t.split(/\s+/);
      if (p.length >= 2) entries.push({ name: p[0], version: p[1], scope: 'runtime' });
    }
  }
  const singleRe = /^\s*require\s+([^\s(]+)\s+(\S+)/gm;
  while ((m = singleRe.exec(content)) !== null) {
    entries.push({ name: m[1], version: m[2], scope: 'runtime' });
  }
  return { ecosystem: 'go', entries: dedupe(entries) };
}

// Cargo.toml: `[dependencies]` / `[dev-dependencies]` / `[build-dependencies]`
// sections, both `name = "1.0"` and `name = { version = "1.0" }`.
function parseCargoToml(content) {
  const entries = [];
  const sectionRe = /\[(?:workspace\.)?(dependencies|dev-dependencies|build-dependencies)\]([\s\S]*?)(?=\n\[|$)/g;
  let m;
  while ((m = sectionRe.exec(content)) !== null) {
    const scope = m[1] === 'dependencies' ? 'runtime' : m[1];
    for (const line of m[2].split(/\r?\n/)) {
      const kv = /^\s*([A-Za-z0-9._-]+)\s*=\s*(.+)$/.exec(line.split('#')[0]);
      if (!kv) continue;
      const raw = kv[2].trim();
      const ver = /^["']([^"']*)["']/.exec(raw) || /version\s*=\s*["']([^"']*)["']/.exec(raw);
      entries.push({ name: kv[1], version: ver ? ver[1] : null, scope });
    }
  }
  return { ecosystem: 'cargo', entries: dedupe(entries) };
}

// Gemfile: `gem 'name', '~> 1.0'` — the group is a block, so scope is read
// from an enclosing `group :development do`.
function parseGemfile(content) {
  const entries = [];
  let scope = 'runtime';
  for (const line of content.split(/\r?\n/)) {
    const t = line.split('#')[0];
    const g = /^\s*group\s+([^d]*)do/.exec(t);
    if (g) { scope = (g[1].match(/:(\w+)/) || [null, 'runtime'])[1]; continue; }
    if (/^\s*end\b/.test(t)) { scope = 'runtime'; continue; }
    const m = /^\s*gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/.exec(t);
    if (m) entries.push({ name: m[1], version: m[2] || null, scope });
  }
  return { ecosystem: 'rubygems', entries: dedupe(entries) };
}

function parseComposerJson(content) {
  let doc;
  try { doc = JSON.parse(content); } catch (_) { return null; }
  if (!doc || typeof doc !== 'object') return null;
  const entries = [];
  for (const [key, scope] of [['require', 'runtime'], ['require-dev', 'dev']]) {
    const section = doc[key];
    if (!section || typeof section !== 'object') continue;
    for (const [name, version] of Object.entries(section)) {
      if (name === 'php' || name.startsWith('ext-')) continue;
      entries.push({ name, version: typeof version === 'string' ? version : null, scope });
    }
  }
  return { ecosystem: 'packagist', entries: dedupe(entries) };
}

// .csproj / .fsproj: <PackageReference Include="X" Version="1.0" />
function parseCsproj(content) {
  const entries = [];
  const re = /<PackageReference\s+[^>]*Include\s*=\s*"([^"]+)"[^>]*?(?:Version\s*=\s*"([^"]+)")?[^>]*\/?>/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    entries.push({ name: m[1], version: m[2] || null, scope: 'runtime' });
  }
  return { ecosystem: 'nuget', entries: dedupe(entries) };
}

function parseManifest(relPath, content) {
  if (typeof content !== 'string' || !content.trim()) return null;
  const base = path.basename(relPath || '').toLowerCase();
  const ext = path.extname(relPath || '').toLowerCase();
  try {
    if (base === 'pom.xml') return parsePom(content);
    if (base === 'build.gradle' || base === 'build.gradle.kts') return parseGradle(content);
    if (base === 'package.json') return parsePackageJson(content);
    if (base === 'pyproject.toml') return parsePyproject(content);
    if (/^requirements[\w.-]*\.txt$/.test(base)) return parseRequirementsTxt(content);
    if (base === 'go.mod') return parseGoMod(content);
    if (base === 'cargo.toml') return parseCargoToml(content);
    if (base === 'gemfile') return parseGemfile(content);
    if (base === 'composer.json') return parseComposerJson(content);
    if (ext === '.csproj' || ext === '.fsproj') return parseCsproj(content);
  } catch (_) {
    // Never let a malformed manifest abort the ingest — same contract as the
    // other contract parsers.
    return null;
  }
  return null;
}

function isManifestPath(relPath) {
  const base = path.basename(relPath || '').toLowerCase();
  const ext = path.extname(relPath || '').toLowerCase();
  return base === 'pom.xml' || base === 'build.gradle' || base === 'build.gradle.kts'
    || base === 'package.json' || base === 'pyproject.toml' || /^requirements[\w.-]*\.txt$/.test(base)
    || base === 'go.mod' || base === 'cargo.toml' || base === 'gemfile' || base === 'composer.json'
    || ext === '.csproj' || ext === '.fsproj';
}

module.exports = { parseManifest, isManifestPath };
