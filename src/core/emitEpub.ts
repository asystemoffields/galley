import JSZip from 'jszip';
import type { Block, Book, Chapter } from './model';

export interface EpubOptions {
  /** Cover image bytes plus its MIME type ("image/jpeg" or "image/png"). */
  cover?: { data: ArrayBuffer | Uint8Array; mime: 'image/jpeg' | 'image/png' };
  /** Override the generated urn:uuid identifier (useful for tests / re-releases). */
  identifier?: string;
  /** Override dcterms:modified (useful for reproducible tests). */
  modified?: string;
}

/**
 * Build a store-ready EPUB 3 (with EPUB 2 NCX fallback) entirely
 * in memory. Returns the JSZip — callers serialize with
 * `zip.generateAsync({type: 'blob', mimeType: 'application/epub+zip'})`.
 */
export function emitEpub(book: Book, options: EpubOptions = {}): JSZip {
  const meta = book.metadata;
  const uuid = options.identifier ?? `urn:uuid:${generateUuid()}`;
  const modified = options.modified ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const language = meta.language || 'en';
  const title = meta.title || 'Untitled';
  const author = meta.author || 'Anonymous';

  const zip = new JSZip();
  // The mimetype entry must be first and uncompressed.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', CONTAINER_XML);

  const chapters = book.chapters.map((chapter, i) => ({
    id: `chapter-${String(i + 1).padStart(3, '0')}`,
    title: chapter.title || (book.chapters.length > 1 ? `Chapter ${i + 1}` : title),
    chapter,
  }));

  zip.file('OEBPS/styles/style.css', STYLESHEET);
  zip.file('OEBPS/text/titlepage.xhtml', titlePageXhtml(title, author, language));

  // Books with parts get a page per part title, ahead of its chapters;
  // `docs` is every content document in reading order, `navTree` nests
  // chapters under their part for the EPUB 3 nav.
  const docs: ChapterEntry[] = [];
  const navTree: NavEntry[] = [];
  let currentPart: string | undefined;
  let partCount = 0;
  for (const c of chapters) {
    const part = c.chapter.part;
    if (part !== currentPart) {
      currentPart = part;
      if (part) {
        partCount += 1;
        const entry = { id: `part-${String(partCount).padStart(3, '0')}`, title: part };
        docs.push(entry);
        navTree.push({ ...entry, children: [] });
        zip.file(`OEBPS/text/${entry.id}.xhtml`, partXhtml(part, language));
      }
    }
    docs.push({ id: c.id, title: c.title });
    const group = navTree[navTree.length - 1];
    if (part && group?.children) group.children.push({ id: c.id, title: c.title });
    else navTree.push({ id: c.id, title: c.title });
    zip.file(`OEBPS/text/${c.id}.xhtml`, chapterXhtml(c.title, c.chapter, language));
  }

  const coverExt = options.cover?.mime === 'image/png' ? 'png' : 'jpg';
  if (options.cover) {
    zip.file(`OEBPS/images/cover.${coverExt}`, options.cover.data);
    zip.file('OEBPS/text/cover.xhtml', coverXhtml(coverExt, language));
  }

  zip.file('OEBPS/nav.xhtml', navXhtml(navTree, language, !!options.cover));
  zip.file('OEBPS/toc.ncx', ncx(uuid, title, docs));
  zip.file(
    'OEBPS/package.opf',
    packageOpf({ uuid, modified, language, title, author, docs, cover: options.cover && coverExt }),
  );
  return zip;
}

