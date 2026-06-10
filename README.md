# Galley

**Your book, beautifully formatted.**

Galley is a free, open-source web app for writers. Drop in the manuscript
you've already written — Markdown, plain text, or a Word document — and get
back:

- 📄 **A manuscript (.docx)** in standard manuscript format (Shunn): the layout
  literary agents and magazines ask for. Times New Roman, double-spaced,
  contact block and rounded word count on page one, `Surname / TITLE / page`
  running header, centered `#` scene breaks.
- 📱 **An ebook (.epub)** — a clean, valid EPUB 3 (with EPUB 2 fallback) ready
  for Kindle, Apple Books, Kobo, and beta readers. Optional cover image.

**Everything runs on your device.** Galley is a static site with no backend:
your manuscript is never uploaded anywhere, and the app works offline. That's
not a feature toggle — there is simply no server to send your words to.

## Using it

```
npm install
npm run dev      # local development
npm run build    # static production build in dist/
```

Deploy `dist/` to any static host (GitHub Pages, Netlify, Cloudflare Pages).

## How your book is read

- **One Markdown file**: chapters split on the shallowest heading level
  (`# Chapter One`). YAML frontmatter (`title:`, `author:`, `email:` …)
  prefills the book details.
- **Several Markdown files**: each file is a chapter, sorted naturally by
  filename (`1-`, `2-`, … `10-` sorts correctly).
- **A Word document**: chapters split on Heading 1 (or, if the document has no
  heading styles, on standalone "Chapter …" lines).
- Scene breaks: `***`, a lone `#`, `~`, or a thematic break, in any format.
- Italics and bold survive the trip in both directions.

## Architecture

```
src/core/    framework-free TypeScript: parsers, Book model, emitters
  model.ts         the intermediate Book representation + word counts
  parseMarkdown.ts remark-based Markdown → Book
  parseDocx.ts     mammoth-based .docx → Book
  emitDocx.ts      Book → Shunn standard manuscript format (docx)
  emitEpub.ts      Book → EPUB 3 (JSZip, hand-built, validates clean)
src/         React wizard UI around the core
scripts/     Playwright end-to-end smoke test
samples/     a small sample manuscript
```

`src/core` deliberately has no React or DOM dependencies, so it can become a
CLI or feed future emitters (looking at you, print-ready PDF) untouched.

## Tests

```
npm test                 # unit tests (vitest)
npm run preview &        # then:
node scripts/smoke.mjs   # browser end-to-end: drop file → download → verify bytes
```

## Roadmap

- Print-ready PDF interiors (trim sizes, mirrored margins, running heads) —
  likely via Typst compiled to WebAssembly
- Front/back matter: copyright page, dedication, acknowledgments
- Anonymized manuscript mode for contests that read blind
- More input formats (.odt, Scrivener exports)

## License

MIT
