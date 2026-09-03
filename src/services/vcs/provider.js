'use strict';

/**
 * VCS Provider interface — all providers must implement these methods.
 *
 * @typedef {Object} VCSProvider
 * @property {function(string): Promise<Object>}                   getRepo        - Get repository metadata
 * @property {function(string): Promise<string[]>}                 listBranches   - List branches
 * @property {function(string, string): Promise<Object[]>}         listFiles      - List files in a branch
 * @property {function(string, string, string): Promise<string>}   getFileContent - Get file content
 * @property {function(string, string, string, string): Promise<Object[]>} getDiff - Get diff between refs
 * @property {function(string, string): Promise<Object[]>}         getCommits     - Get commit log
 */

class BaseProvider {
  /**
   * @param {string} name - Human-readable name of the provider (e.g. 'github', 'gitlab')
   */
  constructor(name) {
    this.name = name;
  }

  /**
   * Get repository metadata (name, default branch, description, etc.)
   * @param {string} repoPath - Provider-specific repo identifier (owner/repo, project id, local path)
   * @returns {Promise<Object>} Repository metadata
   */
  async getRepo(repoPath) {
    throw new Error(`${this.name}: getRepo() not implemented`);
  }

  /**
   * List all branches in a repository.
   * @param {string} repoPath - Provider-specific repo identifier
   * @returns {Promise<string[]>} Array of branch names
   */
  async listBranches(repoPath) {
    throw new Error(`${this.name}: listBranches() not implemented`);
  }

  /**
   * List all files (blobs) in a given branch.
   * @param {string} repoPath - Provider-specific repo identifier
   * @param {string} branch   - Branch name
   * @returns {Promise<Object[]>} Array of { path, type, size } objects
   */
  async listFiles(repoPath, branch) {
    throw new Error(`${this.name}: listFiles() not implemented`);
  }

  /**
   * Get raw file content.
   * @param {string} repoPath - Provider-specific repo identifier
   * @param {string} branch   - Branch name / ref
   * @param {string} filePath - Path within the repo
   * @returns {Promise<string>} File content as UTF-8 string
   */
  async getFileContent(repoPath, branch, filePath) {
    throw new Error(`${this.name}: getFileContent() not implemented`);
  }

  /**
   * Get diff between two refs (branches, tags, commits).
   * @param {string} repoPath - Provider-specific repo identifier
   * @param {string} from     - Base ref
   * @param {string} to       - Head ref
   * @param {string} [filePath] - Optional file path to restrict the diff
   * @returns {Promise<Object[]>} Array of diff objects { old_path, new_path, diff, new_file, deleted_file }
   */
  async getDiff(repoPath, from, to, filePath) {
    throw new Error(`${this.name}: getDiff() not implemented`);
  }

  /**
   * Get commit log for a branch.
   * @param {string} repoPath - Provider-specific repo identifier
   * @param {string} branch   - Branch name
   * @param {Object} [opts]   - Optional: { since, until, maxCount }
   * @returns {Promise<Object[]>} Array of commit objects { sha, message, author, date }
   */
  async getCommits(repoPath, branch, opts = {}) {
    throw new Error(`${this.name}: getCommits() not implemented`);
  }

  /**
   * Get files changed in a single commit.
   * @param {string} repoPath
   * @param {string} commitSha
   * @returns {Promise<Object[]>} Array of diff objects { old_path, new_path, new_file, deleted_file, renamed_file }
   */
  async getCommitDiff(repoPath, commitSha) {
    throw new Error(`${this.name}: getCommitDiff() not implemented`);
  }

  /**
   * Compare two branch refs, returning commits and file diffs.
   * @param {string} repoPath
   * @param {string} from
   * @param {string} to
   * @returns {Promise<{ commits: Object[], diffs: Object[] }>}
   */
  async compare(repoPath, from, to) {
    throw new Error(`${this.name}: compare() not implemented`);
  }

  /**
   * Clone a remote repository (or extract an archive) into a local directory.
   * @param {string} url     - Remote URL, local path, or archive path
   * @param {string} destDir - Destination directory (must already exist or be createable)
   * @param {Object} [opts]  - { token } - override auth token
   * @returns {Promise<void>}
   */
  async clone(url, destDir, opts = {}) {
    throw new Error(`${this.name}: clone() not implemented`);
  }

  /**
   * Open a pull/merge request from a head branch/ref into a base branch.
   * @param {string} repoPath - Provider-specific repo identifier
   * @param {Object} opts
   * @param {string} opts.base  - Base branch (target)
   * @param {string} opts.head  - Head branch/ref (source)
   * @param {string} opts.title - PR/MR title
   * @param {string} opts.body  - PR/MR description body
   * @returns {Promise<{ id: string|number, url: string, number: number|string }>}
   */
  async openPullRequest(repoPath, { base, head, title, body } = {}) {
    throw new Error(`${this.name}: openPullRequest() not supported`);
  }
}

module.exports = { BaseProvider };
