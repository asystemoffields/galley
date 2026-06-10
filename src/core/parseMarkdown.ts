import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import { parse as parseYaml } from 'yaml';
import type {
  Root,
  RootContent,
  PhrasingContent,
  Paragraph,
  Heading,
} from 'mdast';
import type { Block, Book, BookMetadata, Chapter, Run } from './model';

const processor = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']);

/** Paragraphs that are really scene-break markers writers type by hand. */
const SCENE_BREAK_RE = /^\s*(?:#|\*\s*\*\s*\*|\* \* \*|~+|·+)\s*$/;

interface NamedFile {
  name: string;
  content: string;
}

/**
 * Parse one or more markdown files into a Book.
 *
 * One file: chapters are split on the shallowest heading level present.
 * Several files: each file is a chapter (sorted by filename), titled by
 * its first heading or its filename.
 */
export function parseMarkdown(files: NamedFile[]): Book {
  const metadata: Partial<BookMetadata> = {};

  if (files.length === 1) {
    const tree = processor.parse(neutralizeTildeFences(files[0].content)) as Root;
    collectFrontmatter(tree, metadata);
    const nodes = [...tree.children];
    const docTitle = takeDocumentTitle(nodes);
    if (docTitle !== null) metadata.title ??= docTitle;
    const chapters = splitIntoChapters(nodes);
    return finishBook(metadata, chapters, files[0].name);
  }

  const sorted = [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  const chapters: Chapter[] = [];
  for (const file of sorted) {
    const tree = processor.parse(neutralizeTildeFences(file.content)) as Root;
    collectFrontmatter(tree, metadata);
    const fileChapters = splitIntoChapters(tree.children);
    if (fileChapters.length === 1 && !fileChapters[0].title) {
      fileChapters[0].title = titleFromFilename(file.name);
    }
    chapters.push(...fileChapters.filter((c) => c.blocks.length > 0 || c.title));
  }
  return finishBook(metadata, chapters);
}

function finishBook(
  metadata: Partial<BookMetadata>,
  chapters: Chapter[],
  filename?: string,
): Book {
  return {
    metadata: {
      title: metadata.title ?? (filename ? titleFromFilename(filename) : ''),
      author: metadata.author ?? '',
      legalName: metadata.legalName,
      address: metadata.address,
      email: metadata.email,
      phone: metadata.phone,
      language: metadata.language,
    },
    chapters,
  };
}

/**
 * A line of tildes is a scene break to a writer, but a (usually unclosed)
 * code fence to CommonMark — which would silently swallow the rest of the
 * file. Manuscripts don't contain code fences, so rewrite tilde-only lines
 * into thematic breaks before parsing.
 */
function neutralizeTildeFences(content: string): string {
  return content.replace(/^[ \t]{0,3}~{3,}[ \t]*$/gm, '* * *');
}

/**
 * Writers often put the book title as a lone top-level heading above
 * deeper chapter headings (`# My Novel` then `## Chapter One`). If the
 * shallowest heading level occurs exactly once, opens the document, and
 * deeper headings exist, treat it as the title — not a chapter boundary
 * that would swallow the whole book into one chapter. Removes the heading
 * from `nodes` and returns its text, or null if the shape doesn't match.
 */
function takeDocumentTitle(nodes: RootContent[]): string | null {
  const headings = nodes.filter(
    (n): n is Heading => n.type === 'heading' && phrasingToText(n.children) !== '',
  );
  if (headings.length < 2) return null;
  const depths = headings.map((h) => h.depth);
  const minDepth = Math.min(...depths);
  if (depths.filter((d) => d === minDepth).length !== 1) return null;
  const first = nodes.find((n) => n.type !== 'yaml');
  if (first !== headings[0] || headings[0].depth !== minDepth) return null;
  nodes.splice(nodes.indexOf(first), 1);
  return phrasingToText(headings[0].children);
}

function titleFromFilename(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/^\d+\s*/, '')
    .trim();
}

function collectFrontmatter(tree: Root, into: Partial<BookMetadata>) {
  for (const node of tree.children) {
    if (node.type !== 'yaml') continue;
    let data: unknown;
    try {
      data = parseYaml(node.value);
    } catch {
      continue;
    }
    if (!data || typeof data !== 'object') continue;
    const d = data as Record<string, unknown>;
    const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : undefined);
    into.title ??= str('title');
    into.author ??= str('author');
    into.legalName ??= str('legal-name') ?? str('legalName') ?? str('name');
    into.address ??= str('address');
    into.email ??= str('email');
    into.phone ??= str('phone');
    into.language ??= str('language') ?? str('lang');
  }
}

