#!/usr/bin/env node
/**
 * Post-build secret leak check — `npm run check:secrets`
 *
 * The central promise of this app is that the Grafana service account token
 * never reaches the browser. This script verifies that promise against the
 * actual build output rather than trusting code review.
 *
 * It scans the client bundle in .next/static for:
 *   1. Anything shaped like a Grafana service account token (glsa_...).
 *   2. The literal value of GRAFANA_SERVICE_ACCOUNT_TOKEN, if provided.
 *   3. The Grafana hostname, which would reveal the upstream instance.
 *
 * Exit code 0 = clean, 1 = leak found (wire this into CI).
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const BUILD_DIR = join(ROOT, '.next');

/** Directories that make up the browser-facing bundle. */
const CLIENT_DIRS = [join(BUILD_DIR, 'static')];

/** Text file extensions worth scanning. */
const SCANNABLE = /\.(js|mjs|cjs|css|html|json|txt|map)$/i;

/** Patterns that must never appear in client output. */
function buildPatterns() {
  const patterns = [
    {
      label: 'Grafana service account token (glsa_...)',
      regex: /glsa_[A-Za-z0-9]{20,}(_[A-Za-z0-9]+)?/g,
    },
    { label: 'NEXT_PUBLIC_ token leak', regex: /NEXT_PUBLIC_[A-Z_]*TOKEN[A-Z_]*/g },
  ];

  const token = process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN?.trim();
  if (token && token.length >= 8) {
    patterns.push({
      label: 'literal value of GRAFANA_SERVICE_ACCOUNT_TOKEN',
      regex: new RegExp(escapeRegExp(token), 'g'),
    });
  }

  const grafanaUrl = process.env.GRAFANA_URL?.trim();
  if (grafanaUrl) {
    try {
      const { hostname } = new URL(grafanaUrl);
      if (hostname && hostname !== 'localhost') {
        patterns.push({
          label: `Grafana hostname (${hostname})`,
          regex: new RegExp(escapeRegExp(hostname), 'g'),
        });
      }
    } catch {
      // Unparseable URL is reported by lib/grafana.ts at runtime; ignore here.
    }
  }

  return patterns;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Recursively collect scannable files under a directory. */
async function collectFiles(dir, acc = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(full, acc);
    } else if (entry.isFile() && SCANNABLE.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

async function main() {
  if (!existsSync(BUILD_DIR)) {
    console.error('No .next directory found. Run `npm run build` first.');
    process.exit(1);
  }

  const files = [];
  for (const dir of CLIENT_DIRS) {
    await collectFiles(dir, files);
  }

  if (files.length === 0) {
    console.error('No client bundle files found under .next/static — did the build succeed?');
    process.exit(1);
  }

  const patterns = buildPatterns();
  const findings = [];
  let scannedBytes = 0;

  for (const file of files) {
    const info = await stat(file);
    // Skip very large maps; they are not executed by the browser.
    if (info.size > 25 * 1024 * 1024) continue;

    const content = await readFile(file, 'utf8');
    scannedBytes += content.length;

    for (const { label, regex } of patterns) {
      regex.lastIndex = 0;
      const match = regex.exec(content);
      if (match) {
        findings.push({
          file: relative(ROOT, file),
          label,
          // Never print the full secret — enough to locate it, not to use it.
          excerpt: `${match[0].slice(0, 8)}…${match[0].slice(-4)}`,
        });
      }
    }
  }

  console.log(
    `Scanned ${files.length} client files (${(scannedBytes / 1024 / 1024).toFixed(2)} MB) ` +
      `for ${patterns.length} pattern(s).`,
  );

  if (findings.length > 0) {
    console.error('\n✗ SECRET LEAK DETECTED in the client bundle:\n');
    for (const { file, label, excerpt } of findings) {
      console.error(`  ${file}\n    matched: ${label}\n    excerpt: ${excerpt}\n`);
    }
    console.error(
      'The Grafana credential must never reach the browser. Remove the offending ' +
        'reference, ensure no env var is prefixed with NEXT_PUBLIC_, and rebuild.\n',
    );
    process.exit(1);
  }

  console.log('✓ No Grafana credentials or hostnames found in the client bundle.');
}

main().catch((error) => {
  console.error('Secret check failed to run:', error);
  process.exit(1);
});
