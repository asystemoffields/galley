import mammoth from 'mammoth';
import { SCENE_BREAK_RE, type Book, type Chapter, type Run } from './model';
import { outlineToChapters, type OutlineItem } from './chapterize';
import { depthForPromotion } from './detectCentered';

const NUM_WORD =
  'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred';
const CHAPTER_NUM = String.raw`(?:\d{1,4}|[ivxlcdm]{1,8}|(?:${NUM_WORD})(?:[-\s](?:${NUM_WORD}))*)`;
const CHAPTER_LINE_RE = new RegExp(
  String.raw`^(?:(?:chapter|part|book)\s+${CHAPTER_NUM}|prologue|epilogue|interlude|foreword|preface|afterword|coda)(?:\s*[—–:.-]\s*[\w][\w\s.,:'’-]{0,38})?$`,
  'i',
);

/**
 * A standalone line like "Chapter Twelve", "PART TWO: THE RECKONING",
 * "Prologue". Only used as a chapter boundary when the document has no
 * real heading styles. Deliberately strict: "chapter/part/book" must be
 * followed by a number (digits, roman, or spelled out), and a subtitle
 * needs a separator — so narrative sentences like "Part of me wanted to
 * die." or "Book clubs were her nightmare." can't false-positive.
 */
export function isChapterLine(text: string): boolean {
  const t = text.trim().replace(/[\s.!?:]+$/, '');
  return t.length <= 48 && CHAPTER_LINE_RE.test(t);
}

export interface FlatPara {
  heading: number | null; // 1–6 for headings, null for body text
  /** Center-aligned in Word (the alignment button, not whitespace). */
  centered?: boolean;
  runs: Run[];
}

/**
 * Mammoth drops paragraph alignment by default. Tag center-aligned
 * paragraphs with a synthetic style so it survives into the HTML as a
 * class — unless the paragraph already has a real style (a heading,
 * say), which must win.
 */
const CENTERED_CLASS = 'galley-centered';

interface MammothElement {
  type?: string;
  styleId?: string;
  styleName?: string;
  alignment?: string;
  children?: MammothElement[];
}

function markCenteredParagraphs(element: MammothElement): MammothElement {
  if (element.children) {
    element = { ...element, children: element.children.map(markCenteredParagraphs) };
  }
  if (element.type === 'paragraph' && element.alignment === 'center' && !element.styleId) {
    return { ...element, styleName: CENTERED_CLASS };
  }
  return element;
}

const mammothOptions = {
  transformDocument: markCenteredParagraphs,
  styleMap: [`p[style-name='${CENTERED_CLASS}'] => p.${CENTERED_CLASS}:fresh`],
};

/** Parse a .docx file (as an ArrayBuffer) into a Book. */
export async function parseDocx(buffer: ArrayBuffer, filename: string): Promise<Book> {
  return parasToBook(await docxToParas(buffer), filename);
}

/** First half of parseDocx: flatten the file into paragraphs. */
export async function docxToParas(buffer: ArrayBuffer): Promise<FlatPara[]> {
  // Node's mammoth build reads {buffer}; the browser build reads {arrayBuffer}.
  const isNode = typeof process !== 'undefined' && !!process.versions?.node;
  const result = await mammoth.convertToHtml(
    isNode ? { buffer: Buffer.from(buffer) } : { arrayBuffer: buffer },
    mammothOptions,
  );
  return htmlToParas(result.value);
}

/**
 * Second half of parseDocx: paragraphs into a Book. `decisions` carries
 * the writer's answers about hand-centered lines, by paragraph index:
 * true promotes the paragraph to a chapter heading, false keeps it as
 * prose with the centering whitespace stripped.
 */
export function parasToBook(
  paras: FlatPara[],
  filename: string,
  decisions?: ReadonlyMap<number, boolean>,
): Book {
  if (decisions?.size) paras = applyCenteredDecisions(paras, decisions);
  const fallbackTitle = filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();

  if (paras.some((p) => p.heading !== null)) {
    const { title, chapters } = outlineToChapters(parasToOutline(paras), {
      detectTitle: true,
    });
    return { metadata: { title: title ?? fallbackTitle, author: '' }, chapters };
  }
  return { metadata: { title: fallbackTitle, author: '' }, chapters: chapterizeByLines(paras) };
}

function applyCenteredDecisions(
  paras: FlatPara[],
  decisions: ReadonlyMap<number, boolean>,
): FlatPara[] {
  const depth = depthForPromotion(
    paras.filter((p) => p.heading !== null).map((p) => p.heading!),
    paras[0]?.heading !== null && paras[0]?.heading !== undefined,
  );
  return paras.map((p, i) => {
    const isTitle = decisions.get(i);
    if (isTitle === undefined || p.heading !== null) return p;
    if (isTitle) return { heading: depth, runs: [{ text: runText(p.runs).trim() }] };
    return { ...p, runs: trimEdges(p.runs) };
  });
}

/** Strip the hand-centering whitespace off a declined candidate. */
function trimEdges(runs: Run[]): Run[] {
  const out = runs.map((r) => ({ ...r }));
  for (const r of out) {
    r.text = r.text.replace(/^[\t ]+/, '');
    if (r.text) break;
  }
  for (let i = out.length - 1; i >= 0; i--) {
    out[i].text = out[i].text.replace(/[\t ]+$/, '');
    if (out[i].text) break;
  }
  return out.filter((r) => r.text !== '');
}

function parasToOutline(paras: FlatPara[]): OutlineItem[] {
  const items: OutlineItem[] = [];
  for (const p of paras) {
    const text = runText(p.runs);
    if (SCENE_BREAK_RE.test(text)) {
      items.push({ kind: 'blocks', blocks: [{ kind: 'scene-break' }] });
    } else if (!text.trim()) {
      continue;
    } else if (p.heading !== null) {
      items.push({ kind: 'heading', depth: p.heading, text: text.trim() });
    } else {
      items.push({ kind: 'blocks', blocks: [{ kind: 'paragraph', runs: p.runs }] });
    }
  }
  return items;
}

/** No heading styles anywhere: fall back to standalone chapter-like lines. */
function chapterizeByLines(paras: FlatPara[]): Chapter[] {
  const chapters: Chapter[] = [];
  let current: Chapter = { title: '', blocks: [] };
  const flush = () => {
    if (current.title || current.blocks.length) chapters.push(current);
    current = { title: '', blocks: [] };
  };

  for (const p of paras) {
    const text = runText(p.runs);
    if (isChapterLine(text)) {
      flush();
      current.title = text.trim();
    } else if (SCENE_BREAK_RE.test(text)) {
      current.blocks.push({ kind: 'scene-break' });
    } else if (text.trim()) {
      current.blocks.push({ kind: 'paragraph', runs: p.runs });
    }
  }
  flush();
  return chapters.length ? chapters : [{ title: '', blocks: [] }];
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
        if (!closing) {
          const centered = new RegExp(`class="[^"]*\\b${CENTERED_CLASS}\\b`).test(token);
          current = centered ? { heading: null, centered, runs: [] } : { heading: null, runs: [] };
        }
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
