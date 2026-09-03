'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, execFile } = require('child_process');
const { BaseProvider } = require('./provider');
const { cloneWithHistory } = require('./git-clone');
const { DEFAULT_MAX_BYTES: MAX_FILE_BYTES } = require('../ingest-policy');

// Read from ingest-policy.js, not restated: this used to be a hardcoded 200_000 that no
// environment variable could move, so raising the walker's limit admitted files this provider
// then threw "File too large" on.

/** Directories to skip during file listing (mirrors ingest.js SKIP_DIRS). */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'vendor', '__pycache__', '.next', 'dist', 'build',
  'target', '.gradle', 'coverage', '.nyc_output', 'e2e', 'e2e-test',
  '__tests__', 'test', 'tests', 'spec', '__mocks__', 'fixtures', 'stubs',
]);

/**
 * Execute a git command in a given working directory.
 * @param {string} cmd  - git sub-command + args (appended to "git ")
 * @param {string} cwd  - Working directory (repo root)
 * @returns {string}     Stdout trimmed
 */
function git(cmd, cwd) {
  return execSync(`git ${cmd}`, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
  }).toString().trim();
}

/**
 * Local filesystem + git CLI provider.
 * Reads directly from checked-out repositories — no network calls.
 */
class LocalProvider extends BaseProvider {
  constructor() {
    super('local');
  }

