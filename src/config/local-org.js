'use strict';

// One developer, one machine, one owner: there is nothing to scope a graph against.
//
// `projects.org_id` survives in the schema and in five files' queries — blast-radius.js and
// graph-tool-service.js's impact query among them — because rewriting all of them to drop the
// predicate is fifty edits against queries whose output is a published number. Pinning the column
// to one constant is zero edits and the filters then always match. Threading the parameter out of
// those signatures is a later cleanup, not a behaviour change.
const LOCAL_ORG_ID = 1;

module.exports = { LOCAL_ORG_ID };
