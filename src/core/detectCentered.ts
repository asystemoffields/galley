import { SCENE_BREAK_RE } from './model';

/**
 * Writers without proper heading styles often center a chapter title by
 * hand: a run of tabs or spaces, the title, and nothing else on the line.
 * These helpers find such lines so the UI can ask the writer about each
 * one, and rewrite them once the writer has answered.
 *
 * In markdown this matters doubly: an indented line is a code block to
 * CommonMark, and Galley drops code blocks — so a hand-centered title in
 * a .txt manuscript would otherwise vanish without a trace.
 */

export interface CenteredCandidate {
  /** Line index (markdown) or paragraph index (docx) in the source. */
  index: number;
  /** The candidate title, trimmed. */
  text: string;
  /** Nearest text before/after, for showing context when we ask. */
  before?: string;
  after?: string;
}

/** Tabs push text further than spaces; weigh them like a typewriter would. */
function leadingWeight(line: string): number {
  let weight = 0;
  for (const ch of line) {
    if (ch === '\t') weight += 4;
    else if (ch === ' ') weight += 1;
    else break;
  }
  return weight;
}

/** Shaped like a title: short, has words, not a scene-break marker. */
function isTitleShaped(text: string): boolean {
  return (
    text.length > 0 && text.length <= 60 && /[\p{L}\p{N}]/u.test(text) && !SCENE_BREAK_RE.test(text)
  );
}

/**
 * Indented far enough to be deliberate centering (two tabs or eight
 * spaces — a single tab is just a paragraph indent), and the text is
 * shaped like a title.
 */
function isCenteredShaped(line: string): boolean {
  return leadingWeight(line) >= 8 && isTitleShaped(line.trim());
}

const clip = (s: string) => (s.length > 140 ? s.slice(0, 139) + '…' : s);

/**
 * If a fifth of a manuscript matches, that isn't centered titles — it's
 * an indentation style we've misread. Better to ask nothing.
 */
function plausible<T>(found: T[], population: number): T[] {
  return found.length > 20 && found.length * 5 > population ? [] : found;
}

/**
 * Find hand-centered candidate lines in raw markdown / plain text.
 * A candidate must sit alone — blank lines (or the document edge) on
 * both sides — so multi-line centered passages like poems don't match.
 */
export function findCenteredLines(content: string): CenteredCandidate[] {
  const lines = content.split('\n');
  const blank = (i: number) => i < 0 || i >= lines.length || lines[i].trim() === '';
  const found: CenteredCandidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isCenteredShaped(lines[i]) || !blank(i - 1) || !blank(i + 1)) continue;
    let b = i - 1;
    while (b >= 0 && lines[b].trim() === '') b--;
    let a = i + 1;
    while (a < lines.length && lines[a].trim() === '') a++;
    found.push({
      index: i,
      text: lines[i].trim(),
      before: b >= 0 ? clip(lines[b].trim()) : undefined,
      after: a < lines.length ? clip(lines[a].trim()) : undefined,
    });
  }
  return plausible(found, lines.filter((l) => l.trim() !== '').length);
}

/**
 * Find centered candidates in a list of docx paragraph texts — centered
 * either by hand with whitespace, or (per `aligned`) by Word's center
 * alignment. Paragraphs are standalone by construction, so no
 * blank-line test.
 */
export function findCenteredTexts(
  texts: string[],
  opts: {
    eligible?: (index: number) => boolean;
    aligned?: (index: number) => boolean;
  } = {},
): CenteredCandidate[] {
  const { eligible = () => true, aligned = () => false } = opts;
  const found: CenteredCandidate[] = [];
  texts.forEach((text, i) => {
    if (!eligible(i)) return;
    if (!isCenteredShaped(text) && !(aligned(i) && isTitleShaped(text.trim()))) return;
    found.push({
      index: i,
      text: text.trim(),
      before: i > 0 ? clip(texts[i - 1].trim()) : undefined,
      after: i + 1 < texts.length ? clip(texts[i + 1].trim()) : undefined,
    });
  });
  return plausible(found, texts.length);
}

/**
 * Heading depth to promote confirmed titles to: beside the existing
 * chapter headings when there are any; one deeper than a lone opening
 * heading (that's the book title, but only if it actually opens the
 * document — `firstIsHeading`); depth 1 in an unstructured document.
 */
export function depthForPromotion(depths: number[], firstIsHeading: boolean): number {
  if (depths.length === 0) return 1;
  const min = Math.min(...depths);
  const lone =
    firstIsHeading && depths[0] === min && depths.filter((d) => d === min).length === 1;
  return lone ? Math.min(min + 1, 6) : min;
}

/** Is the first content of this markdown (after frontmatter) a heading? */
export function firstContentIsHeading(content: string): boolean {
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (lines[i]?.trim() === '---') {
    i++;
    while (i < lines.length && lines[i].trim() !== '---') i++;
    i++;
    while (i < lines.length && lines[i].trim() === '') i++;
  }
  return i < lines.length && /^ {0,3}#{1,6}\s+\S/.test(lines[i]);
}

/** ATX heading depths, in document order, from raw markdown. */
export function headingDepths(content: string): number[] {
  const out: number[] = [];
  for (const line of content.split('\n')) {
    const m = /^ {0,3}(#{1,6})\s+\S/.exec(line);
    if (m) out.push(m[1].length);
  }
  return out;
}

/**
 * Apply the writer's answers to raw markdown. Confirmed lines become
 * headings; declined lines are dedented so the parser reads them as
 * prose instead of an indented code block it would silently drop.
 */
export function applyCenteredDecisions(
  content: string,
  decisions: ReadonlyMap<number, boolean>,
  depth: number,
): string {
  if (decisions.size === 0) return content;
  const lines = content.split('\n');
  for (const [index, isTitle] of decisions) {
    const text = lines[index]?.trim();
    if (!text) continue;
    lines[index] = isTitle ? `${'#'.repeat(depth)} ${text}` : text;
  }
  return lines.join('\n');
}
