import test from 'node:test';
import assert from 'node:assert/strict';
import {castCard,castProfile} from '../public/casts.mjs';

test('公開とプレビューの共通表示は文章を文字として扱い、危険なリンクを実行しない',()=>{
  const original=globalThis.location;globalThis.location={origin:'https://nocturne-planet.test'};
  try{
    const cast={id:'cast-1',display_name:'<img onerror=alert(1)>',tagline:'<script>alert(1)</script>',bio:'1行目\n<script>alert(2)</script>',image_id:'photo-1',x_url:'javascript:alert(3)',youtube_url:'https://www.youtube.com/@example'};
    const card=castCard(cast),profile=castProfile(cast);
    for(const html of [card,profile]){assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img onerror='));assert.ok(html.includes('/api/images/photo-1'));assert.ok(html.includes('&lt;script&gt;'));}
    assert.ok(profile.includes('href="#"'));assert.ok(!profile.includes('href="javascript:'));
    assert.ok(profile.includes('1行目\n&lt;script&gt;'));assert.ok(profile.includes('https://www.youtube.com/@example'));
    assert.ok(profile.includes('rel="noopener noreferrer"'));
    assert.ok(profile.includes('お気に入りキャストに登録'));
  }finally{if(original===undefined)delete globalThis.location;else globalThis.location=original;}
});

test('写真・SNS未設定の紹介も一覧とプロフィールを表示できる',()=>{
  const cast={id:'cast-1',display_name:'キャスト',tagline:'',bio:'',image_id:null,x_url:'',youtube_url:''};
  const card=castCard(cast),profile=castProfile(cast);
  assert.ok(card.includes('/assets/logo-dark.svg'));assert.ok(profile.includes('<h2>キャスト</h2>'));
  assert.ok(!profile.includes('cast-portrait'));assert.ok(!profile.includes('target="_blank"'));
});
