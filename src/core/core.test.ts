import { describe, expect, it } from 'vitest';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import JSZip from 'jszip';
import { parseMarkdown } from './parseMarkdown';
import { parseDocx, docxToParas, parasToBook, htmlToParas, isChapterLine } from './parseDocx';
import {
  applyCenteredDecisions,
  depthForPromotion,
  findCenteredLines,
  findCenteredTexts,
  firstContentIsHeading,
  headingDepths,
} from './detectCentered';
import { emitDocx } from './emitDocx';
import { emitEpub } from './emitEpub';
import { manuscriptWordCount, wordCount, type Book } from './model';

const SAMPLE_MD = `---
title: The Salt Road
author: J. Q. Penwright
email: jq@example.com
---

# The Harbor

It began, as these things do, with a *letter* no one would admit to sending.

Maren read it twice and burned it anyway.

***

By morning the tide had taken the ashes, which everyone agreed was **very dramatic** of it.

# The Crossing

The boat was named *Forgiveness*, which struck Maren as optimistic.
`;

describe('parseMarkdown', () => {
  it('reads frontmatter metadata', () => {
    const book = parseMarkdown([{ name: 'salt-road.md', content: SAMPLE_MD }]);
    expect(book.metadata.title).toBe('The Salt Road');
    expect(book.metadata.author).toBe('J. Q. Penwright');
    expect(book.metadata.email).toBe('jq@example.com');
  });

  it('splits chapters on the shallowest heading level', () => {
    const book = parseMarkdown([{ name: 'salt-road.md', content: SAMPLE_MD }]);
    expect(book.chapters.map((c) => c.title)).toEqual(['The Harbor', 'The Crossing']);
  });

  it('turns *** and lone # into scene breaks', () => {
    const book = parseMarkdown([{ name: 'salt-road.md', content: SAMPLE_MD }]);
    const kinds = book.chapters[0].blocks.map((b) => b.kind);
    expect(kinds).toEqual(['paragraph', 'paragraph', 'scene-break', 'paragraph']);

    const hash = parseMarkdown([{ name: 'a.md', content: 'One.\n\n#\n\nTwo.' }]);
    expect(hash.chapters[0].blocks.map((b) => b.kind)).toEqual([
      'paragraph',
      'scene-break',
      'paragraph',
    ]);
  });

  it('preserves italics and bold as styled runs', () => {
    const book = parseMarkdown([{ name: 'salt-road.md', content: SAMPLE_MD }]);
    const first = book.chapters[0].blocks[0];
    if (first.kind !== 'paragraph') throw new Error('expected paragraph');
    const italicRun = first.runs.find((r) => r.italic);
    expect(italicRun?.text).toBe('letter');
  });

  it('treats a lone top-level heading as the book title, not a chapter', () => {
    const book = parseMarkdown([
      {
        name: 'b.md',
        content:
          '# My Great Novel\n\n## Chapter One\n\nFirst text.\n\n## Chapter Two\n\nSecond text.\n',
      },
    ]);
    expect(book.metadata.title).toBe('My Great Novel');
    expect(book.chapters.map((c) => c.title)).toEqual(['Chapter One', 'Chapter Two']);
  });

  it('reads a line of tildes as a scene break, not a code fence', () => {
    const book = parseMarkdown([
      { name: 'b.md', content: 'Before the break.\n\n~~~\n\nAfter, this text must survive.\n' },
    ]);
    expect(book.chapters[0].blocks.map((b) => b.kind)).toEqual([
      'paragraph',
      'scene-break',
      'paragraph',
    ]);
  });

  it('reads two heading levels as named parts containing chapters', () => {
    const book = parseMarkdown([
      {
        name: 'b.md',
        content: [
          '# The Whisper Wood',
          '',
          '## Chapter One',
          '',
          'Text one.',
          '',
          '## Chapter Two',
          '',
          'Text two.',
          '',
          '# The Salt Marsh',
          '',
          '## Chapter Three',
          '',
          'Text three.',
        ].join('\n'),
      },
    ]);
    expect(book.chapters.map((c) => ({ part: c.part, title: c.title }))).toEqual([
      { part: 'The Whisper Wood', title: 'Chapter One' },
      { part: 'The Whisper Wood', title: 'Chapter Two' },
      { part: 'The Salt Marsh', title: 'Chapter Three' },
    ]);
  });

  it('does not mistake occasional in-chapter subheads for parts', () => {
    const book = parseMarkdown([
      {
        name: 'b.md',
        content: '# One\n\nText.\n\n# Two\n\n## A subhead\n\nMore text.\n',
      },
    ]);
    expect(book.chapters.map((c) => c.title)).toEqual(['One', 'Two']);
    expect(book.chapters.every((c) => c.part === undefined)).toBe(true);
  });

  it('reads a multi-chapter file under one top heading as a named part', () => {
    const book = parseMarkdown([
      { name: '1-first.md', content: '# Dawn\n\n## Chapter One\n\nA.\n\n## Chapter Two\n\nB.\n' },
      { name: '2-second.md', content: '# Dusk\n\n## Chapter Three\n\nC.\n\n## Chapter Four\n\nD.\n' },
    ]);
    expect(book.chapters.map((c) => ({ part: c.part, title: c.title }))).toEqual([
      { part: 'Dawn', title: 'Chapter One' },
      { part: 'Dawn', title: 'Chapter Two' },
      { part: 'Dusk', title: 'Chapter Three' },
      { part: 'Dusk', title: 'Chapter Four' },
    ]);
  });

  it('treats multiple files as chapters sorted naturally', () => {
    const book = parseMarkdown([
      { name: '10-the-end.md', content: 'Last words.' },
      { name: '2-middle.md', content: 'Middle words.' },
      { name: '1-beginning.md', content: 'First words.' },
    ]);
    expect(book.chapters.map((c) => c.title)).toEqual(['beginning', 'middle', 'the end']);
  });
});

