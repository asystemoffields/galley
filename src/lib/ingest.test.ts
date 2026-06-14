import { describe, expect, it } from 'vitest';
import { ingestFiles, IngestError } from './ingest';

const CENTERED_TXT = [
  '\t\tOne',
  '',
  'First text.',
  '',
  '\t\tNot a title, just dramatic',
  '',
  '\t\tTwo',
  '',
  'Second text.',
].join('\n');

describe('ingestFiles', () => {
  it('reports centered candidates, then folds the answers back in', async () => {
    const file = new File([CENTERED_TXT], 'book.txt', { type: 'text/plain' });

    const first = await ingestFiles([file]);
    expect(first.candidates.map((c) => c.text)).toEqual([
      'One',
      'Not a title, just dramatic',
      'Two',
    ]);
    expect(first.candidates[1].before).toBe('First text.');

    const decisions = new Map(
      first.candidates.map((c) => [c.id, c.text !== 'Not a title, just dramatic']),
    );
    const second = await ingestFiles([file], decisions);
    expect(second.candidates).toEqual([]);
    expect(second.book.chapters.map((c) => c.title)).toEqual(['One', 'Two']);
    const chapterOne = second.book.chapters[0].blocks
      .map((b) => (b.kind === 'paragraph' ? b.runs.map((r) => r.text).join('') : ''))
      .join('\n');
    expect(chapterOne).toContain('Not a title, just dramatic');
  });

  it('returns no candidates for a conventionally formatted file', async () => {
    const file = new File(['# One\n\nText.\n'], 'book.md');
    const { book, candidates } = await ingestFiles([file]);
    expect(candidates).toEqual([]);
    expect(book.chapters.map((c) => c.title)).toEqual(['One']);
  });

  it('refuses a mix of Word and text files rather than silently dropping one', async () => {
    const docx = new File(['x'], 'book.docx');
    const md = new File(['# One\n\nText.\n'], 'notes.md');
    await expect(ingestFiles([docx, md])).rejects.toBeInstanceOf(IngestError);
  });
});
