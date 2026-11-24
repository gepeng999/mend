// main.ts is mend, the CLI SPEC.md specifies (MIT). It reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three matching tiers,
// and writes every change or none, printing what it changed or why it failed. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): that hand-over and runner.ts stay as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits that succeeded, old path to new path, for the `R` output line. */
  readonly moves = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file's lines under its own line break (SPEC.md section 3). */
interface FileLines {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitText(text: string): FileLines {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, fin: false };
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function joinText(fl: FileLines): string {
  if (fl.lines.length === 0) return '';
  return fl.lines.join(fl.br) + (fl.fin ? fl.br : '');
}

/** Matching (SPEC.md section 5): the transform a tier applies to both sides before comparing. */
function tierFn(tier: number): (s: string) => string {
  if (tier === 0) return (s) => s;
  if (tier === 1) return (s) => s.replace(/[ \t]+$/, '');
  return (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every start position where O occurs in lines at the given tier; occurrences may overlap. */
function occurrences(lines: string[], O: string[], tier: number): number[] {
  if (O.length === 0) return [];
  const f = tierFn(tier);
  const want = O.map(f);
  const out: number[] = [];
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (f(lines[i + j]!) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its occurrence positions there. */
function findTier(lines: string[], O: string[], strict: boolean, from = 0): { tier: number; at: number[] } | null {
  for (const t of strict ? [0] : [0, 1, 2]) {
    const at = occurrences(lines, O, t).filter((i) => i >= from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** A line of N: its text, and for a context line its index in O (the file's own line is written), else -1. */
interface NLine {
  text: string;
  ctx: number;
}

/** The lines N writes when O matched at `at` under `tier` (SPEC.md section 5). */
function writtenLines(lines: string[], at: number, O: string[], N: NLine[], tier: number): string[] {
  let leadF = '';
  let leadP = '';
  if (tier === 2 && O.length > 0) {
    leadF = /^[ \t]*/.exec(lines[at] ?? '')![0];
    leadP = /^[ \t]*/.exec(O[0]!)![0];
  }
  return N.map((n) => {
    if (n.ctx >= 0) return lines[at + n.ctx]!;
    if (tier === 2 && n.text.trim() !== '' && n.text.startsWith(leadP)) return leadF + n.text.slice(leadP.length);
    return n.text;
  });
}

/** lines with the O.length lines at `at` replaced by what N writes. */
function applyMatch(lines: string[], at: number, O: string[], N: NLine[], tier: number): string[] {
  const w = writtenLines(lines, at, O, N, tier);
  return [...lines.slice(0, at), ...w, ...lines.slice(at + O.length)];
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const fl = splitText(before);
      if (line < 0 || line > fl.lines.length) throw new Fail('no-match', p);
      const lines = [...fl.lines.slice(0, line), ...add, ...fl.lines.slice(line)];
      tree.now.set(p, joinText({ lines, br: fl.br, fin: fl.fin }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A hunk body line: context, old, new, or the `\` no-newline marker. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bsl';
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

/** O (context and old lines) and N (context and new lines) of a hunk or chunk body. */
function bodyON(body: BodyLine[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      O.push(b.text);
      N.push({ text: b.text, ctx: O.length - 1 });
    } else if (b.kind === 'old') O.push(b.text);
    else if (b.kind === 'new') N.push({ text: b.text, ctx: -1 });
  }
  return { O, N };
}

/** True when a `\` marker immediately follows the body's last context or new line. */
function markerAfterLast(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') return body[i + 1]?.kind === 'bsl';
  }
  return false;
}

/** Unified diffs (SPEC.md section 6). */

interface USec {
  diffOld?: string;
  diffNew?: string;
  pairOld?: string | null;
  pairNew?: string | null;
  hasPair: boolean;
  renOld?: string;
  renNew?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function headerPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Apply one section's hunks, in order, to a file's lines; `path` names match failures. */
function applyHunks(fl: FileLines, hunks: Hunk[], strict: boolean, path: string): FileLines {
  let lines = fl.lines;
  let fin = fl.fin;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = bodyON(h.body);
    if (O.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), lines.length);
      const w = N.map((n) => n.text);
      const atEnd = pos === lines.length;
      lines = [...lines.slice(0, pos), ...w, ...lines.slice(pos)];
      if (atEnd) fin = !markerAfterLast(h.body);
      d += N.length;
    } else {
      const found = findTier(lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.at[0]!;
      let bd = Math.abs(best - target);
      for (const p of found.at) {
        const dd = Math.abs(p - target);
        if (dd < bd) {
          bd = dd;
          best = p;
        }
      }
      const touchesEnd = best + O.length === lines.length;
      lines = applyMatch(lines, best, O, N, found.tier);
      if (touchesEnd) fin = !markerAfterLast(h.body);
      d += N.length - O.length;
    }
  }
  return { lines, br: fl.br, fin };
}

function unifiedEdit(sec: USec, strict: boolean): Edit {
  const oldP: string | null = sec.hasPair ? sec.pairOld! : sec.renOld !== undefined ? sec.renOld : sec.diffOld!;
  const newP: string | null = sec.hasPair ? sec.pairNew! : sec.renNew !== undefined ? sec.renNew : sec.diffNew!;
  const isCreate = oldP === null || sec.newFile;
  const isDelete = newP === null || sec.delFile;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      if (newP === null) throw new Fail('missing', oldP ?? '');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out: string[] = [];
      let fin = true;
      for (const h of sec.hunks) {
        for (let i = 0; i < h.body.length; i++) {
          if (h.body[i]!.kind === 'new') {
            out.push(h.body[i]!.text);
            fin = h.body[i + 1]?.kind !== 'bsl';
          }
        }
      }
      tree.now.set(newP, out.length === 0 ? '' : out.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (oldP === null || tree.get(oldP) === null) throw new Fail('missing', oldP ?? '');
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null || newP === null) throw new Fail('missing', oldP ?? newP ?? '');
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (oldP !== newP) {
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const text = sec.hunks.length === 0 ? before : joinText(applyHunks(splitText(before), sec.hunks, strict, oldP));
      tree.now.set(oldP, null);
      tree.now.set(newP, text);
      tree.moves.set(oldP, newP);
      return;
    }
    if (sec.hunks.length === 0) return;
    tree.now.set(oldP, joinText(applyHunks(splitText(before), sec.hunks, strict, oldP)));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const secs: USec[] = [];
  let sec: USec | null = null;
  let hunk: Hunk | null = null;
  const newSec = (): USec => {
    const s: USec = { hasPair: false, newFile: false, delFile: false, hunks: [] };
    secs.push(s);
    sec = s;
    hunk = null;
    return s;
  };
  const closeHunk = (): void => {
    if (hunk !== null && sec !== null) {
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '' && (last as BodyLine & { rawEmpty?: boolean }).rawEmpty) hunk.body.pop();
        else break;
      }
      sec.hunks.push(hunk);
    }
    hunk = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      closeHunk();
      const s = newSec();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      closeHunk();
      if (sec === null || sec.hasPair || sec.hunks.length > 0) newSec();
      sec!.pairOld = headerPath(line.slice(4));
      sec!.pairNew = headerPath(lines[i + 1]!.slice(4));
      sec!.hasPair = true;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      closeHunk();
      hunk = { a: Number(m[1]), body: [] };
      continue;
    }
    if (hunk !== null) {
      const c = line[0];
      if (line === '') {
        hunk.body.push({ kind: 'ctx', text: '', rawEmpty: true } as BodyLine & { rawEmpty: boolean });
        continue;
      }
      if (c === ' ' || c === '-' || c === '+' || c === '\\') {
        hunk.body.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'old' : c === '+' ? 'new' : 'bsl', text: line.slice(1) });
        continue;
      }
      closeHunk();
    }
    if (sec !== null && sec.hunks.length === 0 && hunk === null) {
      // The section's header, before its first hunk.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ') && !sec.hasPair) {
        sec.pairNew = headerPath(line.slice(4));
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renOld = line.slice('rename from '.length).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renNew = line.slice('rename to '.length).trim();
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.newFile = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.delFile = true;
        continue;
      }
    }
    // Anything else is ignored: prose and fences outside bodies and headers.
  }
  closeHunk();
  if (secs.length === 0) throw new Exit2('error: parse 1');
  return secs.map((s) => unifiedEdit(s, strict));
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */

function srEdit(path: string, oldL: string[], newL: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldL.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newL.length === 0 ? '' : newL.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const fl = splitText(before);
    const found = findTier(fl.lines, oldL, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const N: NLine[] = newL.map((t) => ({ text: t, ctx: -1 }));
    tree.now.set(path, joinText({ lines: applyMatch(fl.lines, found.at[0]!, oldL, N, found.tier), br: fl.br, fin: fl.fin }));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let j = i - 1; j >= searchFrom; j--) {
      const l = lines[j]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${i + 1}`);
    let gt = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        gt = j;
        break;
      }
    }
    if (gt < 0) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, gt), strict));
    prevPath = path;
    searchFrom = gt + 1;
    i = gt + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** V4A patches (SPEC.md section 8). */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSec {
  kind: 'add' | 'del' | 'upd';
  path: string;
  headerLine: number;
  addLines: string[];
  moveTo?: string;
  chunks: VChunk[];
}

function v4aEdit(sec: VSec, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== undefined && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== undefined && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    let fl = splitText(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        let ai = -1;
        for (const t of strict ? [0] : [0, 1, 2]) {
          const f = tierFn(t);
          const want = f(ch.anchor);
          for (let k = cursor; k < fl.lines.length; k++) {
            if (f(fl.lines[k]!) === want) {
              ai = k;
              break;
            }
          }
          if (ai >= 0) break;
        }
        if (ai < 0) throw new Fail('no-match', sec.path);
        cursor = ai + 1;
      }
      const { O, N } = bodyON(ch.body);
      if (O.length === 0) {
        const pos = ch.eof ? fl.lines.length : Math.min(cursor, fl.lines.length);
        const w = N.map((n) => n.text);
        fl = { lines: [...fl.lines.slice(0, pos), ...w, ...fl.lines.slice(pos)], br: fl.br, fin: fl.fin };
        cursor = pos + w.length;
        continue;
      }
      let placed = false;
      for (const t of strict ? [0] : [0, 1, 2]) {
        let cand = occurrences(fl.lines, O, t).filter((k) => k >= cursor);
        if (ch.eof) cand = cand.filter((k) => k + O.length === fl.lines.length);
        if (cand.length > 0) {
          const at = cand[0]!;
          fl = { lines: applyMatch(fl.lines, at, O, N, t), br: fl.br, fin: fl.fin };
          cursor = at + N.length;
          placed = true;
          break;
        }
      }
      if (!placed) throw new Fail('no-match', sec.path);
    }
    if (sec.moveTo !== undefined) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, joinText(fl));
      tree.moves.set(sec.path, sec.moveTo);
    } else {
      tree.now.set(sec.path, joinText(fl));
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  // Split the region between Begin and End into raw sections, dropping each section's trailing blank lines.
  interface Raw {
    sec: VSec;
    raw: { line: string; no: number }[];
  }
  const raws: Raw[] = [];
  let cur: Raw | null = null;
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    const m = /^\*\*\* (Add File|Delete File|Update File): /.exec(line);
    if (m !== null) {
      const kind = m[1] === 'Add File' ? 'add' : m[1] === 'Delete File' ? 'del' : 'upd';
      cur = { sec: { kind, path: line.slice(m[0].length).trim(), headerLine: i + 1, addLines: [], chunks: [] }, raw: [] };
      raws.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    cur.raw.push({ line, no: i + 1 });
  }
  for (const { sec, raw } of raws) {
    while (raw.length > 0 && blank(raw[raw.length - 1]!.line)) raw.pop();
    if (sec.kind === 'add') {
      for (const r of raw) {
        if (r.line.startsWith('+')) sec.addLines.push(r.line.slice(1));
        else if (r.line === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
    } else if (sec.kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
    } else {
      let chunk: VChunk | null = null;
      let firstLine = true;
      for (const r of raw) {
        if (firstLine && r.line.startsWith('*** Move to: ')) {
          sec.moveTo = r.line.slice('*** Move to: '.length).trim();
          firstLine = false;
          continue;
        }
        firstLine = false;
        if (r.line.startsWith('@@')) {
          chunk = { anchor: r.line.slice(2).trim() === '' ? null : r.line.slice(2).trim(), eof: false, body: [] };
          sec.chunks.push(chunk);
          continue;
        }
        if (r.line === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, eof: true, body: [] };
            sec.chunks.push(chunk);
          } else chunk.eof = true;
          continue;
        }
        const c = r.line[0];
        if (r.line === '' || c === ' ' || c === '-' || c === '+') {
          if (chunk === null) {
            chunk = { anchor: null, eof: false, body: [] };
            sec.chunks.push(chunk);
          }
          chunk.body.push({ kind: r.line === '' || c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new', text: r.line.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${r.no}`);
      }
      if (sec.chunks.length === 0 && sec.moveTo === undefined) throw new Exit2(`error: parse ${sec.headerLine}`);
    }
  }
  if (raws.length === 0) throw new Exit2('error: parse 1');
  return raws.map((r) => v4aEdit(r.sec, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  const byNew = new Map<string, string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null) byNew.set(n, o);
  }
  const rows: { key: string; text: string }[] = [];
  const consumed = new Set<string>();
  for (const p of changed) {
    if (byNew.has(p)) {
      rows.push({ key: p, text: `R ${byNew.get(p)!} -> ${p}` });
      consumed.add(byNew.get(p)!);
      consumed.add(p);
    }
  }
  for (const p of changed) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
