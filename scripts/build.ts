/**
 * Walks src/plugins/<ns>/<name>/index.yaml, validates each entry,
 * and emits dist/v1/plugins.json + dist/v1/plugins/<ns>/<name>.json.
 *
 * Usage:
 *   tsx scripts/build.ts                # build into dist/
 *   tsx scripts/build.ts --validate-only
 */
import { readdir, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'src', 'plugins');
const DIST = join(ROOT, 'dist');
const VALIDATE_ONLY = process.argv.includes('--validate-only');

const SLUG_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

const DownloadSchema = z.object({
  url: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive(),
});

const InstallRuleSchema = z.object({
  format: z.enum(['vst', 'vst3', 'fst']),
  include: z.array(z.string()).min(1),
  exclude: z.array(z.string()).optional(),
  strip: z.number().int().min(0).default(0),
});

const PluginSchema = z.object({
  slug: z.string().regex(SLUG_RE, 'slug must be "namespace/name", lowercase, [a-z0-9-]'),
  name: z.string().min(1),
  description: z.string().min(1),
  author: z.string().min(1),
  license: z.string().min(1),
  homepage: z.string().url().optional(),
  image: z.string().url().optional(),
  tags: z.array(z.string()).default([]),
  download: DownloadSchema,
  install: z.array(InstallRuleSchema).min(1),
});

type Plugin = z.infer<typeof PluginSchema>;

async function* walkYaml(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkYaml(p);
    else if (entry.isFile() && entry.name === 'index.yaml') yield p;
  }
}

async function main() {
  const plugins: Plugin[] = [];
  let count = 0;
  let hadError = false;

  for await (const file of walkYaml(SRC)) {
    count++;
    const rel = relative(ROOT, file);
    let parsed: unknown;
    try {
      parsed = parse(await readFile(file, 'utf8'));
    } catch (err) {
      console.error(`✗ ${rel}: invalid yaml — ${(err as Error).message}`);
      hadError = true;
      continue;
    }
    const result = PluginSchema.safeParse(parsed);
    if (!result.success) {
      console.error(`✗ ${rel}:`);
      for (const issue of result.error.issues) {
        console.error(`    ${issue.path.join('.') || '<root>'}: ${issue.message}`);
      }
      hadError = true;
      continue;
    }
    // path/slug must agree
    const expected = `src/plugins/${result.data.slug}/index.yaml`;
    if (rel !== expected) {
      console.error(`✗ ${rel}: slug "${result.data.slug}" does not match path (expected ${expected})`);
      hadError = true;
      continue;
    }
    plugins.push(result.data);
    console.log(`✓ ${result.data.slug}`);
  }

  // dup check
  const seen = new Set<string>();
  for (const p of plugins) {
    if (seen.has(p.slug)) {
      console.error(`✗ duplicate slug: ${p.slug}`);
      hadError = true;
    }
    seen.add(p.slug);
  }

  if (hadError) {
    console.error(`\nvalidation failed (${count} file${count === 1 ? '' : 's'} scanned)`);
    process.exit(1);
  }

  if (VALIDATE_ONLY) {
    console.log(`\nvalidated ${plugins.length} plugin${plugins.length === 1 ? '' : 's'}`);
    return;
  }

  plugins.sort((a, b) => a.slug.localeCompare(b.slug));
  await rm(DIST, { recursive: true, force: true });
  await mkdir(join(DIST, 'v1', 'plugins'), { recursive: true });

  const index = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    count: plugins.length,
    plugins,
  };
  await writeFile(join(DIST, 'v1', 'plugins.json'), JSON.stringify(index, null, 2) + '\n');

  for (const p of plugins) {
    const out = join(DIST, 'v1', 'plugins', `${p.slug}.json`);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(p, null, 2) + '\n');
  }

  // touch a .nojekyll so Pages serves the JSON dirs/files raw
  await writeFile(join(DIST, '.nojekyll'), '');

  console.log(`\nbuilt ${plugins.length} plugin${plugins.length === 1 ? '' : 's'} → dist/v1/`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
