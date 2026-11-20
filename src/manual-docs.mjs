import MarkdownIt from 'markdown-it';
import { HttpError } from './core.mjs';
import { exportDriveDocument } from './drive.mjs';
import { googleDocUrl } from './staff-resources.mjs';

const markdown = new MarkdownIt({ html: false, breaks: true });
const validateLink = markdown.validateLink;
markdown.validateLink = url => validateLink(url) && /^(?:https:\/\/|mailto:|#)/i.test(url);
// Keep embedded media in Google Docs. Never load third-party images in the staff portal.
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);

export async function readManualDocument(url, env, fetcher) {
  const source = googleDocUrl(url);
  if (!source) throw new HttpError(400, '先に Google ドキュメントのリンクを入れてください。');
  const id = new URL(source).pathname.split('/')[3];
  const body = await exportDriveDocument(id, env, fetcher);
  return { html: markdown.render(body.trim()) };
}
