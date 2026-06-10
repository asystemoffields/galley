import {
  applyCenteredDecisions,
  depthForPromotion,
  docxToParas,
  findCenteredLines,
  findCenteredTexts,
  firstContentIsHeading,
  headingDepths,
  parasToBook,
  parseMarkdown,
  type Book,
} from '../core';

const MARKDOWN_EXT = /\.(md|markdown|mdown|txt)$/i;
const DOCX_EXT = /\.docx$/i;

export class IngestError extends Error {}

/** A hand-centered line we'd like the writer to confirm as a chapter title. */
export interface TitleCandidate {
  id: string;
  text: string;
  before?: string;
  after?: string;
}

export interface IngestResult {
  book: Book;
  /**
   * Empty when the book is ready to use. Otherwise, ask the writer about
   * each candidate and call ingestFiles again with their answers.
   */
  candidates: TitleCandidate[];
}

/**
 * Turn whatever the writer dropped on us into a Book. Without `decisions`
 * this also reports hand-centered lines that might be chapter titles;
 * pass the writer's answers (candidate id → is it a title?) on the second
 * call to fold them in.
 */
export async function ingestFiles(
  files: File[],
  decisions?: ReadonlyMap<string, boolean>,
): Promise<IngestResult> {
  const markdownFiles = files.filter((f) => MARKDOWN_EXT.test(f.name));
  const docxFiles = files.filter((f) => DOCX_EXT.test(f.name));

  if (docxFiles.length > 0) {
    if (docxFiles.length > 1) {
      throw new IngestError(
        'You dropped more than one Word document. Galley can read one .docx at a time — pick the one with the whole book in it.',
      );
    }
    const paras = await docxToParas(await docxFiles[0].arrayBuffer());
    const texts = paras.map((p) => p.runs.map((r) => r.text).join(''));
    const found = findCenteredTexts(texts, {
      eligible: (i) => paras[i].heading === null,
      aligned: (i) => !!paras[i].centered,
    });
    const byIndex = new Map<number, boolean>();
    const candidates: TitleCandidate[] = [];
    for (const c of found) {
      const id = `docx:${c.index}`;
      const answer = decisions?.get(id);
      if (answer !== undefined) byIndex.set(c.index, answer);
      candidates.push({ id, text: c.text, before: c.before, after: c.after });
    }
    return {
      book: parasToBook(paras, docxFiles[0].name, byIndex),
      candidates: decisions ? [] : candidates,
    };
  }

  if (markdownFiles.length > 0) {
    const named = await Promise.all(
      markdownFiles.map(async (f) => ({ name: f.name, content: await f.text() })),
    );
    // Same order parseMarkdown reads them in, so the review walks the book.
    named.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const candidates: TitleCandidate[] = [];
    const prepared = named.map((f) => {
      const found = findCenteredLines(f.content);
      if (found.length === 0) return f;
      const byLine = new Map<number, boolean>();
      for (const c of found) {
        const id = `${f.name}:${c.index}`;
        const answer = decisions?.get(id);
        if (answer !== undefined) byLine.set(c.index, answer);
        candidates.push({ id, text: c.text, before: c.before, after: c.after });
      }
      if (byLine.size === 0) return f;
      const depth = depthForPromotion(headingDepths(f.content), firstContentIsHeading(f.content));
      return { name: f.name, content: applyCenteredDecisions(f.content, byLine, depth) };
    });
    return { book: parseMarkdown(prepared), candidates: decisions ? [] : candidates };
  }

  throw new IngestError(
    "That file type stumped us. Galley reads Markdown (.md, .txt) and Word documents (.docx). If your book lives somewhere else, try exporting it as .docx first — that almost always works.",
  );
}
