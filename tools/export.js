#!/usr/bin/env node
// Generate a model JSON from parameters without a browser.
// Usage: node tools/export.js [params.json] [out.json]
//   params.json — any subset of generator DEFAULTS (e.g. {"layout":"u-shape","island":true})
//   out.json    — defaults to stdout
'use strict';
const fs = require('fs');
const G = require('../generator.js');

const [, , inFile, outFile] = process.argv;
let params = {};
if (inFile) params = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const layout = G.LAYOUTS[params.layout || G.DEFAULTS.layout];
const model = G.generate(Object.assign({}, layout ? layout.defaults : {}, params));
const json = JSON.stringify(model, null, 2);
if (outFile) {
  fs.writeFileSync(outFile, json);
  const issues = model.checks.filter((c) => c.level !== 'ok');
  console.error(`Wrote ${outFile}: ${model.boxes.length} boxes, ${model.walls.length} walls, ${issues.length} issue(s)`);
  issues.forEach((c) => console.error(`  [${c.level}] ${c.msg}`));
} else {
  process.stdout.write(json + '\n');
}