function splitIntoChapters(nodes: RootContent[]): Chapter[] {
  // A bare "#" line is an empty heading in markdown, but to a writer it's
  // a scene break — never treat empty headings as chapter boundaries.
  const headingDepths = nodes
    .filter((n): n is Heading => n.type === 'heading' && phrasingToText(n.children) !== '')
    .map((h) => h.depth);
  const splitDepth = headingDepths.length ? Math.min(...headingDepths) : null;

  const chapters: Chapter[] = [];
  let current: Chapter = { title: '', blocks: [] };

  const flush = () => {
    if (current.title || current.blocks.length) chapters.push(current);
    current = { title: '', blocks: [] };
  };

  for (const node of nodes) {
    if (node.type === 'heading') {
      const text = phrasingToText(node.children);
      if (text === '') {
        current.blocks.push({ kind: 'scene-break' });
        continue;
      }
      if (node.depth === splitDepth) {
        flush();
        current.title = text;
        continue;
      }
    }
    current.blocks.push(...nodeToBlocks(node));
  }
  flush();
  return chapters.length ? chapters : [{ title: '', blocks: [] }];
}

function nodeToBlocks(node: RootContent): Block[] {
  switch (node.type) {
    case 'paragraph': {
      const runs = paragraphToRuns(node);
      const text = runs.map((r) => r.text).join('');
      if (SCENE_BREAK_RE.test(text)) return [{ kind: 'scene-break' }];
      if (!text.trim()) return [];
      return [{ kind: 'paragraph', runs }];
    }
    case 'thematicBreak':
      return [{ kind: 'scene-break' }];
    case 'heading':
      // Deeper headings than the chapter split level: keep as a bold paragraph.
      return [
        {
          kind: 'paragraph',
          runs: [{ text: phrasingToText(node.children), bold: true }],
        },
      ];
    case 'blockquote':
      return node.children.flatMap(nodeToBlocks);
    case 'list':
      return node.children.flatMap((item) => item.children.flatMap(nodeToBlocks));
    case 'yaml':
    case 'html':
    case 'code':
      return [];
    default:
      return [];
  }
}

function paragraphToRuns(p: Paragraph): Run[] {
  const runs: Run[] = [];
  walkPhrasing(p.children, { italic: false, bold: false }, runs);
  return mergeRuns(runs);
}

function walkPhrasing(
  nodes: PhrasingContent[],
  style: { italic: boolean; bold: boolean },
  out: Run[],
) {
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push({ text: node.value, italic: style.italic, bold: style.bold });
        break;
      case 'emphasis':
        walkPhrasing(node.children, { ...style, italic: true }, out);
        break;
      case 'strong':
        walkPhrasing(node.children, { ...style, bold: true }, out);
        break;
      case 'inlineCode':
        out.push({ text: node.value, italic: style.italic, bold: style.bold });
        break;
      case 'break':
        out.push({ text: ' ', italic: style.italic, bold: style.bold });
        break;
      case 'link':
      case 'delete':
        walkPhrasing(node.children, style, out);
        break;
      case 'image':
        break;
      default:
        if ('value' in node && typeof node.value === 'string') {
          out.push({ text: node.value, italic: style.italic, bold: style.bold });
        }
    }
  }
}

function mergeRuns(runs: Run[]): Run[] {
  const merged: Run[] = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    if (prev && !!prev.italic === !!run.italic && !!prev.bold === !!run.bold) {
      prev.text += run.text;
    } else {
      merged.push({ ...run });
    }
  }
  return merged.filter((r) => r.text !== '');
}

function phrasingToText(nodes: PhrasingContent[]): string {
  const runs: Run[] = [];
  walkPhrasing(nodes, { italic: false, bold: false }, runs);
  return runs.map((r) => r.text).join('').trim();
}
