/**
 * End-to-end smoke test: load the built app, feed it the sample
 * manuscript, check the wizard, download both outputs, and sanity-check
 * the bytes. Run with the preview server up:  node scripts/smoke.mjs
 */
import { chromium } from 'playwright';
import JSZip from 'jszip';
import { Document, Packer, Paragraph, TextRun } from 'docx';
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

// Hand-centered chapter titles: the review step should ask about each.
await page.getByText('← Start over').click();
const centered = [
  '\t\tOne',
  '',
  'First text, long enough to look like prose.',
  '',
  '\t\tNot a title, just dramatic',
  '',
  '\t\tTwo',
  '',
  'Second text, also unmistakably prose.',
].join('\n');
await page.setInputFiles('input[type=file]', {
  name: 'centered.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from(centered),
});
await page.getByText('Quick question about your chapters').waitFor({ timeout: 10_000 });
await page.screenshot({ path: '/tmp/galley-review.png', fullPage: true });
check(await page.getByText('1 of 3').isVisible(), 'review counts candidates');
check(await page.locator('.review-candidate').first().textContent() === 'One', 'first candidate shown');
await page.getByText("Yes, it's a chapter title").click();
check(await page.getByText('2 of 3').isVisible(), 'review advances');
await page.getByText("No, it's just text").click();
await page.getByText("Yes, it's a chapter title").click();
await page.getByText("Here's your book!").waitFor({ timeout: 10_000 });
const reviewedTitles = await page.locator('.chapter-list .chapter-title').allTextContents();
check(
  reviewedTitles.length === 2 && reviewedTitles[0] === 'One' && reviewedTitles[1] === 'Two',
  'confirmed titles became chapters',
);
check(
  (await page.locator('.chapter-list li').first().textContent())?.includes('13 words') ?? false,
  'declined line kept as prose in chapter one',
);

// Word's center-alignment button (no whitespace) should be spotted too.
await page.getByText('← Start over').click();
const alignedDocx = await Packer.toBuffer(
  new Document({
    sections: [
      {
        children: [
          new Paragraph({ alignment: 'center', children: [new TextRun('The Reckoning')] }),
          new Paragraph({ children: [new TextRun('Center-aligned in Word, no tabs in sight.')] }),
        ],
      },
    ],
  }),
);
await page.setInputFiles('input[type=file]', {
  name: 'aligned.docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  buffer: alignedDocx,
});
await page.getByText('Quick question about your chapters').waitFor({ timeout: 10_000 });
check(
  (await page.locator('.review-candidate').first().textContent()) === 'The Reckoning',
  'alignment-centered docx line offered as candidate',
);
await page.getByText("Yes, it's a chapter title").click();
await page.getByText("Here's your book!").waitFor({ timeout: 10_000 });
check(
  (await page.locator('.chapter-list .chapter-title').first().textContent()) === 'The Reckoning',
  'alignment-centered title became a chapter',
);

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll smoke checks passed. Screenshots: /tmp/galley-home.png, /tmp/galley-book.png');
