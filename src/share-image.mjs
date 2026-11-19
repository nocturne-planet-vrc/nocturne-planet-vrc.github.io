import {shareImagePath} from '../public/share-image.mjs';

export async function applyShareImage(response,env){
  if(response.status!==200||!response.headers.get('Content-Type')?.includes('text/html'))return response;
  const setting=await env.DB.prepare("SELECT json_extract(value,'$.share_image') AS image FROM settings WHERE key='site'").first();
  if(!setting?.image||typeof setting.image!=='string')return response;
  const image=await env.DB.prepare("SELECT mime FROM images WHERE id=? AND visibility='public'").bind(setting.image).first();
  if(!image)return response;
  const url=new URL(shareImagePath(setting.image),env.APP_ORIGIN).href;
  const headers=new Headers(response.headers);headers.delete('ETag');headers.delete('Content-Length');headers.set('Cache-Control','no-store');
  response=new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  if(typeof HTMLRewriter!=='undefined')return new HTMLRewriter()
    .on('meta[property="og:image"], meta[name="twitter:image"]',{element(element){element.setAttribute('content',url);}})
    .on('meta[property="og:image:type"]',{element(element){element.setAttribute('content',image.mime);}})
    .on('meta[property="og:image:alt"], meta[name="twitter:image:alt"]',{element(element){element.setAttribute('content','Nocturne Planetの共有サムネイル');}})
    .on('meta[property="og:image:width"], meta[property="og:image:height"]',{element(element){element.remove();}})
    .transform(response);
  // Node-based fixtures use the same substitutions without a Workers runtime.
  const html=(await response.text()).replace(/<meta (property="og:image"|name="twitter:image") content="[^"]*">/g,(_,attribute)=>`<meta ${attribute} content="${url}">`).replace(/<meta property="og:image:type" content="[^"]*">/,`<meta property="og:image:type" content="${image.mime}">`).replace(/<meta (property="og:image:alt"|name="twitter:image:alt") content="[^"]*">/g,(_,attribute)=>`<meta ${attribute} content="Nocturne Planetの共有サムネイル">`).replace(/\s*<meta property="og:image:(width|height)" content="[^"]*">/g,'');
  return new Response(html,{status:response.status,statusText:response.statusText,headers});
}
