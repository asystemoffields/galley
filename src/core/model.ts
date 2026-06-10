/**
 * The intermediate representation every input parses into and every
 * output is generated from. Deliberately small: prose is paragraphs
 * of styled runs, plus scene breaks. Anything an input format gives
 * us beyond that gets flattened into this.
 */

export interface Run {
  text: string;
  italic?: boolean;
  bold?: boolean;
}

export type Block =
  | { kind: 'paragraph'; runs: Run[] }
  | { kind: 'scene-break' };

export interface Chapter {
  /** Display title, e.g. "Chapter One" or "The Long Walk". May be empty for untitled. */
  title: string;
  /**
   * Title of the part/section this chapter belongs to, for books divided
   * into named parts. Consecutive chapters sharing a part value are one
   * part; emitters render a part page where the value changes.
   */
  part?: string;
  blocks: Block[];
}

export interface BookMetadata {
  /** The book's title. */
  title: string;
  /** Byline — the name the author publishes under (may be a pen name). */
  author: string;
  /** Legal name for the manuscript contact block, if different from byline. */
  legalName?: string;
  /** Contact details for the manuscript's first page. All optional. */
  address?: string;
  email?: string;
  phone?: string;
  /** BCP 47 language tag for the EPUB. Defaults to "en". */
  language?: string;
}

export interface Book {
  metadata: BookMetadata;
  chapters: Chapter[];
}

/** Paragraphs that are really scene-break markers writers type by hand. */
export const SCENE_BREAK_RE = /^\s*(?:#|\*\s*\*\s*\*|\* \* \*|~+|·+)\s*$/;

/** Plain text of a block, for word counts and previews. */
export function blockText(block: Block): string {
  if (block.kind !== 'paragraph') return '';
  return block.runs.map((r) => r.text).join('');
}

/** Actual word count across the whole book. */
export function wordCount(book: Book): number {
  let count = 0;
  for (const chapter of book.chapters) {
    for (const block of chapter.blocks) {
      const text = blockText(block).trim();
      if (text) count += text.split(/\s+/).length;
    }
  }
  return count;
}

/**
 * Word count as it appears on a manuscript's first page. Convention:
 * round to the nearest 100 for shorter works, nearest 1,000 for
 * novel-length (40k+) works.
 */
export function manuscriptWordCount(book: Book): number {
  const exact = wordCount(book);
  const step = exact >= 40_000 ? 1000 : 100;
  return Math.max(step, Math.round(exact / step) * step);
}
