import MarkdownIt from 'markdown-it';
import { HttpError } from './core.mjs';
import { exportDriveDocument } from './drive.mjs';
import { googleDocUrl } from './staff-resources.mjs';

const markdown = new MarkdownIt({ html: false, breaks: true });
const validateLink = markdown.validateLink;
markdown.validateLink = url => validateLink(url) && /^(?:https:\/\/|mailto:|#)/i.test(url);
// Keep embedded media in Google Docs. Never load third-party images in the staff portal.
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);

// Earlier versions stored expiring copies in the same table with a hashed key.
const publishedDocumentKeyPrefix = 'published:';
export const publishedDocumentKeyPattern = `${publishedDocumentKeyPrefix}*`;

export async function readManualDocument(url, env, fetcher) {
  const source = googleDocUrl(url);
  if (!source) throw new HttpError(400, '先に Google ドキュメントのリンクを入れてください。');
  const id = new URL(source).pathname.split('/')[3];
  const body = await exportDriveDocument(id, env, fetcher);
  return { html: markdown.render(body.trim()) };
}

function documentParts(html) {
  if (new TextEncoder().encode(html).byteLength < 1_000_000) return [html];
  const parts = [];
  // Keep each row under 1 MB, with room for UTF-8 characters and row metadata.
  for (let start = 0; start < html.length; ) {
    let end = start + 300_000;
    const next = html.charCodeAt(end);
    if (next >= 0xdc00 && next <= 0xdfff) end--;
    parts.push(html.slice(start, end));
    start = end;
  }
  return parts;
}

export function manualDocumentStatements(env, { contentId, url, updatedAt, html }) {
  const [head, ...parts] = documentParts(html);
  const importId = `${publishedDocumentKeyPrefix}${crypto.randomUUID()}`;
  return [
    env.DB.prepare(
      `INSERT INTO manual_document_cache(content_id,source_key,html,fetched_at)
      SELECT c.id,?,?,? FROM content c JOIN manual_google_docs d ON d.content_id=c.id
      WHERE c.id=? AND c.updated_at=? AND c.kind='manual' AND c.status='published' AND d.inline_body=1 AND d.url=?
      ON CONFLICT(content_id) DO UPDATE SET source_key=excluded.source_key,html=excluded.html,fetched_at=excluded.fetched_at
      WHERE manual_document_cache.source_key NOT GLOB ?`
    ).bind(importId, head, Date.now(), contentId, updatedAt, url, publishedDocumentKeyPattern),
    ...parts.map((part, index) =>
      env.DB.prepare(
        `INSERT INTO manual_document_parts(content_id,part,html)
        SELECT content_id,?,? FROM manual_document_cache WHERE content_id=? AND source_key=?`
      ).bind(index + 1, part, contentId, importId)
    )
  ];
}

async function storedDocument(env, contentId) {
  const { results } = await env.DB.prepare(
    `WITH source AS (
      SELECT d.content_id,d.url,c.updated_at FROM manual_google_docs d JOIN content c ON c.id=d.content_id
      WHERE c.id=? AND c.kind='manual' AND c.status='published' AND d.inline_body=1
    )
    SELECT s.url,s.updated_at,m.html,0 AS part FROM source s
    LEFT JOIN manual_document_cache m ON m.content_id=s.content_id AND m.source_key GLOB ?
    UNION ALL
    SELECT s.url,s.updated_at,p.html,p.part FROM source s JOIN manual_document_parts p ON p.content_id=s.content_id
    ORDER BY part`
  )
    .bind(contentId, publishedDocumentKeyPattern)
    .all();
  if (!results.length) throw new HttpError(404, '公開中のマニュアル本文が見つかりません。');
  const [source] = results;
  return {
    url: source.url,
    updated_at: source.updated_at,
    html: source.html === null ? null : results.map(row => row.html).join('')
  };
}

export async function readPublishedManualDocument(contentId, env, fetcher) {
  const source = await storedDocument(env, contentId);
  if (source.html !== null) return { html: source.html };

  // Backfill published manuals that have never had a stored copy.
  const { html } = await readManualDocument(source.url, env, fetcher);
  const [save] = await env.DB.batch(
    manualDocumentStatements(env, { contentId, url: source.url, updatedAt: source.updated_at, html })
  );
  if (save.meta.changes) return { html };
  const current = await storedDocument(env, contentId);
  if (current.html === null) throw new HttpError(409, 'マニュアルが変更されました。もう一度開いてください。');
  return { html: current.html };
}
