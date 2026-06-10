import {
  AlignmentType,
  Document,
  Header,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  BorderStyle,
} from 'docx';
import type { Book, Run } from './model';
import { manuscriptWordCount } from './model';

export interface DocxOptions {
  /** Underline instead of italics — the old-school convention some markets still ask for. */
  underlineItalics?: boolean;
}

const TWIPS_PER_INCH = 1440;
const DOUBLE = 480; // double spacing, in 240ths of a line
const SINGLE = 240;

const NO_BORDER = {
  style: BorderStyle.NONE,
  size: 0,
  color: 'FFFFFF',
} as const;
const NO_BORDERS = {
  top: NO_BORDER,
  bottom: NO_BORDER,
  left: NO_BORDER,
  right: NO_BORDER,
} as const;

/**
 * Build a standard manuscript format (Shunn) Word document:
 * 1" margins, 12pt Times New Roman, double-spaced, half-inch paragraph
 * indents, contact block and rounded word count on page one, title a
 * third of the way down, and a "Surname / TITLE / page" header from
 * page two onward.
 */
export function emitDocx(book: Book, options: DocxOptions = {}): Document {
  const meta = book.metadata;
  const surname = lastName(meta.legalName || meta.author || 'Author');
  const headerTitle = shortTitle(meta.title);

  const children: (Paragraph | Table)[] = [
    contactAndWordCount(book),
    ...titleBlock(book),
  ];

  const isNovel = book.chapters.length > 1;
  let currentPart: string | undefined;
  book.chapters.forEach((chapter, index) => {
    if (chapter.part && chapter.part !== currentPart) {
      currentPart = chapter.part;
      children.push(...partHeading(chapter.part));
    }
    if (isNovel) {
      children.push(...chapterHeading(chapter.title || `Chapter ${index + 1}`));
    } else if (index === 0) {
      children.push(blank());
    }
    for (const block of chapter.blocks) {
      if (block.kind === 'scene-break') {
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            indent: { firstLine: 0 },
            children: [new TextRun('#')],
          }),
        );
      } else {
        children.push(
          new Paragraph({
            children: block.runs.map((r) => textRun(r, options)),
          }),
        );
      }
    }
  });

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      indent: { firstLine: 0 },
      spacing: { before: DOUBLE },
      children: [new TextRun('END')],
    }),
  );

  return new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Times New Roman', size: 24 }, // 12pt
          paragraph: {
            spacing: { line: DOUBLE },
            indent: { firstLine: TWIPS_PER_INCH / 2 },
          },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            // US Letter — the docx library defaults to A4, but standard
            // manuscript format is a US convention.
            size: { width: 8.5 * TWIPS_PER_INCH, height: 11 * TWIPS_PER_INCH },
            margin: {
              top: TWIPS_PER_INCH,
              bottom: TWIPS_PER_INCH,
              left: TWIPS_PER_INCH,
              right: TWIPS_PER_INCH,
            },
          },
          titlePage: true, // no header on page one
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                indent: { firstLine: 0 },
                spacing: { line: SINGLE },
                children: [
                  new TextRun(`${surname} / ${headerTitle} / `),
                  new TextRun({ children: [PageNumber.CURRENT] }),
                ],
              }),
            ],
          }),
          first: new Header({ children: [] }),
        },
        children,
      },
    ],
  });
}

function textRun(run: Run, options: DocxOptions): TextRun {
  const italicAs = options.underlineItalics
    ? { underline: run.italic ? {} : undefined }
    : { italics: run.italic || undefined };
  return new TextRun({
    text: run.text,
    bold: run.bold || undefined,
    ...italicAs,
  });
}

/** Page one, top: contact block on the left, word count on the right. */
function contactAndWordCount(book: Book): Table {
  const meta = book.metadata;
  const contactLines = [
    meta.legalName || meta.author || '',
    ...(meta.address ? meta.address.split(/\n/) : []),
    meta.email ?? '',
    meta.phone ?? '',
  ].filter(Boolean);

  const single = (
    text: string,
    alignment: (typeof AlignmentType)[keyof typeof AlignmentType] = AlignmentType.LEFT,
  ) =>
    new Paragraph({
      alignment,
      indent: { firstLine: 0 },
      spacing: { line: SINGLE },
      children: [new TextRun(text)],
    });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { ...NO_BORDERS, insideHorizontal: NO_BORDER, insideVertical: NO_BORDER },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            borders: NO_BORDERS,
            children: contactLines.length ? contactLines.map((l) => single(l)) : [single('')],
          }),
          new TableCell({
            borders: NO_BORDERS,
            children: [
              single(
                `about ${manuscriptWordCount(book).toLocaleString('en-US')} words`,
                AlignmentType.RIGHT,
              ),
            ],
          }),
        ],
      }),
    ],
  });
}

/** Title a third of the way down page one, byline beneath it. */
function titleBlock(book: Book): Paragraph[] {
  const meta = book.metadata;
  return [
    ...Array.from({ length: 8 }, () => blank()),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      indent: { firstLine: 0 },
      children: [new TextRun(meta.title || 'Untitled')],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      indent: { firstLine: 0 },
      children: [new TextRun(`by ${meta.author || 'Anonymous'}`)],
    }),
  ];
}

/** A part title gets a page of its own, centered a third of the way down. */
function partHeading(title: string): Paragraph[] {
  return [
    new Paragraph({ pageBreakBefore: true, children: [] }),
    ...Array.from({ length: 8 }, () => blank()),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      indent: { firstLine: 0 },
      children: [new TextRun(title)],
    }),
  ];
}

function chapterHeading(title: string): Paragraph[] {
  return [
    // Every chapter (including the first, after the title page) starts
    // on a fresh page with the heading about a third of the way down.
    new Paragraph({ pageBreakBefore: true, children: [] }),
    ...Array.from({ length: 5 }, () => blank()),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      indent: { firstLine: 0 },
      children: [new TextRun(title)],
    }),
    blank(),
  ];
}

function blank(): Paragraph {
  return new Paragraph({ indent: { firstLine: 0 }, children: [] });
}

function lastName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1] || 'Author';
}

/** Header keyword: the title, uppercased, trimmed to its first few words. */
function shortTitle(title: string): string {
  const words = (title || 'UNTITLED').trim().split(/\s+/);
  const significant = words.length > 3 ? words.slice(0, 2) : words;
  return significant.join(' ').toUpperCase();
}
