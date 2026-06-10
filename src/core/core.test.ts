import { describe, expect, it } from 'vitest';
import { Packer } from 'docx';
import JSZip from 'jszip';
import { parseMarkdown } from './parseMarkdown';
import { parseDocx, htmlToParas, isChapterLine } from './parseDocx';
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

  it('treats multiple files as chapters sorted naturally', () => {
    const book = parseMarkdown([
      { name: '10-the-end.md', content: 'Last words.' },
      { name: '2-middle.md', content: 'Middle words.' },
      { name: '1-beginning.md', content: 'First words.' },
    ]);
    expect(book.chapters.map((c) => c.title)).toEqual(['beginning', 'middle', 'the end']);
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
