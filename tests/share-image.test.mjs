import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';
import {defaultShareImage} from '../public/share-image.mjs';

const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=','base64'));
const save=(f,body,extra={})=>f.request('/api/manage/settings',{user:'admin',method:'POST',body,...extra});
async function setup(t){const f=await fixture();t.after(f.close);await f.connectDrive();return f;}
async function upload(f){const body=new FormData();body.set('image',new File([png],'thumbnail.png',{type:'image/png'}));const response=await f.request('/api/manage/images',{user:'admin',method:'POST',body});assert.equal(response.status,200);return (await response.json()).id;}
const meta=(html,key)=>new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`).exec(html)?.[1];
const decodedMeta=(html,key)=>meta(html,key)?.replaceAll('&quot;','"').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');

test('画像を変えずに共有タイトルと説明文を保存でき、安全に全ページの共有タグへ反映する',async t=>{
  const f=await setup(t),title='星空の "のくぷら" & <イベント>',description='星を眺めて、話して、歌を楽しむ。\n"><script>alert(1)</script> $&';
  for(const [user,status] of [[undefined,401],['customer',403],['staff',403]])assert.equal((await save(f,{share_title:title,share_description:description},{user})).status,status);
  assert.equal((await save(f,{share_title:title},{csrf:false})).status,403);
  assert.equal((await save(f,{share_title:title,share_description:description})).status,200);
  assert.equal((await save(f,{about:'ほかの設定を変更'})).status,200);
  for(const path of ['/','/recruit','/schedule','/member','/staff','/manage','/privacy.html','/news/example']){
    const response=await f.request(path,{headers:{'If-None-Match':'old'}}),html=await response.text();assert.equal(response.status,200,path);
    for(const prefix of ['og','twitter']){assert.equal(decodedMeta(html,prefix+':title'),title,path);assert.equal(decodedMeta(html,prefix+':description'),description,path);}
    assert.equal(meta(html,'og:image'),'https://nocturne-planet.pages.dev'+defaultShareImage.path);assert.equal(meta(html,'og:image:width'),'2000');
    assert.equal(html.includes('<script>alert(1)</script>'),false);assert.equal(response.headers.get('Cache-Control'),'no-store');
  }
});

test('共有文言は項目ごとに初期表示へ戻せて、画像設定も保持する',async t=>{
  const f=await setup(t),id=await upload(f),initial=await (await f.request('/recruit')).text();
  await save(f,{share_image:id,share_title:'共通タイトル',share_description:'共通の説明'});
  assert.equal((await save(f,{share_title:'  '})).status,200);
  let html=await (await f.request('/recruit')).text();assert.equal(meta(html,'og:title'),meta(initial,'og:title'));assert.equal(meta(html,'og:description'),'共通の説明');
  assert.equal(meta(html,'og:image'),f.env.APP_ORIGIN+'/api/images/'+id);
  await save(f,{share_description:''});html=await (await f.request('/recruit')).text();assert.equal(meta(html,'og:description'),meta(initial,'og:description'));
  assert.equal(meta(html,'og:image'),f.env.APP_ORIGIN+'/api/images/'+id);
  await save(f,{share_image:''});html=await (await f.request('/recruit')).text();assert.equal(meta(html,'twitter:title'),meta(initial,'twitter:title'));assert.equal(meta(html,'twitter:description'),meta(initial,'twitter:description'));
});

test('共有文言の文字数と型を検証する',async t=>{
  const f=await setup(t);
  for(const [key,max] of [['share_title',120],['share_description',500]]){
    assert.equal((await save(f,{[key]:'あ'.repeat(max)})).status,200);
    for(const value of ['あ'.repeat(max+1),null,{},[],123])assert.equal((await save(f,{[key]:value})).status,400);
  }
});

test('共有サムネイルを保存すると、JavaScriptを実行しない共有先にも全ページのHTMLで返す',async t=>{
  const f=await setup(t),id=await upload(f);
  for(const [user,status] of [[undefined,401],['customer',403],['staff',403]])assert.equal((await save(f,{share_image:id},{user})).status,status);
  assert.equal((await save(f,{share_image:id},{csrf:false})).status,403);assert.equal((await save(f,{share_image:id})).status,200);
  assert.equal((await save(f,{about:'ほかの設定を保存してもサムネイルを保持'})).status,200);
  for(const path of ['/','/recruit','/schedule','/member','/staff','/manage','/privacy.html','/news/example']){
    const response=await f.request(path),html=await response.text();assert.equal(response.status,200,path);
    assert.equal(meta(html,'og:image'),f.env.APP_ORIGIN+'/api/images/'+id,path);assert.equal(meta(html,'twitter:image'),meta(html,'og:image'),path);
    assert.equal(meta(html,'og:image:type'),'image/png');assert.equal(meta(html,'og:image:width'),undefined);assert.equal(meta(html,'og:image:height'),undefined);
    assert.equal(response.headers.get('Cache-Control'),'no-store');
    if(['/member','/staff','/manage'].includes(path))assert.equal(response.headers.get('X-Robots-Tag'),'noindex, nofollow');
  }
  assert.equal((await f.request('/api/images/'+id)).status,200);
});

test('初期画像へ戻せて、共有から外した写真や非公開チェキを公開しない',async t=>{
  const f=await setup(t),id=await upload(f);await f.cheki({image:'private-thumbnail'});
  assert.equal((await save(f,{share_image:id})).status,200);
  for(const value of ['private-thumbnail','missing','https://example.test/image.png','/assets/unknown.png',{},null])assert.equal((await save(f,{share_image:value})).status,400);
  assert.equal((await f.request('/api/images/private-thumbnail')).status,401);
  assert.equal((await save(f,{share_image:''})).status,200);
  const html=await (await f.request('/')).text();assert.equal(meta(html,'og:image'),'https://nocturne-planet.pages.dev'+defaultShareImage.path);assert.equal(meta(html,'og:image:width'),'2000');
  assert.equal((await f.request('/api/images/'+id)).status,401);
});

test('HTMLの条件付き取得でも、保存後の共有画像を古い304応答で隠さない',async t=>{
  const f=await setup(t),id=await upload(f);await save(f,{share_image:id});
  const assets=f.env.ASSETS.fetch;let conditional;
  f.env.ASSETS.fetch=async request=>{conditional=request.headers.get('If-None-Match');if(conditional)return new Response(null,{status:304});const response=await assets(request);response.headers.set('ETag','old-static-template');return response;};
  const response=await f.request('/',{headers:{'If-None-Match':'old-static-template','If-Modified-Since':'Wed, 18 Nov 2026 00:00:00 GMT'}});
  assert.equal(conditional,null);assert.equal(response.status,200);assert.equal(response.headers.get('ETag'),null);assert.equal(meta(await response.text(),'og:image'),f.env.APP_ORIGIN+'/api/images/'+id);
});
