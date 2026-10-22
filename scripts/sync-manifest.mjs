#!/usr/bin/env node
/**
 * Copy the version from package.json into manifest.json.
 *
 * package.json is the single source of truth for the version; the manifest
 * carries a derived copy so that a locally built add-on reports the right
 * version. CI fails the build if the two ever disagree.
 *
 * Usage: node scripts/sync-manifest.mjs [--check]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = resolve(repoRoot, 'package.json');
const manifestPath = resolve(repoRoot, 'manifest.json');

const { version } = JSON.parse(readFileSync(packagePath, 'utf8'));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

if (manifest.version === version) {
    console.log(`manifest.json is in sync (${version})`);
    process.exit(0);
}

if (process.argv.includes('--check')) {
    console.error(
        `manifest.json version ${manifest.version} does not match package.json ${version} — ` +
            'run `pnpm run sync-manifest`'
    );
    process.exit(1);
}

manifest.version = version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`manifest.json updated to ${version}`);
