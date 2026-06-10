import mammoth from 'mammoth';
import type { Block, Book, Chapter, Run } from './model';

const SCENE_BREAK_RE = /^\s*(?:#|\*\s*\*\s*\*|\* \* \*|~+|·+)\s*$/;

/**
 * A standalone short line like "Chapter Twelve", "PART TWO", "Prologue".
 * Only used as a chapter boundary when the document has no real heading
 * styles, so a sentence mentioning a chapter can't false-positive.
 */
const CHAPTER_LINE_RE =
  /^\s*(chapter|part|book|prologue|epilogue|interlude)\b[\s\w.:'’-]{0,40}$/i;

interface FlatPara {
  heading: number | null; // 1–6 for headings, null for body text
  runs: Run[];
}

/** Parse a .docx file (as an ArrayBuffer) into a Book. */
export async function parseDocx(buffer: ArrayBuffer, filename: string): Promise<Book> {
  // Node's mammoth build reads {buffer}; the browser build reads {arrayBuffer}.
  const isNode = typeof process !== 'undefined' && !!process.versions?.node;
  const result = await mammoth.convertToHtml(
    isNode ? { buffer: Buffer.from(buffer) } : { arrayBuffer: buffer },
  );
  const paras = htmlToParas(result.value);
  const chapters = chapterize(paras);
  return {
    metadata: {
      title: filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim(),
      author: '',
    },
    chapters,
  };
}

function chapterize(paras: FlatPara[]): Chapter[] {
  const headingDepths = paras
    .filter((p) => p.heading !== null)
    .map((p) => p.heading as number);
  const splitDepth = headingDepths.length ? Math.min(...headingDepths) : null;

  const isBoundary = (p: FlatPara): boolean => {
    if (splitDepth !== null) return p.heading === splitDepth;
    const text = runText(p.runs).trim();
    return CHAPTER_LINE_RE.test(text) && text.length <= 48;
  };

  const chapters: Chapter[] = [];
  let current: Chapter = { title: '', blocks: [] };
  const flush = () => {
    if (current.title || current.blocks.length) chapters.push(current);
    current = { title: '', blocks: [] };
  };

  for (const p of paras) {
    if (isBoundary(p)) {
      flush();
      current.title = runText(p.runs).trim();
      continue;
    }
    const block = paraToBlock(p);
    if (block) current.blocks.push(block);
  }
  flush();
  return chapters.length ? chapters : [{ title: '', blocks: [] }];
}

function paraToBlock(p: FlatPara): Block | null {
  const text = runText(p.runs);
  if (SCENE_BREAK_RE.test(text)) return { kind: 'scene-break' };
  if (!text.trim()) return null;
  if (p.heading !== null) {
    return { kind: 'paragraph', runs: [{ text: text.trim(), bold: true }] };
  }
  return { kind: 'paragraph', runs: p.runs };
}

function runText(runs: Run[]): string {
  return runs.map((r) => r.text).join('');
}

/**
 * Minimal walker for mammoth's simple, well-formed HTML output
 * (h1–h6, p, em/i, strong/b, br, a, lists). No DOM needed, so it
 * runs identically in the browser and in tests.
 */
export function htmlToParas(html: string): FlatPara[] {
  const paras: FlatPara[] = [];
  let current: FlatPara | null = null;
  let italic = 0;
  let bold = 0;

  const finish = (p: FlatPara | null): null => {
    if (p && runText(p.runs).trim() !== '') {
      p.runs = mergeRuns(p.runs);
      paras.push(p);
    }
    return null;
  };

  for (const token of html.split(/(<[^>]+>)/)) {
    if (!token) continue;
    if (token.startsWith('<')) {
      const m = /^<\s*(\/?)\s*([a-zA-Z0-9]+)/.exec(token);
      if (!m) continue;
      const closing = m[1] === '/';
      const tag = m[2].toLowerCase();
      const h = /^h([1-6])$/.exec(tag);
      if (h) {
        current = finish(current);
        if (!closing) current = { heading: Number(h[1]), runs: [] };
      } else if (tag === 'p' || tag === 'li') {
        current = finish(current);
        if (!closing) current = { heading: null, runs: [] };
      } else if (tag === 'em' || tag === 'i') {
        italic = Math.max(0, italic + (closing ? -1 : 1));
      } else if (tag === 'strong' || tag === 'b') {
        bold = Math.max(0, bold + (closing ? -1 : 1));
      } else if (tag === 'br') {
        current?.runs.push({ text: ' ', italic: italic > 0, bold: bold > 0 });
      }
      continue;
    }
    const text = decodeEntities(token);
    if (current && text) {
      current.runs.push({ text, italic: italic > 0, bold: bold > 0 });
    }
  }
  finish(current);
  return paras;
}

function mergeRuns(runs: Run[]): Run[] {
  const merged: Run[] = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    if (prev && !!prev.italic === !!run.italic && !!prev.bold === !!run.bold) {
      prev.text += run.text;
    } else {
      merged.push({ ...run });
    }
  }
  return merged.filter((r) => r.text !== '');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