const CENTERED_TXT = [
  '\t\tThe Salt Road', // 0: tab-centered title
  '',
  'Maren read the letter twice and burned it anyway.',
  '',
  '          The Long Walk          ', // 4: space-centered, trailing spaces
  '',
  '\tA single tab is just a paragraph indent, not centering.',
  '',
  '        This centered line runs much too long to plausibly be the title of any chapter in a book.',
  '',
  '\t\tline one of a centered poem', // 10–11: adjacent, not standalone
  '\t\tline two of a centered poem',
  '',
  '\t\t* * *', // scene break, not a title
  '',
  'And the tide came in.',
].join('\n');

describe('centered title detection', () => {
  it('finds standalone hand-centered lines and their context', () => {
    const found = findCenteredLines(CENTERED_TXT);
    expect(found.map((c) => c.index)).toEqual([0, 4]);
    expect(found[0].text).toBe('The Salt Road');
    expect(found[0].before).toBeUndefined();
    expect(found[0].after).toBe('Maren read the letter twice and burned it anyway.');
    expect(found[1].text).toBe('The Long Walk');
    expect(found[1].before).toBe('Maren read the letter twice and burned it anyway.');
  });

  it('asks nothing when the whole manuscript is indented', () => {
    const indented = Array.from({ length: 60 }, (_, i) => `        Paragraph ${i}.\n`).join('\n');
    expect(findCenteredLines(indented)).toEqual([]);
  });

  it('promotes confirmed lines to headings and keeps declined ones as prose', () => {
    const decisions = new Map([
      [0, true],
      [4, false],
    ]);
    const revised = applyCenteredDecisions(CENTERED_TXT, decisions, 1);
    const book = parseMarkdown([{ name: 'book.txt', content: revised }]);
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0].title).toBe('The Salt Road');
    const text = book.chapters[0].blocks
      .map((b) => (b.kind === 'paragraph' ? b.runs.map((r) => r.text).join('') : ''))
      .join('\n');
    // The declined line survives as prose instead of vanishing as a code block.
    expect(text).toContain('The Long Walk');
  });

  it('splits chapters on multiple confirmed titles', () => {
    const content = '\t\tOne\n\nFirst text.\n\n\t\tTwo\n\nSecond text.\n';
    const found = findCenteredLines(content);
    const revised = applyCenteredDecisions(
      content,
      new Map(found.map((c) => [c.index, true])),
      1,
    );
    const book = parseMarkdown([{ name: 'book.txt', content: revised }]);
    expect(book.chapters.map((c) => c.title)).toEqual(['One', 'Two']);
  });

  it('chooses a promotion depth that respects existing structure', () => {
    const forMd = (content: string) =>
      depthForPromotion(headingDepths(content), firstContentIsHeading(content));
    expect(forMd('no headings, just text\n')).toBe(1);
    // A lone opening heading is the book title; titles go one deeper.
    expect(forMd('# My Novel\n\ntext\n')).toBe(2);
    expect(forMd('---\ntitle: T\n---\n\n# My Novel\n\ntext\n')).toBe(2);
    // A lone heading mid-document is not a title page: join it as a sibling.
    expect(forMd('text first\n\n# One\n\nmore text\n')).toBe(1);
    // Existing sibling chapters: join them at their level.
    expect(forMd('# One\n\ntext\n\n# Two\n\ntext\n')).toBe(1);
  });

  it('finds centered docx paragraphs and promotes confirmed ones', () => {
    const paras = htmlToParas(
      '<p>\t\tThe Long Walk</p><p>Body text follows the title.</p><p>          Just Decoration          </p>',
    );
    const texts = paras.map((p) => p.runs.map((r) => r.text).join(''));
    const found = findCenteredTexts(texts, { eligible: (i) => paras[i].heading === null });
    expect(found.map((c) => c.index)).toEqual([0, 2]);

    const book = parasToBook(
      paras,
      'walk.docx',
      new Map([
        [0, true],
        [2, false],
      ]),
    );
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0].title).toBe('The Long Walk');
    const last = book.chapters[0].blocks.at(-1);
    if (last?.kind !== 'paragraph') throw new Error('expected paragraph');
    // Declined: kept as prose, centering whitespace stripped.
    expect(last.runs.map((r) => r.text).join('')).toBe('Just Decoration');
  });

  it('sees Word center alignment, not just whitespace', async () => {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ alignment: 'center', children: [new TextRun('The Long Walk')] }),
            new Paragraph({ children: [new TextRun('Body text follows the title.')] }),
            new Paragraph({ alignment: 'center', children: [new TextRun('* * *')] }),
            new Paragraph({
              heading: HeadingLevel.HEADING_1,
              alignment: 'center',
              children: [new TextRun('Real Heading')],
            }),
            new Paragraph({ alignment: 'both', children: [new TextRun('Justified, not centered.')] }),
          ],
        },
      ],
    });
    const buffer = await Packer.toBuffer(doc);
    const paras = await docxToParas(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    );
    expect(paras.map((p) => !!p.centered)).toEqual([true, false, true, false, false]);
    expect(paras[3].heading).toBe(1); // real heading style wins over alignment

    const texts = paras.map((p) => p.runs.map((r) => r.text).join(''));
    const found = findCenteredTexts(texts, {
      eligible: (i) => paras[i].heading === null,
      aligned: (i) => !!paras[i].centered,
    });
    // The centered scene break is not a candidate; the centered title is.
    expect(found.map((c) => c.text)).toEqual(['The Long Walk']);

    const book = parasToBook(paras, 'walk.docx', new Map([[found[0].index, true]]));
    expect(book.chapters.map((c) => c.title)).toEqual(['The Long Walk', 'Real Heading']);
  });
});

