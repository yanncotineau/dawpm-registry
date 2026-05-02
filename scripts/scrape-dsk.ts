/**
 * Scrape https://www.dskmusic.com for free VST instruments and emit
 * src/plugins/dsk/<name>/index.yaml entries.
 *
 * Strategy:
 *   1. Fetch the 3 listing pages under /category/vsti-all/ and collect
 *      plugin permalinks of the form /dsk-<slug>/.
 *   2. For each plugin page, extract the title, hero image, short
 *      description, and the "Windows VST" download redirect (the page
 *      offers a /?wp_ct=N link that 302s to the real zip).
 *   3. Resolve the redirect, download the zip, compute sha256 + size,
 *      and write src/plugins/dsk/<slug>/index.yaml.
 *
 * Idempotent: if a yaml file already exists at the target path with the
 * same upstream URL, we skip the download.
 *
 * Usage:
 *   tsx scripts/scrape-dsk.ts                # process every plugin
 *   tsx scripts/scrape-dsk.ts --limit 5      # process at most N new ones
 *   tsx scripts/scrape-dsk.ts --only overture,the-grand
 *   tsx scripts/scrape-dsk.ts --dry-run      # plan only, no downloads
 */
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'src', 'plugins', 'dsk');
const UA = 'dawpm-registry-scraper/1.0 (+https://github.com/yanncotineau/dawpm-registry)';

const LISTING_PAGES = [
  'https://www.dskmusic.com/category/vsti-all/',
  'https://www.dskmusic.com/category/vsti-all/page/2/',
  'https://www.dskmusic.com/category/vsti-all/page/3/',
];

interface CliArgs { limit?: number; only?: string[]; dryRun: boolean }

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { dryRun: argv.includes('--dry-run') };
  const li = argv.indexOf('--limit');
  if (li !== -1) out.limit = Number(argv[li + 1]);
  const oi = argv.indexOf('--only');
  if (oi !== -1) out.only = argv[oi + 1]?.split(',').map(s => s.trim()).filter(Boolean);
  return out;
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}

/** Resolve a `?wp_ct=N` redirect to the final zip URL by walking redirects manually. */
async function resolveRedirect(url: string): Promise<string> {
  let current = url;
  for (let hop = 0; hop < 8; hop++) {
    const r = await fetch(current, { headers: { 'user-agent': UA }, redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) throw new Error(`redirect from ${current} had no Location`);
      current = new URL(loc, current).toString();
      continue;
    }
    return current;
  }
  throw new Error(`too many redirects from ${url}`);
}

/** Stream a URL into a file while computing sha256, returning {size, sha256}. */
async function downloadAndHash(url: string, dest: string): Promise<{ size: number; sha256: string }> {
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return { size: buf.byteLength, sha256: createHash('sha256').update(buf).digest('hex') };
}

/** Hash an existing file. */
async function hashFile(path: string): Promise<{ size: number; sha256: string }> {
  const buf = await readFile(path);
  return { size: buf.byteLength, sha256: createHash('sha256').update(buf).digest('hex') };
}

/** Pull all "/dsk-<slug>/" permalinks from a listing-page HTML. */
function extractPluginLinks(html: string): string[] {
  const re = /href="(https:\/\/www\.dskmusic\.com\/dsk-[a-z0-9-]+\/)"/g;
  const set = new Set<string>();
  let m;
  while ((m = re.exec(html))) set.add(m[1]);
  return [...set];
}

interface PluginPage {
  url: string;
  slug: string;
  title: string;
  description: string;
  image?: string;
  downloadRedirect?: string;
}

