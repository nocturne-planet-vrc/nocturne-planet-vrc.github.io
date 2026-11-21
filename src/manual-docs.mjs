import MarkdownIt from 'markdown-it';
import { HttpError, sha256 } from './core.mjs';
import { exportDriveDocument } from './drive.mjs';
import { googleDocUrl } from './staff-resources.mjs';

const markdown = new MarkdownIt({ html: false, breaks: true });
const cacheTtl = 60_000;
const validateLink = markdown.validateLink;
markdown.validateLink = url => validateLink(url) && /^(?:https:\/\/|mailto:|#)/i.test(url);
// Keep embedded media in Google Docs. Never load third-party images in the staff portal.
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);

export async function readManualDocument(url, env, fetcher, integrationValue) {
  const source = googleDocUrl(url);
  if (!source) throw new HttpError(400, '先に Google ドキュメントのリンクを入れてください。');
  const id = new URL(source).pathname.split('/')[3];
  const body = await exportDriveDocument(id, env, fetcher, integrationValue);
  return { html: markdown.render(body.trim()) };
}

export async function readPublishedManualDocument(contentId, env, fetcher) {
  const source = await env.DB.prepare(
    `SELECT d.url,c.updated_at,i.value AS integration,m.source_key,m.html,m.fetched_at
    FROM manual_google_docs d JOIN content c ON c.id=d.content_id
    LEFT JOIN integrations i ON i.key='drive'
    LEFT JOIN manual_document_cache m ON m.content_id=d.content_id
      AND m.fetched_at>?
    WHERE c.id=? AND c.kind='manual' AND c.status='published' AND d.inline_body=1`
  )
    .bind(Date.now() - cacheTtl, contentId)
    .first();
  if (!source) throw new HttpError(404, '公開中のマニュアル本文が見つかりません。');
  const sourceKey = await sha256(JSON.stringify([source.url, source.updated_at, source.integration]));
  const fetchedAt = Date.now();
  if (source.source_key === sourceKey && source.fetched_at > fetchedAt - cacheTtl) return { html: source.html };
  const document = await readManualDocument(source.url, env, fetcher, source.integration);
  // Large exports can still be read even when their rendered HTML exceeds the D1 row limit.
  if (new TextEncoder().encode(document.html).byteLength < 1_000_000) {
    await env.DB.prepare(
      `INSERT INTO manual_document_cache(content_id,source_key,html,fetched_at)
      SELECT c.id,?,?,? FROM content c JOIN manual_google_docs d ON d.content_id=c.id
      JOIN integrations i ON i.key='drive'
      WHERE c.id=? AND c.updated_at=? AND c.kind='manual' AND c.status='published'
        AND d.inline_body=1 AND d.url=? AND i.value=?
      ON CONFLICT(content_id) DO UPDATE SET source_key=excluded.source_key,html=excluded.html,fetched_at=excluded.fetched_at
      WHERE manual_document_cache.fetched_at<=excluded.fetched_at`
    )
      .bind(sourceKey, document.html, fetchedAt, contentId, source.updated_at, source.url, source.integration)
      .run();
  }
  return document;
}
