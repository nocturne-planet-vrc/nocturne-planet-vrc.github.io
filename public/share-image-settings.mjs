import { api, esc, field, textarea, submit, toast } from './ui.mjs';
import { shareImagePath } from './share-image.mjs';

export function shareImageFields(settings, connected) {
  return `<fieldset class="form-section"><legend>リンク共有時の表示</legend><p class="inline-help">ホームや募集ページなど、リンクを共有したときのタイトル・説明文・サムネイルを設定します。設定を保存すると全ページに共通で反映します。</p>${field('共有タイトル', 'share_title', settings.share_title || '', 'text', 'maxlength="120" placeholder="空欄の場合は各ページの初期タイトル"')}${textarea('共有説明文', 'share_description', settings.share_description || '', 'maxlength="500" rows="3" placeholder="空欄の場合は各ページの初期説明文"')}<p class="inline-help">タイトルは120文字、説明文は500文字まで。空欄で保存すると、その項目は各ページの初期表示に戻ります。</p><input type="hidden" name="share_image" value="${esc(settings.share_image || '')}"><img class="settings-photo-preview" id="share-image-preview" src="${esc(shareImagePath(settings.share_image))}" alt="リンク共有時のサムネイルのプレビュー" width="400" height="225">${field('サムネイル画像を変更', 'share_photo', '', 'file', `accept="image/png,image/jpeg" ${connected ? '' : 'disabled'}`)}<p class="inline-help">PNG・JPEG、4MBまで。16:9などの横長画像がおすすめです。アップロードにはGoogle Drive連携が必要です。</p><button class="button secondary small" type="button" id="reset-share-image">初期バナーに戻す</button></fieldset>`;
}
export function bindShareImage(form, onChange) {
  const input = form.elements.share_photo,
    reference = form.elements.share_image,
    preview = form.querySelector('#share-image-preview'),
    reset = form.querySelector('#reset-share-image');
  reset.onclick = () => {
    reference.value = '';
    input.value = '';
    preview.src = shareImagePath('');
    onChange();
  };
  input.onchange = event =>
    submit(form.querySelector('[type=submit]'), async () => {
      const file = event.target.files[0];
      if (!file) return;
      if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 4 * 1024 * 1024)
        throw new Error('4MB以下のPNG・JPEG画像を選んでください。');
      const disabled = input.disabled;
      input.disabled = true;
      reset.disabled = true;
      try {
        const body = new FormData();
        body.set('image', file);
        const image = await api('/api/manage/images', { method: 'POST', body });
        reference.value = image.id;
        preview.src = image.url;
        input.value = '';
        onChange();
        toast('サムネイルを追加しました。設定を保存すると反映されます。');
      } finally {
        input.disabled = disabled;
        reset.disabled = false;
      }
    });
}