describe('word counts', () => {
  it('rounds to the nearest 100 for short work', () => {
    const book = parseMarkdown([{ name: 'a.md', content: 'word '.repeat(1234).trim() }]);
    expect(wordCount(book)).toBe(1234);
    expect(manuscriptWordCount(book)).toBe(1200);
  });

  it('rounds to the nearest 1000 for novel-length work', () => {
    const book: Book = {
      metadata: { title: 'T', author: 'A' },
      chapters: [
        {
          title: '',
          blocks: [{ kind: 'paragraph', runs: [{ text: 'word '.repeat(81499).trim() }] }],
        },
      ],
    };
    expect(manuscriptWordCount(book)).toBe(81_000);
  });
});

describe('emitDocx', () => {
  it('produces a valid docx with Shunn furniture', async () => {
    const book = parseMarkdown([{ name: 'salt-road.md', content: SAMPLE_MD }]);
    const buffer = await Packer.toBuffer(emitDocx(book));
    const zip = await JSZip.loadAsync(buffer);
    const doc = await zip.file('word/document.xml')!.async('string');
    expect(doc).toContain('The Salt Road');
    expect(doc).toContain('by J. Q. Penwright');
    expect(doc).toContain('about');
    expect(doc).toContain('END');
    const styles = await zip.file('word/styles.xml')!.async('string');
    expect(styles).toContain('Times New Roman');
    // US Letter, not the library's A4 default.
    expect(doc).toMatch(/<w:pgSz w:w="12240" w:h="15840"/);
    const header = await Promise.all(
      Object.keys(zip.files)
        .filter((f) => /word\/header\d*\.xml/.test(f))
        .map((f) => zip.file(f)!.async('string')),
    );
    expect(header.join('')).toContain('Penwright / THE SALT ROAD / ');
  });
});

const PART_MD = `---
title: The Crossing
author: A
---

# The Whisper Wood

## Chapter One

Text one.

## Chapter Two

Text two.

# The Salt Marsh

## Chapter Three

Text three.
`;

describe('parts in outputs', () => {
  it('gives each part its own page in the manuscript', async () => {
    const book = parseMarkdown([{ name: 'b.md', content: PART_MD }]);
    const buffer = await Packer.toBuffer(emitDocx(book));
    const zip = await JSZip.loadAsync(buffer);
    const doc = await zip.file('word/document.xml')!.async('string');
    expect(doc).toContain('The Whisper Wood');
    expect(doc).toContain('The Salt Marsh');
    expect(doc).toContain('Chapter Three');
  });

  it('gives each part a page and a nested TOC entry in the EPUB', async () => {
    const book = parseMarkdown([{ name: 'b.md', content: PART_MD }]);
    const zip = emitEpub(book, { modified: '2026-06-10T00:00:00Z' });
    expect(zip.file('OEBPS/text/part-001.xhtml')).toBeTruthy();
    expect(zip.file('OEBPS/text/part-002.xhtml')).toBeTruthy();

    const nav = await zip.file('OEBPS/nav.xhtml')!.async('string');
    expect(nav).toContain('The Whisper Wood');
    expect(nav.indexOf('<ol>')).toBeLessThan(nav.indexOf('chapter-001'));

    const opf = await zip.file('OEBPS/package.opf')!.async('string');
    expect(opf).toContain('<itemref idref="part-001"/>');
    expect(opf).toContain('<itemref idref="chapter-003"/>');

    const ncxDoc = await zip.file('OEBPS/toc.ncx')!.async('string');
    expect(ncxDoc).toContain('The Salt Marsh');
  });
});

