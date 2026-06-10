/**
 * End-to-end smoke test: load the built app, feed it the sample
 * manuscript, check the wizard, download both outputs, and sanity-check
 * the bytes. Run with the preview server up:  node scripts/smoke.mjs
 */
import { chromium } from 'playwright';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';

const BASE = process.env.GALLEY_URL ?? 'http://localhost:4173';
const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures.push(label);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(BASE);

await page.screenshot({ path: '/tmp/galley-home.png', fullPage: true });
check(await page.getByText('Drop your manuscript here').isVisible(), 'landing page renders');

await page.setInputFiles('input[type=file]', 'samples/the-salt-road.md');
await page.getByText("Here's your book!").waitFor({ timeout: 10_000 });
await page.screenshot({ path: '/tmp/galley-book.png', fullPage: true });

check(
  (await page.locator('input').first().inputValue()) === 'The Salt Road',
  'title prefilled from frontmatter',
);
check((await page.locator('.chapter-list li').count()) === 3, 'three chapters detected');
check(await page.getByText('The Other Shore').isVisible(), 'chapter titles shown');

const [docxDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.getByText('Download manuscript (.docx)').click(),
]);
const docxPath = await docxDownload.path();
const docxZip = await JSZip.loadAsync(await readFile(docxPath));
const documentXml = await docxZip.file('word/document.xml').async('string');
check(docxDownload.suggestedFilename() === 'the-salt-road-manuscript.docx', 'docx filename');
check(documentXml.includes('by J. Q. Penwright'), 'docx byline present');
check(documentXml.includes('Maren read it twice'), 'docx body text present');

const [epubDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.getByText('Download ebook (.epub)').click(),
]);
const epubBytes = await readFile(await epubDownload.path());
check(epubDownload.suggestedFilename() === 'the-salt-road.epub', 'epub filename');
check(
  epubBytes.subarray(30, 38).toString() === 'mimetype' &&
    epubBytes.subarray(38, 58).toString() === 'application/epub+zip',
  'epub mimetype is first and uncompressed',
);
const epubZip = await JSZip.loadAsync(epubBytes);
const opf = await epubZip.file('OEBPS/package.opf').async('string');
check(opf.includes('<dc:title>The Salt Road</dc:title>'), 'epub metadata');
check(!!epubZip.file('OEBPS/text/chapter-003.xhtml'), 'epub has all chapters');

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll smoke checks passed. Screenshots: /tmp/galley-home.png, /tmp/galley-book.png');
