import { parseMarkdown, parseDocx, type Book } from '../core';

const MARKDOWN_EXT = /\.(md|markdown|mdown|txt)$/i;
const DOCX_EXT = /\.docx$/i;

export class IngestError extends Error {}

/** Turn whatever the writer dropped on us into a Book. */
export async function ingestFiles(files: File[]): Promise<Book> {
  const markdownFiles = files.filter((f) => MARKDOWN_EXT.test(f.name));
  const docxFiles = files.filter((f) => DOCX_EXT.test(f.name));

  if (docxFiles.length > 0) {
    if (docxFiles.length > 1) {
      throw new IngestError(
        'You dropped more than one Word document. Galley can read one .docx at a time — pick the one with the whole book in it.',
      );
    }
    const buffer = await docxFiles[0].arrayBuffer();
    return parseDocx(buffer, docxFiles[0].name);
  }

  if (markdownFiles.length > 0) {
    const named = await Promise.all(
      markdownFiles.map(async (f) => ({ name: f.name, content: await f.text() })),
    );
    return parseMarkdown(named);
  }

  throw new IngestError(
    "That file type stumped us. Galley reads Markdown (.md, .txt) and Word documents (.docx). If your book lives somewhere else, try exporting it as .docx first — that almost always works.",
  );
}
