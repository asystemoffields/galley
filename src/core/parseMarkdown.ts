import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import { parse as parseYaml } from 'yaml';
import type { Root, RootContent, PhrasingContent, Paragraph } from 'mdast';
import { SCENE_BREAK_RE, type Block, type Book, type BookMetadata, type Chapter, type Run } from './model';
import { outlineToChapters, type OutlineItem } from './chapterize';

const processor = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']);

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
    const { title, chapters } = outlineToChapters(nodesToOutline(tree.children), {
      detectTitle: true,
    });
    if (title) metadata.title ??= title;
    return finishBook(metadata, chapters, files[0].name);
  }

  const sorted = [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  const chapters: Chapter[] = [];
  for (const file of sorted) {
    const tree = processor.parse(neutralizeTildeFences(file.content)) as Root;
    collectFrontmatter(tree, metadata);
    const items = nodesToOutline(tree.children);
    const result = outlineToChapters(items, { detectTitle: true });
    let fileChapters = result.chapters;
    const fileTitle = result.title;
    if (fileTitle) {
      if (fileChapters.length > 1) {
        // A lone top heading introducing several chapters: this file is a
        // part, and that heading is its name.
        for (const c of fileChapters) c.part ??= fileTitle;
      } else {
        // One chapter under a lone heading: the heading was its title.
        fileChapters = outlineToChapters(items).chapters;
      }
    }
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

function nodesToOutline(nodes: RootContent[]): OutlineItem[] {
  const items: OutlineItem[] = [];
  for (const node of nodes) {
    if (node.type === 'yaml') continue;
    if (node.type === 'heading') {
      const text = phrasingToText(node.children);
      // A bare "#" line is an empty heading in markdown, but to a writer
      // it's a scene break — never treat it as a structural heading.
      if (text === '') {
        items.push({ kind: 'blocks', blocks: [{ kind: 'scene-break' }] });
      } else {
        items.push({ kind: 'heading', depth: node.depth, text });
      }
      continue;
    }
    const blocks = nodeToBlocks(node);
    if (blocks.length) items.push({ kind: 'blocks', blocks });
  }
  return items;
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
      case 'linkReference':
      case 'delete':
        walkPhrasing(node.children, style, out);
        break;
      case 'image':
        break;
      case 'html':
        // Inline raw HTML. A <br> is a line break (treat it like a hard
        // break); anything else — stray tags, author notes like
        // <!-- ... --> — is dropped rather than leaked into the prose as
        // literal text. (Block-level HTML is already dropped in nodeToBlocks.)
        if (/^<br\s*\/?>$/i.test(node.value.trim())) {
          out.push({ text: ' ', italic: style.italic, bold: style.bold });
        }
        break;
      default:
        break;
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