  /**
   * Resolve and validate that the repo path exists and is a git repo.
   * @param {string} repoPath - Absolute or relative path to the repo
   * @returns {string} Resolved absolute path
   */
  _resolve(repoPath) {
    const resolved = path.resolve(repoPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`[local-provider] Path does not exist: ${resolved}`);
    }
    return resolved;
  }

  /**
   * @param {string} repoPath - Local path to the repo
   * @returns {Promise<Object>}
   */
  async getRepo(repoPath) {
    const resolved = this._resolve(repoPath);
    const name = path.basename(resolved);

    let defaultBranch = 'main';
    let remoteUrl = null;
    try {
      defaultBranch = git('rev-parse --abbrev-ref HEAD', resolved);
    } catch (_) { /* use default */ }
    try {
      remoteUrl = git('remote get-url origin', resolved);
    } catch (_) { /* no remote */ }

    return {
      id: null,
      name,
      fullPath: resolved,
      defaultBranch,
      description: null,
      webUrl: remoteUrl,
      createdAt: null,
      lastActivityAt: null,
    };
  }

  /**
   * @param {string} repoPath
   * @returns {Promise<string[]>}
   */
  async listBranches(repoPath) {
    const resolved = this._resolve(repoPath);
    try {
      const raw = git('branch --format="%(refname:short)"', resolved);
      return raw
        .split('\n')
        .map(b => b.replace(/^["']|["']$/g, '').trim())
        .filter(Boolean);
    } catch (_) {
      return ['main'];
    }
  }

  /**
   * List all tracked files using `git ls-tree`.
   * Falls back to filesystem walk if git is unavailable.
   * @param {string} repoPath
   * @param {string} branch
   * @returns {Promise<Object[]>}
   */
  async listFiles(repoPath, branch) {
    const resolved = this._resolve(repoPath);

    try {
      // Use git ls-tree for accurate tracked-file listing (mode type sha path)
      const raw = git(`ls-tree -r ${branch || 'HEAD'}`, resolved);
      return raw
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const tabIdx = line.indexOf('\t');
          if (tabIdx === -1) return null;
          const meta = line.slice(0, tabIdx).split(' ');
          const file = line.slice(tabIdx + 1);
          return { path: file, type: 'blob', size: 0, id: meta[2] };
        })
        .filter(Boolean);
    } catch (_) {
      // Fallback: walk filesystem (same approach as ingest.js walkRepo)
      return this._walkDir(resolved);
    }
  }

  /**
   * Walk the directory tree, skipping hidden dirs and known non-source dirs.
   * @param {string} root
   * @returns {Object[]}
   */
  _walkDir(root) {
    const files = [];

    const walk = (dir, relBase = '') => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        return;
      }

      for (const entry of entries) {
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            walk(path.join(dir, entry.name), rel);
          }
        } else if (entry.isFile()) {
          const fullPath = path.join(dir, entry.name);
          let mtime = Date.now();
          try {
            mtime = fs.statSync(fullPath).mtimeMs;
          } catch (_) {}
          // Simple hash of path + mtime to simulate git SHA
          const sha = require('crypto').createHash('sha1').update(`${rel}:${mtime}`).digest('hex');
          files.push({ path: rel, type: 'blob', size: 0, id: sha });
        }
      }
    };

    walk(root);
    return files;
  }

  /**
   * @param {string} repoPath
   * @param {string} branch  - Used with `git show branch:filePath`
   * @param {string} filePath
   * @returns {Promise<string>}
   */
  async getFileContent(repoPath, branch, filePath) {
    const resolved = this._resolve(repoPath);

    // If HEAD or current branch, try direct read first (faster for local)
    try {
      const currentBranch = git('rev-parse --abbrev-ref HEAD', resolved);
      if (!branch || branch === currentBranch || branch === 'HEAD') {
        const fullPath = path.join(resolved, filePath);
        const stat = fs.statSync(fullPath);
        if (stat.size > MAX_FILE_BYTES) {
          throw new Error(`File too large: ${stat.size} bytes (max ${MAX_FILE_BYTES})`);
        }
        return fs.readFileSync(fullPath, 'utf8');
      }
    } catch (err) {
      // If the direct read failed for a reason other than branch mismatch, use git show
      if (err.message.includes('File too large')) throw err;
    }

    // Use `git show` for arbitrary branches
    try {
      return git(`show ${branch}:${filePath}`, resolved);
    } catch (err) {
      throw new Error(`[local-provider] Failed to read ${filePath} at ${branch}: ${err.message}`);
    }
  }

  /**
   * @param {string} repoPath
   * @param {string} from
   * @param {string} to
   * @param {string} [filePath]
   * @returns {Promise<Object[]>}
   */
  async getDiff(repoPath, from, to, filePath) {
    const resolved = this._resolve(repoPath);
    const pathArg = filePath ? ` -- ${filePath}` : '';

    try {
      const raw = git(`diff ${from}..${to} --name-status${pathArg}`, resolved);
      if (!raw) return [];

      return raw.split('\n').filter(Boolean).map(line => {
        const parts = line.split('\t');
        const status = parts[0];
        const fileName = parts[parts.length - 1];
        const oldName = parts.length > 2 ? parts[1] : fileName;

        return {
          old_path: oldName,
          new_path: fileName,
          diff: '', // full diff text not included in name-status mode
          new_file: status === 'A',
          deleted_file: status === 'D',
          renamed_file: status.startsWith('R'),
        };
      });
    } catch (err) {
      throw new Error(`[local-provider] getDiff failed: ${err.message}`);
    }
  }

  /**
   * @param {string} repoPath
   * @param {string} branch
   * @param {Object} [opts]
   * @returns {Promise<Object[]>}
   */
  async getCommits(repoPath, branch, opts = {}) {
    const resolved = this._resolve(repoPath);
    const maxCount = opts.maxCount || 200;

    let dateArgs = '';
    if (opts.since) dateArgs += ` --since="${opts.since}"`;
    if (opts.until) dateArgs += ` --until="${opts.until}"`;

    try {
      // %H = sha, %s = subject, %aN = author name, %aE = author email, %aI = author date ISO
      const format = '--format=%H%n%s%n%aN%n%aE%n%aI%n---END---';
      const raw = git(
        `log ${branch || 'HEAD'} -n ${maxCount} ${format}${dateArgs}`,
        resolved
      );

      if (!raw) return [];

      const entries = raw.split('---END---').filter(e => e.trim());
      return entries.map(entry => {
        const lines = entry.trim().split('\n');
        return {
          sha: lines[0] || '',
          message: lines[1] || '',
          author: lines[2] || 'unknown',
          email: lines[3] || null,
          date: lines[4] || null,
        };
      });
    } catch (err) {
      throw new Error(`[local-provider] getCommits failed: ${err.message}`);
    }
  }

  /**
   * @param {string} repoPath
   * @param {string} commitSha
   * @returns {Promise<Object[]>}
   */
  async getCommitDiff(repoPath, commitSha) {
    try {
      return await this.getDiff(repoPath, `${commitSha}^`, commitSha);
    } catch (_) {
      // Fallback: if parent revision does not exist, compare empty tree
      return await this.getDiff(repoPath, '4b825dc642cb6eb9a0ff3e48f61d1716711c8a1b', commitSha);
    }
  }

  /**
   * @param {string} repoPath
   * @param {string} from
   * @param {string} to
   * @returns {Promise<{ commits: Object[], diffs: Object[] }>}
   */
  async compare(repoPath, from, to) {
    const resolved = this._resolve(repoPath);
    try {
      const format = '--format=%H%n%s%n%aN%n%aE%n%aI%n---END---';
      const raw = git(`log ${from}..${to} ${format}`, resolved);
      const entries = raw ? raw.split('---END---').filter(e => e.trim()) : [];
      const commits = entries.map(entry => {
        const lines = entry.trim().split('\n');
        return {
          sha: lines[0] || '',
          message: lines[1] || '',
          author: lines[2] || 'unknown',
          email: lines[3] || null,
          date: lines[4] || null,
        };
      });
      const diffs = await this.getDiff(repoPath, from, to);
      return { commits, diffs };
    } catch (err) {
      throw new Error(`[local-provider] compare failed: ${err.message}`);
    }
  }

  async clone(url, destDir, opts = {}) {
    // cloneWithHistory (not --depth 1): git-coupling-analyzer needs real commit
    // history to derive COUPLED_WITH.
    return cloneWithHistory(url, destDir, { logPrefix: 'local-provider' });
  }
}

module.exports = { LocalProvider };
