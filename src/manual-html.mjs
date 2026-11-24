import { generate, lexer, parse as parseCss } from 'css-tree';
import { unzipSync } from 'fflate';
import { parse as parseHtml } from 'parse5';

const elements = new Set(
  'a abbr b blockquote br caption code col colgroup dd div dl dt em h1 h2 h3 h4 h5 h6 hr i li mark ol p pre s small span strong sub sup table tbody td tfoot th thead tr u ul'.split(
    ' '
  )
);
const discarded = new Set(
  'audio button embed iframe input noscript object script select style template textarea video'.split(' ')
);
const voidElements = new Set(['br', 'col', 'hr']);
const properties = new Set(
  'color background-color font-weight font-style line-height list-style-type text-align text-indent vertical-align border-collapse'.split(
    ' '
  )
);
const styleProperty =
  /^(?:border(?:-(?:top|right|bottom|left))?(?:-(?:color|style|width))?|(?:margin|padding)(?:-(?:top|right|bottom|left))?|text-decoration(?:-(?:line|color|style|thickness))?)$/;
const plainValue = /^[\w#%.,+\s/-]+$/;
const scope = /^([a-z][\w-]*)?(\.[\w-]+)?$/i;
const maxHtmlBytes = 4 * 1024 * 1024;

export function formattedManual(archive) {
  let htmlEntry;
  let files;
  try {
    files = unzipSync(archive, {
      filter(entry) {
        if (htmlEntry || !/\.html?$/i.test(entry.name) || entry.originalSize > maxHtmlBytes) return false;
        htmlEntry = entry.name;
        return true;
      }
    });
  } catch {
    return null;
  }
  if (!htmlEntry || !files[htmlEntry]?.length || files[htmlEntry].length > maxHtmlBytes) return null;
  const document = parseHtml(new TextDecoder().decode(files[htmlEntry]));
  const html = document.childNodes.find(node => node.tagName === 'html');
  const head = html?.childNodes.find(node => node.tagName === 'head');
  const body = html?.childNodes.find(node => node.tagName === 'body');
  if (!body) return null;
  const rules = documentRules(head);
  const content = body.childNodes
    .map(node => renderNode(node, rules, 0))
    .join('')
    .trim();
  return content ? '<div data-manual-format>' + content + '</div>' : '';
}

function documentRules(head) {
  const rules = new Map();
  let order = 0;
  for (const style of head?.childNodes.filter(node => node.tagName === 'style') ?? []) {
    const sheet = parseCss(style.childNodes.map(node => node.value ?? '').join(''));
    for (const rule of sheet.children) {
      if (rule.type !== 'Rule' || rule.prelude.type !== 'SelectorList') continue;
      const values = declarations(rule.block.children);
      if (!values.length) continue;
      for (const selector of rule.prelude.children) {
        const key = generate(selector);
        const match = scope.exec(key);
        if (!match || (!match[1] && !match[2])) continue;
        if (!rules.has(key)) rules.set(key, []);
        rules.get(key).push({ order: order++, priority: (match[1] ? 1 : 0) + (match[2] ? 10 : 0), values });
      }
    }
  }
  return rules;
}

function declarations(nodes) {
  const result = [];
  for (const node of nodes) {
    if (node.type !== 'Declaration') continue;
    const name = node.property.toLowerCase();
    const property = name === 'background' ? 'background-color' : name;
    if (!properties.has(property) && !styleProperty.test(property)) continue;
    const value = generate(node.value);
    // Permit colors and simple values without retaining URLs, CSS variables or custom functions.
    if (!plainValue.test(value.replace(/\b(?:rgba?|hsla?)\(([\d.,+\s%/-]+)\)/gi, '$1'))) continue;
    if (lexer.matchProperty(property, value).matched) result.push(property + ':' + value);
  }
  return result;
}

function renderNode(node, rules, depth) {
  if (node.nodeName === '#text') return escapeHtml(node.value);
  if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || discarded.has(node.tagName) || depth > 64) return '';
  const tag = node.tagName;
  const attrs = new Map(node.attrs.map(attr => [attr.name, attr.value]));
  if (tag === 'img') return escapeHtml(attrs.get('alt') ?? '');
  const children = node.childNodes.map(child => renderNode(child, rules, depth + 1)).join('');
  if (!elements.has(tag)) return children;

  const classes = (attrs.get('class') ?? '').split(/\s+/).filter(Boolean);
  const selectors = [tag, ...classes.flatMap(className => ['.' + className, tag + '.' + className])];
  const matched = selectors
    .flatMap(selector => rules.get(selector) ?? [])
    .sort((a, b) => a.priority - b.priority || a.order - b.order);
  const values = matched.flatMap(rule => rule.values);
  const inline = attrs.get('style');
  if (inline) values.push(...declarations(parseCss(inline, { context: 'declarationList' }).children));
  let attributes = values.length ? ' data-manual-style="' + escapeHtml(values.join(';')) + '"' : '';
  if (tag === 'a') {
    const link = attrs.get('href')?.trim();
    if (/^(?:https:\/\/|mailto:|#)/i.test(link ?? '')) attributes += ' href="' + escapeHtml(link) + '"';
  }
  for (const name of ['colspan', 'rowspan', 'start', 'value']) {
    const allowed = name === 'start' ? tag === 'ol' : name === 'value' ? tag === 'li' : tag === 'td' || tag === 'th';
    const value = attrs.get(name);
    if (allowed && /^\d{1,5}$/.test(value ?? '')) attributes += ' ' + name + '="' + value + '"';
  }
  const open = '<' + tag + attributes + '>';
  return voidElements.has(tag) ? open : open + children + '</' + tag + '>';
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
