#!/usr/bin/env node
/**
 * one-off cleanup pass over the dsk yaml files.
 *
 * - Normalize descriptions: collapse "–" / "—" separators into sentences,
 *   strip trailing junk, fix the recurring "whit" typo, drop emoji,
 *   capitalize first letter, ensure trailing period.
 * - Re-derive tags from the full description and plugin name using a
 *   broader keyword map than the original scraper so things like "synth",
 *   "pad", "drum", etc. actually land on the right plugins.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

const ROOT = new URL('../src/plugins/dsk/', import.meta.url).pathname;

const TAG_RULES: Array<[string, RegExp]> = [
  ['synth', /\b(synth|synthesi[sz]er|oscillator|osc\b|waveform|lfo|adsr|filter)\b/i],
  ['drums', /\b(drum|drumz|drumkit|beat\s*box|kick|snare|cymbal|percussion)\b/i],
  ['piano', /\b(piano|grand|rhodes|rhodez|electric piano|epiano|wurlitzer)\b/i],
  ['keys', /\b(key|keyz|organ|harpsichord|clavinet|celesta|hammond|b3|b3x)\b/i],
  ['guitar', /\b(guitar|guitarz|nylon|steel string|acoustic guitar|electric guitar)\b/i],
  ['bass', /\b(bass|bassz|sub bass|sub-bass)\b/i],
  ['strings', /\b(string|stringz|violin|viola|cello|harp|orchestra|orchestral|ensemble)\b/i],
  ['brass', /\b(brass|trumpet|trombone|tuba|french horn|sax|saxophone|saxophonez)\b/i],
  ['woodwind', /\b(flute|piccolo|clarinet|oboe|bassoon|harmonica)\b/i],
  ['choir', /\b(choir|choirz|vocal|voice|voices)\b/i],
  ['pad', /\b(pad|padz|texture|ambient|atmospher)/i],
  ['fx', /\b(sound\s*fx|effects?|sfx|impact|riser|sweep)\b/i],
  ['rompler', /\b(rompler|sample\s*player|soundfont|sf2)\b/i],
  ['world', /\b(world|ethnic|asian|indian|sitar|erhu|kanun|cumbus|dobro|celtic)\b/i],
  ['drum-machine', /\b(drum\s*machine|808|909|vintage drum)\b/i],
];

function cleanDescription(raw: string): string {
  let s = raw;
  // unify dash separators
  s = s.replace(/\s*[–—]\s*/g, '. ');
  s = s.replace(/\s*\.\.+\s*/g, '. ');
  // common typos
  s = s.replace(/\bwhit\b/gi, 'with');
  s = s.replace(/\bfintunnig\b/gi, 'finetuning');
  s = s.replace(/\bfinetunning\b/gi, 'finetuning');
  // strip emoji and asterisks
  s = s.replace(/[*]/g, '');
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');
  // collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  // drop trailing dangling separators / punctuation / open parens / ellipsis
  s = s.replace(/[\(\s.\-:,;…]+$/g, '');
  // close stray opening parens with the right number of close parens
  const opens = (s.match(/\(/g) ?? []).length;
  const closes = (s.match(/\)/g) ?? []).length;
  if (opens > closes) s += ')'.repeat(opens - closes);
  // first-letter cap
  if (s.length > 0) s = s[0].toUpperCase() + s.slice(1);
  // ensure period
  if (s.length > 0 && !/[.!?]$/.test(s)) s += '.';
  return s;
}

function deriveTags(name: string, description: string, existing: string[]): string[] {
  const haystack = `${name} ${description}`;
  const found = new Set<string>(['free', 'vsti']);
  for (const [tag, re] of TAG_RULES) {
    if (re.test(haystack)) found.add(tag);
  }
  // keep any custom tags the maintainer may have added
  for (const t of existing) found.add(t);
  return [...found].sort();
}

let touched = 0;
for (const dir of readdirSync(ROOT)) {
  const file = join(ROOT, dir, 'index.yaml');
  const src = readFileSync(file, 'utf8');
  const doc = YAML.parse(src) as {
    name: string;
    description: string;
    tags?: string[];
  };

  const newDesc = cleanDescription(doc.description ?? '');
  const newTags = deriveTags(doc.name, newDesc, doc.tags ?? []);

  if (newDesc === doc.description && JSON.stringify(newTags) === JSON.stringify(doc.tags ?? [])) {
    continue;
  }

  doc.description = newDesc;
  doc.tags = newTags;
  writeFileSync(file, YAML.stringify(doc, { lineWidth: 100 }));
  touched++;
  console.log(`fixed ${dir}`);
}

console.log(`\ndone: ${touched}/${readdirSync(ROOT).length} updated`);