export function escapeXml(text: string): string {
  return text
    // Drop characters XML 1.0 forbids even when escaped (C0 controls other
    // than tab/newline/return). A stray one from a pasted title would make
    // strict EPUB validators and some readers reject the whole document.
    // eslint-disable-next-line no-control-regex -- stripping these is the point
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generateUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  // Last-resort fallback for very old browsers.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

const STYLESHEET = `body {
  margin: 5% 6%;
  font-family: serif;
  line-height: 1.5;
}
h1.chapter-title {
  text-align: center;
  font-weight: normal;
  font-size: 1.6em;
  margin: 3em 0 2em 0;
}
p {
  margin: 0;
  text-indent: 1.25em;
  text-align: justify;
}
p.first {
  text-indent: 0;
}
p.scene-break {
  text-indent: 0;
  text-align: center;
  margin: 1em 0;
}
.titlepage {
  text-align: center;
  margin-top: 30%;
}
.partpage {
  text-align: center;
  margin-top: 35%;
}
.partpage h1 {
  font-weight: normal;
  font-size: 1.8em;
}
.titlepage h1 {
  font-weight: normal;
  font-size: 2em;
}
.titlepage p.author {
  text-indent: 0;
  text-align: center;
  font-size: 1.2em;
  margin-top: 2em;
}
img.cover {
  max-width: 100%;
  max-height: 100%;
}
`;

function xhtmlShell(titleText: string, body: string, language: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}">
<head>
  <title>${escapeXml(titleText)}</title>
  <link rel="stylesheet" type="text/css" href="../styles/style.css"/>
</head>
<body>
${body}
</body>
</html>
`;
}

function titlePageXhtml(title: string, author: string, language: string): string {
  return xhtmlShell(
    title,
    `  <section class="titlepage" epub:type="titlepage">
    <h1>${escapeXml(title)}</h1>
    <p class="author">${escapeXml(author)}</p>
  </section>`,
    language,
  );
}

function coverXhtml(ext: string, language: string): string {
  return xhtmlShell(
    'Cover',
    `  <section epub:type="cover" style="text-align:center">
    <img class="cover" src="../images/cover.${ext}" alt="Cover"/>
  </section>`,
    language,
  );
}

function partXhtml(title: string, language: string): string {
  return xhtmlShell(
    title,
    `  <section class="partpage" epub:type="part">
    <h1>${escapeXml(title)}</h1>
  </section>`,
    language,
  );
}

function chapterXhtml(title: string, chapter: Chapter, language: string): string {
  const paragraphs: string[] = [];
  let firstAfterBreak = true;
  for (const block of chapter.blocks) {
    if (block.kind === 'scene-break') {
      paragraphs.push('    <p class="scene-break">* * *</p>');
      firstAfterBreak = true;
      continue;
    }
    const cls = firstAfterBreak ? ' class="first"' : '';
    paragraphs.push(`    <p${cls}>${runsToXhtml(block)}</p>`);
    firstAfterBreak = false;
  }
  return xhtmlShell(
    title,
    `  <section epub:type="chapter">
    <h1 class="chapter-title">${escapeXml(title)}</h1>
${paragraphs.join('\n')}
  </section>`,
    language,
  );
}

function runsToXhtml(block: Block): string {
  if (block.kind !== 'paragraph') return '';
  return block.runs
    .map((run) => {
      let text = escapeXml(run.text);
      if (run.bold) text = `<strong>${text}</strong>`;
      if (run.italic) text = `<em>${text}</em>`;
      return text;
    })
    .join('');
}

interface ChapterEntry {
  id: string;
  title: string;
}

interface NavEntry extends ChapterEntry {
  children?: ChapterEntry[];
}

function navXhtml(entries: NavEntry[], language: string, hasCover: boolean): string {
  const link = (e: ChapterEntry) => `<a href="text/${e.id}.xhtml">${escapeXml(e.title)}</a>`;
  const items = [
    ...(hasCover ? ['    <li><a href="text/cover.xhtml">Cover</a></li>'] : []),
    `    <li><a href="text/titlepage.xhtml">Title Page</a></li>`,
    ...entries.map((e) =>
      e.children?.length
        ? `    <li>${link(e)}\n      <ol>\n${e.children
            .map((c) => `        <li>${link(c)}</li>`)
            .join('\n')}\n      </ol>\n    </li>`
        : `    <li>${link(e)}</li>`,
    ),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
${items.join('\n')}
    </ol>
  </nav>
</body>
</html>
`;
}

function ncx(uuid: string, title: string, chapters: ChapterEntry[]): string {
  const points = chapters
    .map(
      (c, i) => `    <navPoint id="${c.id}" playOrder="${i + 2}">
      <navLabel><text>${escapeXml(c.title)}</text></navLabel>
      <content src="text/${c.id}.xhtml"/>
    </navPoint>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(uuid)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
    <navPoint id="titlepage" playOrder="1">
      <navLabel><text>Title Page</text></navLabel>
      <content src="text/titlepage.xhtml"/>
    </navPoint>
${points}
  </navMap>
</ncx>
`;
}

function packageOpf(args: {
  uuid: string;
  modified: string;
  language: string;
  title: string;
  author: string;
  docs: ChapterEntry[];
  cover?: string | false;
}): string {
  const { uuid, modified, language, title, author, docs, cover } = args;
  const coverManifest = cover
    ? `    <item id="cover-image" href="images/cover.${cover}" media-type="image/${cover === 'png' ? 'png' : 'jpeg'}" properties="cover-image"/>
    <item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>\n`
    : '';
  const coverSpine = cover ? `    <itemref idref="cover" linear="yes"/>\n` : '';
  const coverMeta = cover ? `    <meta name="cover" content="cover-image"/>\n` : '';
  const chapterManifest = docs
    .map((c) => `    <item id="${c.id}" href="text/${c.id}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('\n');
  const chapterSpine = docs.map((c) => `    <itemref idref="${c.id}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${escapeXml(language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">${escapeXml(uuid)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:creator id="creator">${escapeXml(author)}</dc:creator>
    <meta refines="#creator" property="role" scheme="marc:relators">aut</meta>
    <dc:language>${escapeXml(language)}</dc:language>
    <meta property="dcterms:modified">${escapeXml(modified)}</meta>
${coverMeta}  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="style" href="styles/style.css" media-type="text/css"/>
    <item id="titlepage" href="text/titlepage.xhtml" media-type="application/xhtml+xml"/>
${coverManifest}${chapterManifest}
  </manifest>
  <spine toc="ncx">
${coverSpine}    <itemref idref="titlepage"/>
${chapterSpine}
  </spine>
</package>
`;
}
