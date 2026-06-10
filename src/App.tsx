import { useCallback, useMemo, useRef, useState } from 'react';
import './App.css';
import type { Book } from './core';
import { blockText, manuscriptWordCount, wordCount } from './core';
import { ingestFiles, IngestError } from './lib/ingest';
import { downloadEpub, downloadManuscript } from './lib/download';

type Cover = { data: ArrayBuffer; mime: 'image/jpeg' | 'image/png'; previewUrl: string };

export default function App() {
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleFiles = useCallback(async (files: File[]) => {
    setError(null);
    setBusy(true);
    try {
      setBook(await ingestFiles(files));
    } catch (e) {
      setError(
        e instanceof IngestError
          ? e.message
          : "Something went sideways while reading that file — and it's our fault, not yours. If it keeps happening, try exporting your book as .docx and dropping that in instead.",
      );
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="app">
      <header className="masthead">
        <span className="wordmark">Galley</span>
        {book && (
          <button className="link-button" onClick={() => setBook(null)}>
            ← Start over with a different file
          </button>
        )}
      </header>
      {book ? (
        <BookScreen book={book} onChange={setBook} />
      ) : (
        <WelcomeScreen onFiles={handleFiles} error={error} busy={busy} />
      )}
      <footer className="footer">
        <p>
          Galley is free and open source. It runs entirely on your device — your
          words never leave this page, and it works with the internet off.
        </p>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function WelcomeScreen({
  onFiles,
  error,
  busy,
}: {
  onFiles: (files: File[]) => void;
  error: string | null;
  busy: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <main className="welcome">
      <h1>Your book, beautifully formatted.</h1>
      <p className="lede">
        Drop in the manuscript you've already written. Get back a properly
        formatted manuscript for querying agents, and an ebook ready for every
        store. No accounts, no uploads, no fuss.
      </p>
      <div
        className={`dropzone${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          onFiles(Array.from(e.dataTransfer.files));
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".md,.markdown,.mdown,.txt,.docx"
          hidden
          onChange={(e) => {
            if (e.target.files?.length) onFiles(Array.from(e.target.files));
            e.target.value = '';
          }}
        />
        <div className="dropzone-art" aria-hidden>
          📖
        </div>
        {busy ? (
          <p className="dropzone-title">Reading your book…</p>
        ) : (
          <>
            <p className="dropzone-title">Drop your manuscript here</p>
            <p className="dropzone-hint">
              or click to choose a file — Word (.docx), Markdown, or plain
              text. One big file or a folder's worth of chapters, both are fine.
            </p>
          </>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      <p className="privacy">
        🔒 Everything happens right here on your device. Your manuscript is
        never uploaded anywhere — promise.
      </p>
    </main>
  );
}

/* ------------------------------------------------------------------ */

function BookScreen({ book, onChange }: { book: Book; onChange: (b: Book) => void }) {
  const [underlineItalics, setUnderlineItalics] = useState(false);
  const [cover, setCover] = useState<Cover | null>(null);
  const meta = book.metadata;
  const exact = useMemo(() => wordCount(book), [book]);
  const rounded = useMemo(() => manuscriptWordCount(book), [book]);

  const setMeta = (patch: Partial<Book['metadata']>) =>
    onChange({ ...book, metadata: { ...meta, ...patch } });

  const shape =
    book.chapters.length > 1
      ? `${book.chapters.length} chapters, about ${exact.toLocaleString()} words`
      : `about ${exact.toLocaleString()} words`;

  return (
    <main className="book-screen">
      <h1>Here's your book!</h1>
      <p className="lede">
        We found <strong>{shape}</strong>. Check the details below — then your
        downloads are waiting at the bottom.
      </p>

      <section className="card">
        <h2>About your book</h2>
        <div className="form-grid">
          <label>
            Title
            <input
              value={meta.title}
              onChange={(e) => setMeta({ title: e.target.value })}
              placeholder="The Salt Road"
            />
          </label>
          <label>
            Author name <span className="soft">— as you'd like it printed</span>
            <input
              value={meta.author}
              onChange={(e) => setMeta({ author: e.target.value })}
              placeholder="Your name or pen name"
            />
          </label>
        </div>
        <details className="more">
          <summary>Contact details for the manuscript's first page</summary>
          <p className="soft">
            Agents and magazines expect these in the top corner of page one.
            Leave blank anything you'd rather not include.
          </p>
          <div className="form-grid">
            <label>
              Real name <span className="soft">— if different from your pen name</span>
              <input
                value={meta.legalName ?? ''}
                onChange={(e) => setMeta({ legalName: e.target.value || undefined })}
              />
            </label>
            <label>
              Email
              <input
                value={meta.email ?? ''}
                onChange={(e) => setMeta({ email: e.target.value || undefined })}
              />
            </label>
            <label>
              Mailing address
              <input
                value={meta.address ?? ''}
                onChange={(e) => setMeta({ address: e.target.value || undefined })}
              />
            </label>
            <label>
              Phone
              <input
                value={meta.phone ?? ''}
                onChange={(e) => setMeta({ phone: e.target.value || undefined })}
              />
            </label>
          </div>
        </details>
      </section>

      <section className="card">
        <h2>Chapters we found</h2>
        <ol className="chapter-list">
          {book.chapters.map((c, i) => (
            <li key={i}>
              <span className="chapter-title">{c.title || `Chapter ${i + 1}`}</span>
              <span className="chapter-words">
                {c.blocks
                  .reduce(
                    (n, b) =>
                      n + (blockText(b).trim() ? blockText(b).trim().split(/\s+/).length : 0),
                    0,
                  )
                  .toLocaleString()}{' '}
                words
              </span>
            </li>
          ))}
        </ol>
        <p className="soft">
          Not what you expected? Galley splits chapters on headings (like{' '}
          <code># Chapter One</code> in Markdown, or Heading 1 in Word). Adjust
          your file and drop it in again — nothing here is saved, so you can't
          break anything.
        </p>
      </section>

      <section className="downloads">
        <div className="card download-card">
          <h2>📄 Manuscript</h2>
          <p>
            Standard manuscript format — the layout agents and magazines ask
            for. Times New Roman, double-spaced, with your details and the word
            count ("about {rounded.toLocaleString()} words") on page one.
          </p>
          <ManuscriptPreview book={book} />
          <label className="option">
            <input
              type="checkbox"
              checked={underlineItalics}
              onChange={(e) => setUnderlineItalics(e.target.checked)}
            />
            <span>
              Show italics as <u>underline</u>{' '}
              <span className="soft">(an older convention a few markets still ask for)</span>
            </span>
          </label>
          <button
            className="download-button"
            onClick={() => downloadManuscript(book, { underlineItalics })}
          >
            Download manuscript (.docx)
          </button>
        </div>

        <div className="card download-card">
          <h2>📱 Ebook</h2>
          <p>
            A clean EPUB that's ready for Kindle, Apple Books, Kobo, and
            everywhere else ebooks are sold — or for sending straight to your
            beta readers.
          </p>
          <EbookPreview book={book} />
          <label className="option stacked">
            <span>
              Cover image <span className="soft">(optional — JPG or PNG)</span>
            </span>
            <input
              type="file"
              accept="image/jpeg,image/png"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const mime = f.type === 'image/png' ? 'image/png' : 'image/jpeg';
                setCover({
                  data: await f.arrayBuffer(),
                  mime,
                  previewUrl: URL.createObjectURL(f),
                });
              }}
            />
          </label>
          {cover && <img className="cover-thumb" src={cover.previewUrl} alt="Your cover" />}
          <button
            className="download-button"
            onClick={() => downloadEpub(book, cover ? { cover } : {})}
          >
            Download ebook (.epub)
          </button>
        </div>
      </section>
    </main>
  );
}

/* ------------------------------------------------------------------ */

function ManuscriptPreview({ book }: { book: Book }) {
  const meta = book.metadata;
  const firstChapter = book.chapters[0];
  const firstParas = firstChapter
    ? firstChapter.blocks.filter((b) => b.kind === 'paragraph').slice(0, 2)
    : [];
  return (
    <div className="preview ms-preview" aria-label="Manuscript preview">
      <div className="ms-top">
        <div className="ms-contact">
          <div>{meta.legalName || meta.author || 'Your Name'}</div>
          {meta.email && <div>{meta.email}</div>}
        </div>
        <div className="ms-count">about {manuscriptWordCount(book).toLocaleString()} words</div>
      </div>
      <div className="ms-title">{meta.title || 'Untitled'}</div>
      <div className="ms-byline">by {meta.author || 'Anonymous'}</div>
      <div className="ms-body">
        {firstParas.map((b, i) => (
          <p key={i}>{blockText(b)}</p>
        ))}
      </div>
    </div>
  );
}

function EbookPreview({ book }: { book: Book }) {
  const chapter = book.chapters[0];
  if (!chapter) return null;
  const paras = chapter.blocks.filter((b) => b.kind === 'paragraph').slice(0, 3);
  return (
    <div className="preview epub-preview" aria-label="Ebook preview">
      <div className="epub-chapter-title">
        {chapter.title || book.metadata.title || 'Chapter One'}
      </div>
      {paras.map((b, i) =>
        b.kind === 'paragraph' ? (
          <p key={i} className={i === 0 ? 'first' : ''}>
            {b.runs.map((r, j) => {
              let node: React.ReactNode = r.text;
              if (r.bold) node = <strong>{node}</strong>;
              if (r.italic) node = <em>{node}</em>;
              return <span key={j}>{node}</span>;
            })}
          </p>
        ) : null,
      )}
    </div>
  );
}
