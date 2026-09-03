'use strict';

const KNOWN_HOSTS = new Set([
  'github.com',
  'gitlab.com',
  'bitbucket.org',
]);

const LOCAL_PATH_RE = /^(\/|\.\/|\.\.\/|[A-Za-z]:\\)/;

function getAllowedRepoHosts() {
  const hosts = new Set(KNOWN_HOSTS);
  const extraHosts = process.env.VCS_ALLOWED_HOSTS;
  if (typeof extraHosts === 'string' && extraHosts.trim()) {
    for (const host of extraHosts.split(',')) {
      const cleaned = host.trim().toLowerCase();
      if (cleaned) hosts.add(cleaned);
    }
  }
  return hosts;
}

function classifySourceProvider(url) {
  if (!url || typeof url !== 'string') return 'LOCAL';
  if (LOCAL_PATH_RE.test(url) || url.startsWith('file://')) return 'LOCAL';
  try {
    const parsed = new URL(url);
    const host = parsed.host.toLowerCase();
    if (host === 'github.com' || host.endsWith('.ghe.com')) return 'GITHUB';
    if (host === 'gitlab.com' || parsed.pathname.includes('/-/')) return 'GITLAB';
    if (host === 'bitbucket.org' || host.startsWith('bitbucket.')) return 'BITBUCKET';
    if (getAllowedRepoHosts().has(host)) {
      if (host.includes('github') || host.includes('ghe')) return 'GITHUB';
      if (host.includes('gitlab')) return 'GITLAB';
      if (host.includes('bitbucket')) return 'BITBUCKET';
      return 'GIT';
    }
    return 'UNSUPPORTED';
  } catch (_) {
    return LOCAL_PATH_RE.test(url) ? 'LOCAL' : 'UNSUPPORTED';
  }
}

function normalizeRepoWebUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (LOCAL_PATH_RE.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (!getAllowedRepoHosts().has(parsed.host.toLowerCase())) return null;
    return parsed.toString().replace(/\.git$/i, '').replace(/\/+$/, '');
  } catch (_) {
    return null;
  }
}

function validateRepoUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  if (LOCAL_PATH_RE.test(url) || url.startsWith('file://')) return true;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return getAllowedRepoHosts().has(parsed.host.toLowerCase());
  } catch (_) {
    return false;
  }
}

module.exports = {
  getAllowedRepoHosts,
  classifySourceProvider,
  normalizeRepoWebUrl,
  validateRepoUrl,
  KNOWN_HOSTS,
};
