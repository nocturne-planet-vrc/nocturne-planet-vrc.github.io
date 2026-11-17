import {HttpError,text,httpsUrl} from './core.mjs';
import {facilityPhotos,siteContent} from '../public/site-content.mjs';
const owns=(data,key)=>Object.hasOwn(data,key);
function minutes(value){if(!Number.isInteger(value)||value<0||value>600)throw new HttpError(400,'所要時間は0〜600分の整数で入力してください。');return value;}
export async function siteSettingsPatch(data,env){
  if(!data||typeof data!=='object'||Array.isArray(data))throw new HttpError(400,'設定内容を確認してください。');
  const patch={};
  for(const key of ['x_url','youtube_url','discord_invite','vrchat_group_url','venue_url'])if(owns(data,key))patch[key]=httpsUrl(data[key]);
  for(const key of ['about','admission','cadence','venue','facility_intro'])if(owns(data,key))patch[key]=text(data[key],['about','facility_intro'].includes(key)?4000:160,key==='venue');
  for(const key of ['main_minutes','after_minutes'])if(owns(data,key))patch[key]=minutes(data[key]);
  if(owns(data,'youtube_video')){
    patch.youtube_video=text(data.youtube_video,100);
    if(patch.youtube_video&&!/^[a-zA-Z0-9_-]{11}$/.test(patch.youtube_video))throw new HttpError(400,'YouTubeの動画ID（11文字）を指定してください。');
  }
  async function image(value,allowFacilityPhoto=false){
    if(allowFacilityPhoto&&facilityPhotos.some(([path])=>path===value))return value;
    if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(value))throw new HttpError(400,'公開用画像を指定してください。');
    if(!await env.DB.prepare("SELECT id FROM images WHERE id=? AND visibility='public'").bind(value).first())throw new HttpError(400,'公開用画像を指定してください。');
    return value;
  }
  for(const key of ['programs','facilities'])if(owns(data,key)){
    if(!Array.isArray(data[key])||data[key].length!==3)throw new HttpError(400,'プログラム・施設紹介はそれぞれ3項目を設定してください。');
    patch[key]=[];
    for(const entry of data[key]){
      if(!entry||typeof entry!=='object'||Array.isArray(entry))throw new HttpError(400,'紹介内容を確認してください。');
      const item={title:text(entry.title,80,true),description:text(entry.description,key==='programs'?1000:160),image:await image(entry.image,true)};
      if(key==='programs')Object.assign(item,{minutes:minutes(entry.minutes),detail:text(entry.detail,80),caption:text(entry.caption,120)});
      patch[key].push(item);
    }
  }
  if(owns(data,'main_minutes')||owns(data,'programs')){
    const saved=JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key='site'").first())?.value||'{}');
    const current=siteContent({...saved,...patch});
    if(current.programs.reduce((total,p)=>total+p.minutes,0)>current.main_minutes)throw new HttpError(400,'本編の時間は、3つのプログラムの合計時間以上にしてください。');
  }
  if(owns(data,'hero_images')||owns(data,'hero_image')){
    const photos=data.hero_images===undefined?(data.hero_image?[data.hero_image]:[]):data.hero_images;
    if(!Array.isArray(photos)||photos.length>12)throw new HttpError(400,'トップ写真は12枚まで登録できます。');
    patch.hero_images=[...new Set(await Promise.all(photos.map(value=>image(value))))];patch.hero_image=patch.hero_images[0]||'';
  }
  return patch;
}
