'use strict';

const ROLE_COMPATIBILITY = {
  PRODUCTION: new Set(['PRODUCTION', 'MAIN']),
  MAIN: new Set(['PRODUCTION', 'MAIN']),
  DEVELOPMENT: new Set(['DEVELOPMENT', 'STAGING']),
  STAGING: new Set(['DEVELOPMENT', 'STAGING']),
  FEATURE: new Set(['FEATURE']),
};

function normalizeRole(role) {
  return (role || 'MAIN').toUpperCase();
}

function rolesCompatible(roleA, roleB) {
  const a = normalizeRole(roleA);
  const b = normalizeRole(roleB);
  if (a === b) return true;
  const compat = ROLE_COMPATIBILITY[a];
  return compat ? compat.has(b) : false;
}

function buildCrossRepoBranchGroups(branches, options = {}) {
  const declaredRevisionSets = options.declaredRevisionSets || null;
  if (!Array.isArray(branches) || branches.length < 2) return [];

  if (declaredRevisionSets && declaredRevisionSets.length > 0) {
    const knownIds = new Set(branches.map((b) => b.branch_id));
    return declaredRevisionSets
      .map((set) => (Array.isArray(set) ? set : [])
        .map((id) => Number(id))
        .filter((id) => knownIds.has(id)))
      .filter((group) => group.length >= 2);
  }

  const groups = [];
  const assigned = new Set();

  for (let i = 0; i < branches.length; i++) {
    const seed = branches[i];
    if (assigned.has(seed.branch_id)) continue;

    const group = [seed.branch_id];
    assigned.add(seed.branch_id);

    for (let j = i + 1; j < branches.length; j++) {
      const candidate = branches[j];
      if (assigned.has(candidate.branch_id)) continue;

      const compatibleWithGroup = group.every((gid) => {
        const member = branches.find((b) => b.branch_id === gid);
        return rolesCompatible(member.branch_role, candidate.branch_role);
      });

      if (compatibleWithGroup) {
        group.push(candidate.branch_id);
        assigned.add(candidate.branch_id);
      }
    }

    if (group.length >= 2) groups.push(group);
  }

  return groups;
}

module.exports = {
  ROLE_COMPATIBILITY,
  normalizeRole,
  rolesCompatible,
  buildCrossRepoBranchGroups,
};
