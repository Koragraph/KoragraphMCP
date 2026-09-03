#!/usr/bin/env node
'use strict';

require('../src/cli/main')
  .run(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    // main.run() classifies everything it can reach; anything arriving here escaped a command's
    // own boundary, so print it plainly rather than losing it to an unhandled rejection.
    process.stderr.write(`koragraph: ${err?.stack || err?.message || err}\n`);
    process.exitCode = 1;
  });
