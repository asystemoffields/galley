import { Packer } from 'docx';
import { emitDocx, emitEpub, type Book, type DocxOptions, type EpubOptions } from '../core';

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function safeFilename(title: string, suffix: string): string {
  const base = (title || 'untitled')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'untitled'}${suffix}`;
}

export async function downloadManuscript(book: Book, options: DocxOptions = {}) {
  const blob = await Packer.toBlob(emitDocx(book, options));
  saveBlob(blob, safeFilename(book.metadata.title, '-manuscript.docx'));
}

export async function downloadEpub(book: Book, options: EpubOptions = {}) {
  const zip = emitEpub(book, options);
  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
  });
  saveBlob(blob, safeFilename(book.metadata.title, '.epub'));
}
