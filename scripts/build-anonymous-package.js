#!/usr/bin/env node

import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT = join(ROOT, 'dist', 'droidnode');
const RUNTIME_ENTRIES = ['bin', 'lib', 'src'];
const FORBIDDEN_IDENTITY = /thezzisu/i;

function anonymousReadme() {
  const source = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const automationStart = source.indexOf('\n## Automation\n');
  const platformStart = source.indexOf('\n## Platform support\n');
  if (automationStart < 0 || platformStart <= automationStart) {
    throw new Error('README section markers changed; refusing to build an incomplete anonymous README');
  }
  return (source.slice(0, automationStart) + source.slice(platformStart))
    .replaceAll('@thezzisu/droidnode', 'droidnode');
}

function anonymousLicense() {
  const source = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
  const result = source.replace(
    /^Copyright \(c\) 2026 thezzisu$/m,
    'Copyright (c) 2026 droidnode contributors',
  );
  if (result === source) throw new Error('LICENSE copyright marker changed');
  return result;
}

function assertAnonymous(dir) {
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        pending.push(path);
        continue;
      }
      if (FORBIDDEN_IDENTITY.test(readFileSync(path, 'utf8'))) {
        throw new Error(`anonymous package contains a forbidden identity marker: ${path}`);
      }
    }
  }
}

export function buildAnonymousPackage(outputDir = DEFAULT_OUTPUT) {
  const output = resolve(outputDir);
  const sourcePaths = RUNTIME_ENTRIES.map((entry) => join(ROOT, entry));
  const replacesRepository = output === ROOT || ROOT.startsWith(output + sep);
  const replacesSource = sourcePaths.some((path) => (
    output === path || output.startsWith(path + sep) || path.startsWith(output + sep)
  ));
  if (replacesRepository || replacesSource) {
    throw new Error(`refusing to replace repository source path: ${output}`);
  }
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });

  for (const entry of RUNTIME_ENTRIES) {
    cpSync(join(ROOT, entry), join(output, entry), { recursive: true });
  }

  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  manifest.name = 'droidnode';
  delete manifest.author;
  delete manifest.repository;
  delete manifest.bugs;
  delete manifest.homepage;

  writeFileSync(join(output, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(output, 'README.md'), anonymousReadme());
  writeFileSync(join(output, 'LICENSE'), anonymousLicense());
  assertAnonymous(output);

  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = buildAnonymousPackage(process.argv[2] ?? DEFAULT_OUTPUT);
  console.log(output);
}
