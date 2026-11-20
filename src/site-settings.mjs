import { HttpError, text, httpsUrl } from './core.mjs';
import { facilityPhotos, siteContent } from '../public/site-content.mjs';
import { blockTypes } from '../public/recruit-content.mjs';
const owns = (data, key) => Object.hasOwn(data, key);
function minutes(value) {
  if (!Number.isInteger(value) || value < 0 || value > 600)
    throw new HttpError(400, '所要時間は0〜600分の整数で入力してください。');
  return value;
}
export async function siteSettingsPatch(data, env) {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new HttpError(400, '設定内容を確認してください。');
  const patch = {};
  for (const [key, max] of [
    ['share_title', 120],
    ['share_description', 500]
  ])
    if (owns(data, key)) patch[key] = text(data[key], max);
  for (const key of ['x_url', 'youtube_url', 'discord_invite', 'vrchat_group_url', 'venue_url', 'recruit_url'])
    if (owns(data, key)) patch[key] = httpsUrl(data[key]);
  for (const key of ['about', 'admission', 'cadence', 'venue', 'facility_intro'])
    if (owns(data, key))
      patch[key] = text(data[key], ['about', 'facility_intro'].includes(key) ? 4000 : 160, key === 'venue');
  for (const key of ['main_minutes', 'after_minutes']) if (owns(data, key)) patch[key] = minutes(data[key]);
  if (owns(data, 'youtube_video')) {
    patch.youtube_video = text(data.youtube_video, 100);
    if (patch.youtube_video && !/^[a-zA-Z0-9_-]{11}$/.test(patch.youtube_video))
      throw new HttpError(400, 'YouTubeの動画ID（11文字）を指定してください。');
  }
  async function image(value, allowFacilityPhoto = false) {
    if (allowFacilityPhoto && facilityPhotos.some(([path]) => path === value)) return value;
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
      throw new HttpError(400, '公開用画像を指定してください。');
    if (!(await env.DB.prepare("SELECT id FROM images WHERE id=? AND visibility='public'").bind(value).first()))
      throw new HttpError(400, '公開用画像を指定してください。');
    return value;
  }
  if (owns(data, 'share_image')) {
    if (typeof data.share_image !== 'string') throw new HttpError(400, '共有用のサムネイルを選んでください。');
    patch.share_image = data.share_image ? await image(data.share_image) : '';
  }
  if (owns(data, 'recruit_page')) {
    const p = data.recruit_page;
    if (
      !p ||
      typeof p !== 'object' ||
      Array.isArray(p) ||
      !['left', 'right'].includes(p.image_side) ||
      !Array.isArray(p.sections) ||
      p.sections.length > 12 ||
      !p.contact ||
      typeof p.contact !== 'object'
    )
      throw new HttpError(400, '募集ページの構成を確認してください。');
    const page = {
      label: text(p.label, 80, true),
      title: text(p.title, 120, true),
      lead: text(p.lead, 4000),
      image: await image(p.image, true),
      image_side: p.image_side,
      sections: []
    };
    const used = new Set(['main', 'contact', 'contact-heading', 'recruit-heading']);
    for (const section of p.sections) {
      if (
        !section ||
        typeof section !== 'object' ||
        !Object.hasOwn(blockTypes, section.type) ||
        typeof section.id !== 'string' ||
        !/^[a-z][a-z0-9-]{0,59}$/.test(section.id) ||
        used.has(section.id) ||
        used.has(section.id + '-heading') ||
        typeof section.enabled !== 'boolean' ||
        ![1, 2, 3].includes(section.columns) ||
        !['paper', 'cream'].includes(section.tone) ||
        !Array.isArray(section.items) ||
        section.items.length > 12
      )
        throw new HttpError(400, '募集ページのセクションを確認してください。');
      used.add(section.id);
      used.add(section.id + '-heading');
      const items = section.items.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
          throw new HttpError(400, '募集ページの項目を確認してください。');
        return { title: text(item.title, 120, true), body: text(item.body, 4000) };
      });
      page.sections.push({
        id: section.id,
        type: section.type,
        title: text(section.title, 120, true),
        body: text(section.body, 6000),
        enabled: section.enabled,
        columns: section.columns,
        tone: section.tone,
        items: section.type === 'text' ? [] : items
      });
    }
    if (!Array.isArray(p.contact.items) || p.contact.items.length > 12)
      throw new HttpError(400, '募集ページの応募案内を確認してください。');
    page.contact = {
      title: text(p.contact.title, 120, true),
      body: text(p.contact.body, 4000),
      button_label: text(p.contact.button_label, 80, true),
      items: p.contact.items.map(item => text(item, 200, true))
    };
    patch.recruit_page = page;
  }
  for (const key of ['programs', 'facilities'])
    if (owns(data, key)) {
      if (!Array.isArray(data[key]) || data[key].length !== 3)
        throw new HttpError(400, 'プログラム・施設紹介はそれぞれ3項目を設定してください。');
      patch[key] = [];
      for (const entry of data[key]) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          throw new HttpError(400, '紹介内容を確認してください。');
        const item = {
          title: text(entry.title, 80, true),
          description: text(entry.description, key === 'programs' ? 1000 : 160),
          image: await image(entry.image, true)
        };
        if (key === 'programs')
          Object.assign(item, {
            minutes: minutes(entry.minutes),
            detail: text(entry.detail, 80),
            caption: text(entry.caption, 120)
          });
        patch[key].push(item);
      }
    }
  if (owns(data, 'main_minutes') || owns(data, 'programs')) {
    const saved = JSON.parse(
      (await env.DB.prepare("SELECT value FROM settings WHERE key='site'").first())?.value || '{}'
    );
    const current = siteContent({ ...saved, ...patch });
    if (current.programs.reduce((total, p) => total + p.minutes, 0) > current.main_minutes)
      throw new HttpError(400, '本編の時間は、3つのプログラムの合計時間以上にしてください。');
  }
  if (owns(data, 'hero_images') || owns(data, 'hero_image')) {
    const photos = data.hero_images === undefined ? (data.hero_image ? [data.hero_image] : []) : data.hero_images;
    if (!Array.isArray(photos) || photos.length > 12) throw new HttpError(400, 'トップ写真は12枚まで登録できます。');
    patch.hero_images = [...new Set(await Promise.all(photos.map(value => image(value))))];
    patch.hero_image = patch.hero_images[0] || '';
  }
  return patch;
}