describe('emitEpub', () => {
  it('builds a structurally valid EPUB', async () => {
    const book = parseMarkdown([{ name: 'salt-road.md', content: SAMPLE_MD }]);
    const zip = emitEpub(book, {
      identifier: 'urn:uuid:00000000-0000-4000-8000-000000000000',
      modified: '2026-06-09T00:00:00Z',
    });
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const reopened = await JSZip.loadAsync(bytes);

    expect(await reopened.file('mimetype')!.async('string')).toBe('application/epub+zip');
    // mimetype must be the first, uncompressed entry: check raw bytes.
    expect(new TextDecoder().decode(bytes.slice(30, 38))).toBe('mimetype');

    const opf = await reopened.file('OEBPS/package.opf')!.async('string');
    expect(opf).toContain('<dc:title>The Salt Road</dc:title>');
    expect(opf).toContain('<dc:creator id="creator">J. Q. Penwright</dc:creator>');
    expect(opf).toContain('dcterms:modified');

    expect(reopened.file('META-INF/container.xml')).toBeTruthy();
    expect(reopened.file('OEBPS/nav.xhtml')).toBeTruthy();
    expect(reopened.file('OEBPS/toc.ncx')).toBeTruthy();
    expect(reopened.file('OEBPS/text/chapter-001.xhtml')).toBeTruthy();
    expect(reopened.file('OEBPS/text/chapter-002.xhtml')).toBeTruthy();

    const ch1 = await reopened.file('OEBPS/text/chapter-001.xhtml')!.async('string');
    expect(ch1).toContain('<em>letter</em>');
    expect(ch1).toContain('<p class="scene-break">* * *</p>');
  });

  it('escapes XML-hostile titles', async () => {
    const book = parseMarkdown([
      { name: 'a.md', content: '---\ntitle: Salt & <Iron>\nauthor: A\n---\n\nText.' },
    ]);
    const zip = emitEpub(book, { modified: '2026-06-09T00:00:00Z' });
    const opf = await zip.file('OEBPS/package.opf')!.async('string');
    expect(opf).toContain('Salt &amp; &lt;Iron&gt;');
  });
});

describe('parseDocx', () => {
  it('walks mammoth-style HTML into styled paragraphs', () => {
    const paras = htmlToParas(
      '<h1>Chapter One</h1><p>Plain <em>slanted</em> and <strong>heavy</strong>.</p><p>***</p><p>After the break.</p>',
    );
    expect(paras).toHaveLength(4);
    expect(paras[0].heading).toBe(1);
    expect(paras[1].runs.find((r) => r.italic)?.text).toBe('slanted');
    expect(paras[1].runs.find((r) => r.bold)?.text).toBe('heavy');
  });

  it('recognizes real chapter lines without sentence false-positives', () => {
    for (const yes of [
      'Chapter Twelve',
      'CHAPTER 3',
      'Chapter XII',
      'chapter twenty-one',
      'Part Two',
      'BOOK I',
      'Prologue',
      'Epilogue',
      'PART TWO: THE RECKONING',
      'Chapter One — The Storm',
    ]) {
      expect(isChapterLine(yes), yes).toBe(true);
    }
    for (const no of [
      'Part of me wanted to die.',
      'Book clubs were her nightmare.',
      'Epilogue came too soon for her liking.',
      'Chapter One was the hardest to write.',
      'It was over.',
    ]) {
      expect(isChapterLine(no), no).toBe(false);
    }
  });

  it('round-trips a manuscript docx through mammoth', async () => {
    const book = parseMarkdown([{ name: 'salt-road.md', content: SAMPLE_MD }]);
    const buffer = await Packer.toBuffer(emitDocx(book));
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
    const parsed = await parseDocx(arrayBuffer, 'salt-road.docx');
    const allText = parsed.chapters
      .flatMap((c) => c.blocks)
      .map((b) => (b.kind === 'paragraph' ? b.runs.map((r) => r.text).join('') : '#'))
      .join('\n');
    expect(allText).toContain('Maren read it twice');
    expect(allText).toContain('very dramatic');
  });
});