function parsePluginPage(html: string, url: string): PluginPage | null {
  const slugMatch = url.match(/\/dsk-([a-z0-9-]+)\//);
  if (!slugMatch) return null;
  const rawSlug = slugMatch[1].replace(/_$/, ''); // dsk-dreamz_ -> dreamz

  // The page has two <h1>s: site banner + post title. Pick the one starting with "DSK".
  const titles = [...html.matchAll(/<h1[^>]*>([^<]+)<\/h1>/gi)].map(m => m[1].trim());
  const title = titles.find(t => /^DSK\b/i.test(t)) ?? titles[1] ?? `DSK ${rawSlug}`;

  // The post body lives under <div id="post"> (no closing tag heuristic needed:
  // we just grab from there to <div id="related-posts">, which always follows).
  const startIdx = html.search(/<div\s+id="post"[^>]*>/i);
  const endIdx = html.search(/<div\s+id="related-posts"/i);
  const content = startIdx !== -1 && endIdx !== -1 ? html.slice(startIdx, endIdx) : html;

  const text = content
    .replace(/<\/?(p|br|div|span|strong|em|b|i|h\d)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  let description = text;
  const idx = text.indexOf('Features and download:');
  if (idx !== -1) description = text.slice(idx + 'Features and download:'.length).trim();
  // Trim leading list-bullet artifacts and stop at "Download" / image filenames.
  description = description.replace(/^[\s\-–—\u2013\u2014]+/, '');
  description = description.split(/(?<=[.!?])\s/).slice(0, 2).join(' ').trim();
  if (description.length > 280) description = description.slice(0, 277).trim() + '…';
  if (!description) description = `${title} — free VST instrument by DSK Music.`;

  // Hero image: prefer wp-content uploads, skip banners and icons.
  let img: string | undefined;
  const imgMatches = [...content.matchAll(/<img[^>]+src="([^"]+)"/gi)];
  for (const m of imgMatches) {
    const src = m[1];
    if (/wp-content\/uploads\/.*\.(jpg|png)/i.test(src) && !/(banner|patreon|ban_|sf2_ban|rhythmghost)/i.test(src)) {
      img = src.startsWith('http') ? src : new URL(src, url).toString();
      break;
    }
  }

  // Download links may be relative ("/?wp_ct=N"). Score by label.
  const links = [...content.matchAll(/<a[^>]+href="([^"]*\?wp_ct=\d+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const score = (label: string) => {
    const l = label.toLowerCase();
    if (l.includes('windows') && l.includes('64')) return 100;
    if (l.includes('windows') && l.includes('32')) return 80;
    if (l.includes('windows')) return 60;
    if (l.includes('vst') && !l.includes('mac') && !l.includes('au')) return 40;
    if (l.includes('mac') || l.includes('au')) return -10;
    if (l.includes('download')) return 30;
    return 10;
  };
  let best: { url: string; score: number } | null = null;
  for (const m of links) {
    const href = m[1].startsWith('http') ? m[1] : new URL(m[1], url).toString();
    const labelText = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (/<img/i.test(m[2])) continue; // image-only banner links
    const s = score(labelText);
    if (s < 0) continue;
    if (!best || s > best.score) best = { url: href, score: s };
  }

  return {
    url,
    slug: rawSlug,
    title,
    description,
    image: img,
    downloadRedirect: best?.url,
  };
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // 1) Collect every plugin permalink across the 3 listing pages.
  const links = new Set<string>();
  for (const page of LISTING_PAGES) {
    process.stdout.write(`fetching listing ${page}\n`);
    const html = await fetchText(page);
    for (const l of extractPluginLinks(html)) links.add(l);
  }
  process.stdout.write(`\nfound ${links.size} plugin pages\n\n`);

  let processed = 0;
  let added = 0;
  let skipped = 0;
  let failed = 0;

  for (const url of links) {
    const slug = url.match(/\/dsk-([a-z0-9-]+)\//)?.[1].replace(/_$/, '');
    if (!slug) continue;
    if (args.only && !args.only.includes(slug)) continue;

    const yamlPath = join(OUT, slug, 'index.yaml');
    if (await fileExists(yamlPath)) {
      skipped++;
      continue;
    }
    if (args.limit !== undefined && added >= args.limit) break;

    processed++;
    process.stdout.write(`◦ ${slug}: fetching page\n`);

    let page: PluginPage | null;
    try {
      const html = await fetchText(url);
      page = parsePluginPage(html, url);
    } catch (err) {
      process.stderr.write(`  ✗ ${slug}: ${(err as Error).message}\n`);
      failed++;
      continue;
    }
    if (!page || !page.downloadRedirect) {
      process.stderr.write(`  ✗ ${slug}: no Windows VST download link found\n`);
      failed++;
      continue;
    }

    let zipUrl: string;
    try {
      process.stdout.write(`  resolving redirect…\n`);
      zipUrl = await resolveRedirect(page.downloadRedirect);
    } catch (err) {
      process.stderr.write(`  ✗ ${slug}: redirect failed — ${(err as Error).message}\n`);
      failed++;
      continue;
    }

    if (args.dryRun) {
      process.stdout.write(`  → ${zipUrl}\n`);
      continue;
    }

    const zipDest = join('/tmp', `dawpm-scrape-${slug}.zip`);
    let hash;
    try {
      process.stdout.write(`  downloading ${zipUrl}\n`);
      hash = await downloadAndHash(zipUrl, zipDest);
    } catch (err) {
      process.stderr.write(`  ✗ ${slug}: download failed — ${(err as Error).message}\n`);
      failed++;
      continue;
    }

    const yaml = stringify({
      slug: `dsk/${slug}`,
      name: page.title,
      description: page.description,
      author: 'DSK Music',
      license: 'freeware',
      homepage: page.url,
      ...(page.image ? { image: page.image } : {}),
      tags: ['free', 'vsti', 'instrument'],
      download: {
        url: zipUrl,
        sha256: hash.sha256,
        size: hash.size,
      },
      install: [
        {
          format: 'vst',
          include: ['**/*.dll'],
          strip: 1,
        },
      ],
    });

    await mkdir(dirname(yamlPath), { recursive: true });
    await writeFile(yamlPath, yaml);
    process.stdout.write(`  ✓ wrote ${yamlPath} (${(hash.size / 1024 / 1024).toFixed(1)} MiB)\n`);
    added++;
  }

  process.stdout.write(
    `\nprocessed ${processed} · added ${added} · skipped ${skipped} (already on disk) · failed ${failed}\n`,
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
