import {HttpError,randomToken} from './core.mjs';
import {handleApi,json} from './api.mjs';
import {startOauth,discordCallback,signOut} from './auth.mjs';
import {googleCallback} from './drive.mjs';

const policy="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https://cdn.discordapp.com; connect-src 'self'; font-src 'self'; frame-src https://www.youtube-nocookie.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
function secure(response,path) {
  const headers=new Headers(response.headers);
  headers.set('X-Content-Type-Options','nosniff'); headers.set('Referrer-Policy','same-origin'); headers.set('X-Frame-Options','DENY');
  headers.set('Content-Security-Policy',policy); headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  if(/^\/(staff|manage|member|auth|api)(\/|$)/.test(path)) {headers.set('Cache-Control','no-store');headers.set('X-Robots-Tag','noindex, nofollow');}
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
export function createWorker(fetcher=fetch) {
  let cleanupAfter=0;
  const cleanup=async env=>{
    const now=Math.floor(Date.now()/1000);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(now),
      env.DB.prepare('DELETE FROM oauth_states WHERE expires_at<?').bind(now),
      env.DB.prepare('DELETE FROM rate_limits WHERE resets_at<?').bind(now)
    ]);
  };
  return {async scheduled(controller,env,ctx) {await cleanup(env);},async fetch(request,env,ctx) {
    const path=new URL(request.url).pathname;
    if(path.startsWith('/api/') && env.DB && ctx?.waitUntil && Date.now()>cleanupAfter) {
      cleanupAfter=Date.now()+3600000;
      ctx.waitUntil(cleanup(env).catch(()=>{}));
    }
    try {
      let response;
      if(path.startsWith('/api/')) response=path==='/api/logout'&&request.method==='POST'?await signOut(request,env):await handleApi(request,env,fetcher);
      else if(path==='/auth/discord') response=await startOauth(request,env,'discord',fetcher);
      else if(path==='/auth/discord/callback') response=await discordCallback(request,env,fetcher);
      else if(path==='/auth/google') response=await startOauth(request,env,'google',fetcher);
      else if(path==='/auth/google/callback') response=await googleCallback(request,env,fetcher);
      else if(['GET','HEAD'].includes(request.method)) {
        const assetUrl=new URL(request.url);
        if(/^\/(staff|manage|member)\/?$/.test(path)) assetUrl.pathname='/portal.html';
        else if(path==='/'||/^\/(news|pages)\/[a-z0-9-]+\/?$/.test(path)) assetUrl.pathname='/index.html';
        response=await env.ASSETS.fetch(new Request(assetUrl,{method:request.method,headers:request.headers}));
      } else throw new HttpError(405,'この操作は利用できません。');
      return secure(response,path);
    } catch(error) {
      const known=error instanceof HttpError,status=known?error.status:500;
      const message=known?error.message:'処理できませんでした。時間を置いてもう一度お試しください。';
      if(path.startsWith('/auth/')) {
        const area=error.destination || (path.includes('google')?'manage':new URL(request.url).searchParams.get('area'));
        const destination=['staff','manage','member'].includes(area)?area:'member';
        return secure(new Response(null,{status:302,headers:{Location:`/${destination}?error=${encodeURIComponent(message)}`}}),path);
      }
      return secure(json({error:message,code:known?error.code:'INTERNAL',request_id:randomToken().slice(0,12)},status),path);
    }
  }};
}
export default createWorker();
