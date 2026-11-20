import { shareImagePath } from '../public/share-image.mjs';
const escape = value =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export async function applyShareMetadata(response, env) {
  if (response.status !== 200 || !response.headers.get('Content-Type')?.includes('text/html')) return response;
  const setting = await env.DB.prepare(
    "SELECT json_extract(value,'$.share_image') AS image, json_extract(value,'$.share_title') AS title, json_extract(value,'$.share_description') AS description FROM settings WHERE key='site'"
  ).first();
  if (!setting) return response;
  const title = typeof setting.title === 'string' ? setting.title.trim() : '',
    description = typeof setting.description === 'string' ? setting.description.trim() : '';
  const image =
    setting.image && typeof setting.image === 'string'
      ? await env.DB.prepare("SELECT mime FROM images WHERE id=? AND visibility='public'").bind(setting.image).first()
      : null;
  if (!image && !title && !description) return response;
  const values = new Map();
  if (title) {
    values.set('og:title', title);
    values.set('twitter:title', title);
  }
  if (description) {
    values.set('og:description', description);
    values.set('twitter:description', description);
  }
  if (image) {
    const url = new URL(shareImagePath(setting.image), env.APP_ORIGIN).href;
    values.set('og:image', url);
    values.set('twitter:image', url);
    values.set('og:image:type', image.mime);
    values.set('og:image:alt', 'Nocturne Planetの共有サムネイル');
    values.set('twitter:image:alt', 'Nocturne Planetの共有サムネイル');
  }
  const headers = new Headers(response.headers);
  headers.delete('ETag');
  headers.delete('Content-Length');
  headers.set('Cache-Control', 'no-store');
  response = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  if (typeof HTMLRewriter !== 'undefined')
    return new HTMLRewriter()
      .on('meta[property], meta[name]', {
        element(element) {
          const key = element.getAttribute('property') || element.getAttribute('name');
          if (values.has(key)) element.setAttribute('content', escape(values.get(key)));
          else if (image && ['og:image:width', 'og:image:height'].includes(key)) element.remove();
        }
      })
      .transform(response);
  // Node-based fixtures use the same substitutions without a Workers runtime.
  const html = (await response.text()).replace(
    /<meta (property|name)="([^"]+)" content="[^"]*">/g,
    (tag, attribute, key) => {
      if (values.has(key)) return `<meta ${attribute}="${key}" content="${escape(values.get(key))}">`;
      return image && ['og:image:width', 'og:image:height'].includes(key) ? '' : tag;
    }
  );
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}
