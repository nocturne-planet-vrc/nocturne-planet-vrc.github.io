export const facilityPhotos = [
  ['/assets/world/dome.webp', '星空ドーム'],
  ['/assets/world/seating.webp', 'ソファ席'],
  ['/assets/world/lounge-view.webp', 'ラウンジからの眺め'],
  ['/assets/world/sofa.webp', 'テーブル席'],
  ['/assets/world/bar.webp', 'バーカウンター'],
  ['/assets/world/overview.webp', '施設全体']
];
export const siteDefaults = {
  about:
    'Nocturne Planet（のくぷら）は、直径24mのプラネタリウムで星空解説・キャスト接客・歌唱ライブを楽しめるVRChatイベントです。',
  venue: 'VRChat・プラネタリウムワールド',
  venue_url: '',
  admission: 'Group+・先着順',
  cadence: '隔週開催予定',
  main_minutes: 75,
  after_minutes: 15,
  facility_intro:
    '見上げれば満天の星。足もとにはテーブルランプの灯り。\nドームを囲むラウンジとバーで、ゆっくりお過ごしください。',
  programs: [
    {
      title: '星空解説',
      minutes: 15,
      detail: '',
      description: '天文学・星座・神話など、回ごとにテーマを変えて解説します。',
      caption: '今夜の星空を\nご案内します',
      image: '/assets/world/dome.webp'
    },
    {
      title: 'キャスト接客',
      minutes: 30,
      detail: '15分×2回',
      description: 'テーブルに分かれてキャストからの接客を楽しめます。途中でキャストが交代します。',
      caption: 'キャストが\nテーブルへ伺います',
      image: '/assets/world/sofa.webp'
    },
    {
      title: '歌唱ライブ',
      minutes: 15,
      detail: '',
      description: 'ステージと映像・照明を組み合わせた歌唱パフォーマンスを行います。',
      caption: '星空の下で\n歌声を',
      image: '/assets/world/lounge-view.webp'
    }
  ],
  facilities: [
    { title: '星空ドーム', description: '直径24mのドームにソファ席が並びます', image: '/assets/world/seating.webp' },
    { title: 'バーカウンター', description: 'ドームのそばのカウンター', image: '/assets/world/bar.webp' },
    { title: '施設全体', description: '円形のドームとラウンジ', image: '/assets/world/overview.webp' }
  ]
};
export function siteContent(settings = {}) {
  const content = { ...structuredClone(siteDefaults), ...settings };
  for (const key of ['about', 'venue', 'admission']) if (!content[key]) content[key] = siteDefaults[key];
  for (const key of ['programs', 'facilities'])
    if (!Array.isArray(content[key]) || content[key].length !== 3) content[key] = structuredClone(siteDefaults[key]);
  return content;
}
export const siteImageSrc = value =>
  facilityPhotos.some(([path]) => path === value) ? value : '/api/images/' + encodeURIComponent(value);
export const durationLabel = s => `本編${s.main_minutes}分 ＋ アフター${s.after_minutes}分`;
