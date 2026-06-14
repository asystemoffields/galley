import type { Block, Chapter } from './model';

/**
 * A flattened document outline: headings (with their depth) interleaved
 * with everything else. Both parsers reduce their input to this, so the
 * decisions about what a heading *means* — book title, part, chapter,
 * or in-chapter subhead — live in one place.
 */
export type OutlineItem =
  | { kind: 'heading'; depth: number; text: string }
  | { kind: 'blocks'; blocks: Block[] };

export interface OutlineResult {
  /** Book title, when a lone shallowest heading opens the document. */
  title?: string;
  chapters: Chapter[];
}

/**
 * Split an outline into chapters.
 *
 * - A heading level that occurs exactly once, opens the document, and has
 *   deeper headings below it is the book title, not a one-chapter book
 *   (`detectTitle`).
 * - If the shallowest remaining level occurs 2+ times and every one of its
 *   sections contains deeper headings, those are part titles ("Part Two",
 *   or just a name) and the deeper level is the chapters. Books with
 *   occasional in-chapter subheads don't match, because most chapters
 *   have no deeper headings at all.
 * - Otherwise the shallowest level is the chapters (the historical rule).
 * - Headings deeper than the chapter level become bold paragraphs.
 */
export function outlineToChapters(
  items: OutlineItem[],
  opts: { detectTitle?: boolean } = {},
): OutlineResult {
  const work = [...items];
  let title: string | undefined;

  const headingDepths = () =>
    work.filter((i) => i.kind === 'heading').map((i) => i.depth);

  if (opts.detectTitle) {
    const depths = headingDepths();
    const first = work[0];
    if (
      depths.length >= 2 &&
      first?.kind === 'heading' &&
      first.depth === Math.min(...depths) &&
      depths.filter((d) => d === first.depth).length === 1
    ) {
      title = first.text;
      work.shift();
    }
  }

  const depths = [...new Set(headingDepths())].sort((a, b) => a - b);
  let partDepth: number | null = null;
  let chapterDepth: number | null = depths[0] ?? null;
  if (depths.length >= 2 && isPartShaped(work, depths[0], depths[1])) {
    partDepth = depths[0];
    chapterDepth = depths[1];
  }

  const chapters: Chapter[] = [];
  let part: string | undefined;
  let current: Chapter | null = null;
  const ensure = () => (current ??= { title: '', blocks: [], part });
  const flush = () => {
    if (current && (current.title || current.blocks.length)) chapters.push(current);
    current = null;
  };

  for (const item of work) {
    if (item.kind === 'heading') {
      if (item.depth === partDepth) {
        flush();
        part = item.text;
        continue;
      }
      if (item.depth === chapterDepth) {
        flush();
        current = { title: item.text, blocks: [], part };
        continue;
      }
      ensure().blocks.push({ kind: 'paragraph', runs: [{ text: item.text, bold: true }] });
      continue;
    }
    ensure().blocks.push(...item.blocks);
  }
  flush();
  return { title, chapters: chapters.length ? chapters : [{ title: '', blocks: [] }] };
}

/**
 * Are these two heading levels shaped like parts-containing-chapters?
 * Every section opened by a `partDepth` heading must contain at least one
 * `chapterDepth` heading, and at least one section must contain two or
 * more — otherwise a book that simply opens every chapter with a single
 * subhead (a diary's dates, a thriller's locations) would be misread as
 * parts, turning its chapters into part titles and its subheads into the
 * chapters.
 */
function isPartShaped(items: OutlineItem[], partDepth: number, chapterDepth: number): boolean {
  let sections = 0;
  let sectionsWithChapters = 0;
  let maxChaptersInSection = 0;
  let open = false;
  let chaptersHere = 0;
  const close = () => {
    if (!open) return;
    sections += 1;
    if (chaptersHere > 0) sectionsWithChapters += 1;
    maxChaptersInSection = Math.max(maxChaptersInSection, chaptersHere);
  };
  for (const item of items) {
    if (item.kind !== 'heading') continue;
    if (item.depth === partDepth) {
      close();
      open = true;
      chaptersHere = 0;
    } else if (open && item.depth === chapterDepth) {
      chaptersHere += 1;
    }
  }
  close();
  return sections >= 2 && sectionsWithChapters === sections && maxChaptersInSection >= 2;
}
