#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function main() {
  if (process.env.npm_config_global === 'true') return;

  const targetDir = process.env.INIT_CWD;
  if (!targetDir) return;

  const source = path.join(__dirname, '..', 'KORAINIT.md');
  const target = path.join(targetDir, 'KORAINIT.md');
  if (path.resolve(target) === path.resolve(source)) return;
  if (fs.existsSync(target)) return;

  try {
    fs.copyFileSync(source, target);
    console.log('\nkoragraph: added KORAINIT.md to your project root.');
    console.log('Open it with your coding agent (e.g. "@KORAINIT.md go" in Claude Code, Cursor, or Copilot) to import your existing CLAUDE.md/AGENTS.md into koragraph.\n');
  } catch {
    // best-effort convenience — never fail the install over this
  }
}

main();
