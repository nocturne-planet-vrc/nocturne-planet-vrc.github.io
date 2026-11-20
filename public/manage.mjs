import {
  api,
  apiBlob,
  esc,
  markdown,
  dateLabel,
  localDateTime,
  inputIso,
  toast,
  submit,
  optimizedImage,
  empty,
  field,
  textarea,
  select
} from './ui.mjs';
import { weekdays, validateRegularHours, regularHoursLabel, newEventTimes } from './schedule.mjs';
import { showCastPreview } from './casts.mjs';
import { editCastPhoto } from './cast-photo.mjs';
import { siteContent } from './site-content.mjs';
import { contentSettingsFields, readContentSettings, bindContentPhotos } from './content-settings.mjs';
import { renderRecruitEditor } from './recruit-editor.mjs';
import { shareImageFields, bindShareImage } from './share-image-settings.mjs';
import { renderEventRecords, renderChekiRecords } from './manage-records.mjs';
import { createRecordCache, recordListKey } from './record-cache.mjs';
import { renderPlacementEditor } from './placement.mjs';
const statusNames = { draft: '下書き', published: '公開中', archived: '非公開' },
  kindNames = { news: 'お知らせ', page: '固定ページ', manual: 'マニュアル' };
let data,
  root,
  active = 'news',
  dirty = false;
const recordCache = createRecordCache(api);
function primeRecordLists() {
  for (const kind of ['events', 'cheki'])
    if (data.record_lists?.[kind]) recordCache.prime(recordListKey(kind), data.record_lists[kind]);
}
const menuGroups = [
  [
    '記事・ページ',
    [
      ['news', 'お知らせ'],
      ['page', '固定ページ'],
      ['manual', 'マニュアル'],
      ['recruit', '募集ページ']
    ]
  ],
  [
    '営業管理',
    [
      ['events', '営業情報'],
      ['cheki', 'チェキ管理'],
      ['hours', '通常営業'],
      ['attendance', '出欠の一覧'],
      ['placement', '全体の配置']
    ]
  ],
  [
    'キャスト・設定',
    [
      ['staff', 'スタッフ一覧'],
      ['casts', 'キャスト'],
      ['settings', 'サイト設定']
    ]
  ]
];
export async function renderManage(initial) {
  data = initial || (await api('/api/manage'));
  recordCache.clear();
  primeRecordLists();
  document.getElementById('portal-main').innerHTML =
    `<div class="manage-layout"><div class="manage-mobile-nav">${select(
      '運営メニュー',
      'manage_section',
      menuGroups.flatMap(([, items]) => items),
      active
    )}<a class="text-link" href="/staff">スタッフページへ</a></div><nav class="manage-sidebar" aria-label="運営メニュー">${menuGroups.map(([label, items]) => `<div class="manage-nav-group"><p>${label}</p>${items.map(([id, label]) => `<button data-manage-tab="${id}" ${id === 'news' ? 'aria-current="page"' : ''}>${label}</button>`).join('')}</div>`).join('')}<a class="text-link" href="/staff">スタッフページへ →</a></nav><div class="manage-content" id="manage-content"></div></div>`;
  root = document.getElementById('manage-content');
  function changeTab(name) {
    if (dirty && !confirm('保存していない変更があります。移動しますか？')) return false;
    dirty = false;
    active = name;
    renderTab();
    return true;
  }
  document
    .querySelectorAll('[data-manage-tab]')
    .forEach(button => (button.onclick = () => changeTab(button.dataset.manageTab)));
  const mobileMenu = document.querySelector('[name=manage_section]');
  mobileMenu.onchange = () => {
    if (!changeTab(mobileMenu.value)) mobileMenu.value = active;
  };
  window.addEventListener('beforeunload', event => {
    if (dirty) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  renderTab();
}
function title(label, description = '', action = '') {
  return `<div class="manage-top"><div><h1>${label}</h1><p>${description}</p></div>${action}</div>`;
}
function watch(form) {
  form.addEventListener('input', () => (dirty = true));
  form.addEventListener('change', () => (dirty = true));
}
async function refresh() {
  recordCache.clear();
  data = await api('/api/manage');
  primeRecordLists();
  dirty = false;
  renderTab();
}
async function refreshRecordData() {
  data = await api('/api/manage');
  primeRecordLists();
}
function renderTab() {
  document.querySelector('[name=manage_section]').value = active;
  document
    .querySelectorAll('[data-manage-tab]')
    .forEach(button => button.setAttribute('aria-current', button.dataset.manageTab === active ? 'page' : 'false'));
  if (kindNames[active]) return contentList(active);
  if (active === 'recruit')
    return renderRecruitEditor(
      root,
      data.settings,
      data.drive.connected,
      () => (dirty = true),
      async values => {
        await api('/api/manage/settings', { method: 'POST', body: values });
        toast('募集ページを公開しました');
        await refresh();
      }
    );
  if (active === 'cheki') return renderChekiRecords(root, { cache: recordCache, onUpdated: refreshRecordData });
  if (active === 'placement') {
    root.innerHTML =
      title('全体の配置', '営業回ごとに、インスタンスの席とスタッフを登録します。') +
      '<div id="placement-editor"></div>';
    return renderPlacementEditor(root.querySelector('#placement-editor'), {
      events: data.events,
      onDirty: value => (dirty = value)
    });
  }
  if (active === 'events') return eventList();
  if (active === 'hours') return regularHours();
  if (active === 'casts') return castList();
  if (active === 'attendance') return attendanceList();
  if (active === 'staff') return staffDirectory();
  return settings();
}
function contentList(kind) {
  const items = data.content.filter(c => c.kind === kind);
  root.innerHTML =
    title(
      kindNames[kind],
      kind === 'manual' ? '公開すると、キャスト・スタッフページで読めます。' : '公開すると、公式HPに表示されます。',
      '<button class="button small" id="new-content">新しく書く</button>'
    ) +
    `<section class="panel"><div class="item-list">${items.map(item => `<div class="item-row"><div><strong>${esc(item.title)}</strong><small>更新 ${esc(dateLabel(item.updated_at))}</small></div><span class="status-label ${item.status}">${statusNames[item.status]}</span><button class="button secondary small" data-edit="${esc(item.id)}">編集する</button></div>`).join('') || empty('記事はまだありません')}</div></section>`;
  root.querySelector('#new-content').onclick = () => contentEditor({ kind, status: 'draft' });
  root
    .querySelectorAll('[data-edit]')
    .forEach(button => (button.onclick = () => contentEditor(items.find(i => i.id === button.dataset.edit))));
}
function contentEditor(item) {
  root.innerHTML =
    title(
      item.id ? '記事を編集' : '新しく書く',
      kindNames[item.kind],
      '<button class="button secondary small" id="back-list">一覧に戻る</button>'
    ) +
    `<form id="content-form"><div class="editor-grid"><div class="editor-main">${field('タイトル', 'title', item.title || '', 'text', 'required maxlength="160"')}${textarea('一覧に表示する説明（任意）', 'excerpt', item.excerpt || '', 'maxlength="500"')}<div class="tabs" role="tablist" aria-label="本文の表示"><button type="button" id="edit-mode" aria-selected="true" role="tab">本文を書く</button><button type="button" id="preview-mode" aria-selected="false" role="tab">プレビュー</button></div><div id="editor-box"><div class="editor-tools"><button type="button" data-insert="heading">見出し</button><button type="button" data-insert="bold">太字</button><button type="button" data-insert="list">箇条書き</button><button type="button" data-insert="link">リンク</button><button type="button" id="insert-image">画像を入れる</button></div>${textarea('本文', 'body', item.body || '', 'maxlength="60000" class="article-body"')}<input type="file" id="article-image" accept="image/jpeg,image/png,image/webp" hidden></div><div id="article-preview" class="editor-preview prose" hidden></div></div><aside class="editor-side panel"><h2>公開の設定</h2>${field('URL名（半角英数字・ハイフン）', 'slug', item.slug || `${item.kind}-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 6)}`, 'text', 'required maxlength="100" pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="open-information"')}<p class="inline-help">${item.kind === 'manual' ? 'マニュアルの識別名です。公式HPには表示されません。' : `公開先：/${item.kind === 'news' ? 'news' : 'pages'}/URL名`}</p><p class="quiet">現在：${statusNames[item.status] || '下書き'}</p><button class="button secondary" type="submit" name="action" value="draft">下書きを保存</button><button class="button" type="submit" name="action" value="published">公開する</button>${item.id ? '<button class="button secondary" type="submit" name="action" value="archived">非公開にする</button>' : ''}<p class="quiet">公開前にプレビューで内容を確認してください。</p></aside></div></form>`;
  const form = document.getElementById('content-form');
  watch(form);
  document.getElementById('back-list').onclick = () => {
    if (dirty && !confirm('変更を保存せずに戻りますか？')) return;
    dirty = false;
    contentList(item.kind);
  };
  if (item.kind === 'manual') {
    form.elements.excerpt.closest('.field').insertAdjacentHTML(
      'afterend',
      `<div class="manual-source">
      ${field('Google ドキュメントの共有リンク（任意）', 'google_doc_url', item.google_doc_url || '', 'url', 'maxlength="2048" placeholder="https://docs.google.com/document/d/…"')}
      <div class="manual-source-actions">
        <button type="button" class="button secondary small" data-create-manual-doc>Google ドキュメントを作成</button>
        <a class="text-link" data-edit-manual-doc href="${esc(item.google_doc_url || '')}" target="_blank" rel="noopener noreferrer" ${item.google_doc_url ? '' : 'hidden'}>Google ドキュメントで編集する</a>
      </div>
      <label class="check-row"><input type="checkbox" name="google_doc_inline" ${item.google_doc_inline ? 'checked' : ''}>Google ドキュメントの本文をスタッフページに表示する</label>
      <p class="inline-help">連携先の Google Drive で読み取れる文書を使います。公開後は、スタッフが開くたびに原本の本文を読み込みます。</p>
      ${data.drive?.connected ? '' : '<p class="quiet">文書を作るには「サイト設定」で Google Drive を連携してください。</p>'}
    </div>`
    );
    form.elements.body.closest('.field').querySelector('span').textContent = 'サイト内に表示する補足・本文（任意）';
    const source = form.elements.google_doc_url;
    const create = form.querySelector('[data-create-manual-doc]'),
      edit = form.querySelector('[data-edit-manual-doc]');
    const updateCreate = () => {
      create.disabled = !data.drive?.connected || !!source.value.trim();
    };
    updateCreate();
    source.addEventListener('input', updateCreate);
    create.onclick = async () => {
      await submit(create, async () => {
        const title = form.elements.title;
        if (!title.reportValidity()) return;
        const sourceValue = source.value;
        const { url } = await api('/api/manage/manual-document', { method: 'POST', body: { title: title.value } });
        if (!form.isConnected || source.value !== sourceValue) return;
        source.value = url;
        form.elements.google_doc_inline.checked = true;
        edit.href = url;
        edit.hidden = false;
        dirty = true;
        toast('Google ドキュメントを作成しました。リンクを開いて本文を編集できます。');
      });
      updateCreate();
    };
  }
  const body = form.elements.body;
  let previewVersion = 0;
  async function preview(on) {
    const version = ++previewVersion;
    const display = form.querySelector('#article-preview');
    form.querySelector('#editor-box').hidden = on;
    display.hidden = !on;
    form.querySelector('#preview-mode').setAttribute('aria-selected', String(on));
    form.querySelector('#edit-mode').setAttribute('aria-selected', String(!on));
    if (!on) return;
    const title = `<h1>${esc(form.elements.title.value || 'タイトル')}</h1>`;
    if (!form.elements.google_doc_inline?.checked) {
      display.innerHTML = title + markdown(body.value);
      return;
    }
    display.innerHTML = title + '<p role="status">Google ドキュメントを読み込んでいます…</p>';
    try {
      const result = await api('/api/manage/manual-document/preview', {
        method: 'POST',
        body: { url: form.elements.google_doc_url.value }
      });
      if (!display.isConnected || version !== previewVersion) return;
      const supplement = body.value.trim() ? `<h2>補足</h2>${markdown(body.value)}` : '';
      display.innerHTML =
        title +
        `<div class="manual-doc-body">${result.html || empty('Google ドキュメントにまだ本文がありません')}</div>` +
        supplement;
    } catch (error) {
      if (display.isConnected && version === previewVersion)
        display.innerHTML = title + `<p class="notice error">${esc(error.message)}</p>`;
    }
  }
  document.getElementById('edit-mode').onclick = () => preview(false);
  document.getElementById('preview-mode').onclick = () => preview(true);
  function insert(value) {
    const start = body.selectionStart,
      end = body.selectionEnd;
    body.setRangeText(value, start, end, 'end');
    dirty = true;
    body.focus();
  }
  root.querySelectorAll('[data-insert]').forEach(
    button =>
      (button.onclick = () => {
        const selected = body.value.slice(body.selectionStart, body.selectionEnd);
        const values = {
          heading: '\n## ' + (selected || '見出し') + '\n',
          bold: '**' + (selected || '強調する文字') + '**',
          list: '\n- ' + (selected || '項目') + '\n',
          link: '[' + (selected || 'リンクの文字') + '](https://example.com)'
        };
        insert(values[button.dataset.insert]);
      })
  );
  document.getElementById('insert-image').onclick = () => document.getElementById('article-image').click();
  document.getElementById('article-image').onchange = event =>
    submit(document.getElementById('insert-image'), async () => {
      const form = new FormData();
      form.set('image', await optimizedImage(event.target.files[0]));
      const image = await api('/api/manage/images', { method: 'POST', body: form });
      insert(`\n![画像の説明](${image.url})\n`);
      toast('画像を入れました。説明文も編集できます。');
    });
  form.onsubmit = event => {
    event.preventDefault();
    submit(event.submitter, async () => {
      const values = Object.fromEntries(new FormData(form));
      if (item.kind === 'manual') values.google_doc_inline = form.elements.google_doc_inline.checked;
      await api('/api/manage/content', {
        method: 'POST',
        body: { ...values, id: item.id, kind: item.kind, status: event.submitter.value }
      });
      toast(event.submitter.value === 'published' ? '公開しました' : '保存しました');
      await refresh();
    });
  };
}
function eventList() {
  return renderEventRecords(root, {
    cache: recordCache,
    onEdit: eventEditor,
    onNew: () => eventEditor(newEventTimes(data.settings.regular_hours)),
    onUpdated: refreshRecordData
  });
}
function eventEditor(event) {
  root.innerHTML =
    title(
      event.id ? '営業情報を編集' : '営業情報を追加',
      !event.id && data.settings.regular_hours
        ? '通常営業に合わせて次の営業曜日と時刻を入れています。日付は変更できます。時刻は日本時間です。'
        : '日時はすべて日本時間です。',
      '<button class="button secondary small" id="back-events">一覧に戻る</button>'
    ) +
    `<form class="panel" id="event-form">${field('営業名', 'title', event.title || '', 'text', 'required maxlength="160"')}${field('営業ラベル', 'category', event.category || '通常営業', 'text', 'required maxlength="24" list="event-categories"')}<datalist id="event-categories"><option value="通常営業"></option><option value="特別営業"></option></datalist><p class="inline-help">通常営業・特別営業など、24文字以内で入力できます。</p><div class="field-pair">${field('開始', 'starts_at', localDateTime(event.starts_at), 'datetime-local', 'required')}${field('終了', 'ends_at', localDateTime(event.ends_at), 'datetime-local', 'required')}</div>${textarea('お客さんへの案内', 'description', event.description || '', 'maxlength="4000"')}${field('出欠の回答期限', 'response_deadline', localDateTime(event.response_deadline), 'datetime-local')}<p class="inline-help">${data.reminders_ready ? '期限を設定すると、担当ロールがあり未回答の人へ、期限の12時間前・1時間前・5分前にDiscordのDMでお知らせします。' : '期限を過ぎると、スタッフページから回答できなくなります。'}</p><label class="check-row"><input type="checkbox" name="published" ${event.published ? 'checked' : ''}>公式HPに営業情報を公開する</label><h2 class="form-section-title">チェックイン</h2><p class="quiet">当日、会場で合言葉を案内してください。1人につき1回だけ来店記録が付きます。</p><div class="field-pair">${field('受付開始', 'checkin_opens_at', localDateTime(event.checkin_opens_at), 'datetime-local')}${field('受付終了', 'checkin_closes_at', localDateTime(event.checkin_closes_at), 'datetime-local')}</div>${field('合言葉（設定・変更する場合のみ）', 'passphrase', '', 'text', 'minlength="4" maxlength="80" autocomplete="off"')}<p class="inline-help">保存済みの合言葉は表示しません。空欄なら現在の設定を維持します。</p><label class="check-row"><input type="checkbox" name="disable_checkin">チェックインを停止する</label><div class="form-actions"><button class="button" type="submit">保存する</button></div></form>`;
  const form = document.getElementById('event-form');
  watch(form);
  document.getElementById('back-events').onclick = () => {
    if (dirty && !confirm('変更を保存せずに戻りますか？')) return;
    dirty = false;
    eventList();
  };
  form.onsubmit = event => {
    event.preventDefault();
    submit(event.submitter, async () => {
      const values = Object.fromEntries(new FormData(form));
      for (const key of ['starts_at', 'ends_at', 'response_deadline', 'checkin_opens_at', 'checkin_closes_at'])
        values[key] = inputIso(values[key]);
      values.id = form.dataset.id;
      values.published = form.elements.published.checked;
      values.disable_checkin = form.elements.disable_checkin.checked;
      await api('/api/manage/events', { method: 'POST', body: values });
      toast('営業情報を保存しました');
      await refresh();
    });
  };
  form.dataset.id = event.id || '';
}
function castList() {
  root.innerHTML =
    title(
      'キャスト紹介',
      '写真・名前・プロフィールを登録します。',
      '<button class="button small" id="new-cast">キャストを追加</button>'
    ) +
    `<section class="panel"><div class="item-list">${data.casts.map(cast => `<div class="item-row"><div><strong>${esc(cast.display_name)}</strong><small>${esc(cast.tagline)}</small></div><span class="status-label ${cast.active ? 'published' : ''}">${cast.active ? '公開中' : '非公開'}</span><button class="button secondary small" data-cast="${esc(cast.id)}">編集する</button></div>`).join('') || empty('キャストはまだ登録されていません')}</div></section>`;
  document.getElementById('new-cast').onclick = () => castEditor({});
  root
    .querySelectorAll('[data-cast]')
    .forEach(button => (button.onclick = () => castEditor(data.casts.find(c => c.id === button.dataset.cast))));
}
function castEditor(cast) {
  root.innerHTML =
    title('キャスト紹介を編集') +
    `<form class="panel" id="cast-form"><div class="field-pair">${field('名前', 'display_name', cast.display_name || '', 'text', 'required maxlength="80"')}${field('ひとこと', 'tagline', cast.tagline || '', 'text', 'maxlength="120"')}</div>${select('本人のDiscordアカウント（チェキ送信に使用）', 'user_id', [['', '未設定'], ...data.users.map(u => [u.id, staffLabel(u)]), ...(cast.user_id && !data.users.some(u => u.id === cast.user_id) ? [[cast.user_id, cast.user_id]] : [])], cast.user_id || '')}<p class="inline-help">運営用Discordサーバーにいる本人を選んでください。この設定は公開HPには表示しません。</p>${textarea('プロフィール', 'bio', cast.bio || '', 'maxlength="3000"')}${field('プロフィール写真', 'photo', '', 'file', 'accept="image/jpeg,image/png,image/webp"')}<p class="inline-help">写真は3:4（900×1200px）に調整できます。</p><button class="button secondary small" type="button" id="adjust-cast-photo" ${cast.image_id ? '' : 'hidden'}>写真を調整する</button><input type="hidden" name="image_id" value="${esc(cast.image_id || '')}"><img id="cast-image-preview" class="image-preview" alt="プロフィール写真" ${cast.image_id ? `src="/api/images/${esc(cast.image_id)}"` : 'hidden'}><div class="field-pair">${field('XのURL', 'x_url', cast.x_url || '', 'url')}${field('YouTubeのURL', 'youtube_url', cast.youtube_url || '', 'url')}</div>${field('表示順（小さい数字から）', 'sort_order', cast.sort_order || 0, 'number', 'min="-10000" max="10000"')}<label class="check-row"><input type="checkbox" name="active" ${cast.active ? 'checked' : ''}>キャスト紹介を公開する</label><div class="form-actions"><button class="button secondary" type="button" id="preview-manage-cast">プレビュー</button><button class="button" type="submit">保存する</button><button class="button secondary" type="button" id="back-casts">一覧に戻る</button></div></form>`;
  const form = document.getElementById('cast-form');
  watch(form);
  document.getElementById('back-casts').onclick = () => {
    if (dirty && !confirm('変更を保存せずに戻りますか？')) return;
    dirty = false;
    castList();
  };
  const previewButton = document.getElementById('preview-manage-cast'),
    photoInput = form.elements.photo,
    adjustButton = document.getElementById('adjust-cast-photo'),
    saveButton = form.querySelector('[type=submit]');
  const castId = cast.id || crypto.randomUUID();
  let sourcePhoto = null,
    photoBusy = false;
  function castValues() {
    const values = Object.fromEntries(new FormData(form));
    delete values.photo;
    values.id = castId;
    values.active = form.elements.active.checked;
    return values;
  }
  async function saveCast(values) {
    await api('/api/manage/casts', { method: 'POST', body: values });
    toast('キャスト紹介を保存しました');
    await refresh();
  }
  previewButton.onclick = () => {
    if (form.reportValidity()) {
      const values = castValues();
      showCastPreview({ ...cast, ...values }, { onSave: () => saveCast(values) });
    }
  };
  async function adjustPhoto(selected) {
    if (photoBusy) return;
    photoBusy = true;
    const controls = [photoInput, adjustButton, previewButton, saveButton, document.getElementById('back-casts')],
      states = controls.map(control => control.disabled);
    controls.forEach(control => (control.disabled = true));
    try {
      const original =
        selected || sourcePhoto || (await apiBlob('/api/images/' + encodeURIComponent(form.elements.image_id.value)));
      const adjusted = await editCastPhoto(original);
      if (!adjusted) {
        if (selected) photoInput.value = '';
        return;
      }
      const upload = new FormData();
      upload.set('image', adjusted);
      const image = await api('/api/manage/images', { method: 'POST', body: upload });
      sourcePhoto = original;
      form.elements.image_id.value = image.id;
      const preview = document.getElementById('cast-image-preview');
      preview.src = image.url;
      preview.hidden = false;
      dirty = true;
      toast('写真を調整しました。保存すると反映されます。');
    } catch (error) {
      toast(error.message, true);
    } finally {
      photoBusy = false;
      controls.forEach((control, index) => (control.disabled = states[index]));
      adjustButton.hidden = !form.elements.image_id.value;
    }
  }
  photoInput.onchange = event => {
    const file = event.target.files[0];
    if (file) void adjustPhoto(file);
  };
  adjustButton.onclick = () => void adjustPhoto();
  form.onsubmit = event => {
    event.preventDefault();
    submit(event.submitter, () => saveCast(castValues()));
  };
}
function attendanceList() {
  root.innerHTML =
    title('出欠の一覧', 'キャスト・スタッフの回答を確認できます。') +
    `<section class="panel">${select('営業回', 'filter_event', [['', 'すべて'], ...data.events.map(e => [e.id, e.title])])}<div class="table-wrap" id="attendance-table"></div></section><section class="panel" id="attendance-missing"></section>`;
  const filter = root.querySelector('select');
  const upcoming = rosterEvents()[0];
  if (upcoming) filter.value = upcoming.id;
  function table() {
    const answers = data.attendance.filter(a => !filter.value || a.event_id === filter.value);
    const event = data.events.find(e => e.id === filter.value),
      missing = event ? unansweredFor(event) : [];
    document.getElementById('attendance-missing').innerHTML = event
      ? missing.length
        ? `<h2>未回答（${missing.length}人）</h2><p class="quiet">担当ロールがあり、この営業回にまだ回答していない人です。${event.response_deadline ? '回答期限：' + esc(dateLabel(event.response_deadline)) : '回答期限は未設定です。'}</p><ul class="missing-list">${missing
            .map(u => {
              const s = answerStatus(event.id, u.id);
              return `<li><strong>${esc(u.display_name)}</strong><span class="quiet">${esc(u.roles.join('・'))}${u.logged_in ? '' : ' ・未ログイン'}${s.note ? ' ・' + esc(s.note) : ''}</span></li>`;
            })
            .join('')}</ul>`
        : '<p class="quiet">担当ロールがある全員が回答済みです。</p>'
      : '<p class="quiet">営業回を選ぶと、まだ回答していない人を表示します。</p>';
    document.getElementById('attendance-table').innerHTML = answers.length
      ? `<table><thead><tr><th>名前</th><th>営業回</th><th>出欠</th><th>参加可能時間</th><th>対応できる担当</th><th>連絡</th></tr></thead><tbody>${answers.map(a => `<tr><td>${esc(a.display_name)}</td><td>${esc(data.events.find(e => e.id === a.event_id)?.title)}</td><td>${{ yes: '参加', no: '欠席', maybe: '未定' }[a.answer]}</td><td>${esc(a.available_from || '—')}〜${esc(a.available_until || '—')}</td><td>${esc(JSON.parse(a.duties).join('・'))}</td><td><div class="preserve">${esc(a.note)}</div></td></tr>`).join('')}</tbody></table>`
      : empty('回答はまだありません');
  }
  filter.onchange = table;
  table();
}
function regularHours() {
  const hours = data.settings.regular_hours;
  root.innerHTML =
    title('通常営業', '営業曜日と時刻を設定します。時刻は日本時間です。') +
    `<form class="panel" id="hours-form"><div class="field-pair">${select(
      '開催ペース',
      'interval_weeks',
      [
        ['', '未設定'],
        ['1', '毎週'],
        ['2', '隔週']
      ],
      hours?.interval_weeks ?? ''
    )}${select('営業曜日', 'weekday', [['', '曜日を選択'], ...weekdays.map((day, index) => [index, day + '曜日'])], hours?.weekday ?? '')}</div><div class="field-pair">${field('開始時刻', 'start_time', hours?.start_time || '', 'time')}${field('終了時刻', 'end_time', hours?.end_time || '', 'time')}</div><p class="inline-help">終了が開始より早い時刻なら、翌日の終了として扱います。</p><p class="hours-preview" id="hours-preview" role="status"></p><p class="quiet">保存すると、公開HPの通常営業欄と未回答の出欠フォームに反映されます。営業回ごとの日時は「営業情報」で登録してください。</p><div class="form-actions"><button class="button" type="submit">通常営業を保存する</button></div></form>`;
  const form = document.getElementById('hours-form');
  watch(form);
  function value() {
    return form.elements.interval_weeks.value
      ? validateRegularHours({
          interval_weeks: Number(form.elements.interval_weeks.value),
          weekday: form.elements.weekday.value === '' ? null : Number(form.elements.weekday.value),
          start_time: form.elements.start_time.value,
          end_time: form.elements.end_time.value
        })
      : null;
  }
  function preview() {
    const enabled = !!form.elements.interval_weeks.value;
    for (const name of ['weekday', 'start_time', 'end_time']) {
      form.elements[name].disabled = !enabled;
      form.elements[name].required = enabled;
    }
    try {
      document.getElementById('hours-preview').textContent = regularHoursLabel(value()) || '通常営業は未設定です';
    } catch {
      document.getElementById('hours-preview').textContent = '曜日と開始・終了時刻を設定してください';
    }
  }
  form.addEventListener('input', preview);
  form.addEventListener('change', preview);
  preview();
  form.onsubmit = event => {
    event.preventDefault();
    submit(event.submitter, async () => {
      await api('/api/manage/schedule', { method: 'POST', body: { regular_hours: value() } });
      toast('通常営業を保存しました');
      await refresh();
    });
  };
}
let heroImages = [];
function heroList() {
  const list = document.getElementById('hero-list');
  if (!list) return;
  list.innerHTML = heroImages.length
    ? heroImages
        .map(
          (image, index) =>
            '<li class="hero-item"><img src="/api/images/' +
            encodeURIComponent(image) +
            '" alt="' +
            (index + 1) +
            '枚目のトップ写真" loading="lazy"><span>' +
            (index + 1) +
            '枚目</span><div class="hero-item-actions"><button class="button secondary small" type="button" data-hero-move="-1" data-index="' +
            index +
            '" ' +
            (index === 0 ? 'disabled' : '') +
            '>前へ</button><button class="button secondary small" type="button" data-hero-move="1" data-index="' +
            index +
            '" ' +
            (index === heroImages.length - 1 ? 'disabled' : '') +
            '>後ろへ</button><button class="button danger small" type="button" data-hero-remove="' +
            index +
            '">外す</button></div></li>'
        )
        .join('')
    : '<li class="hero-empty">写真が未登録の場合は、同梱の施設写真3枚を切り替えて表示します。</li>';
  list.querySelectorAll('[data-hero-move]').forEach(
    button =>
      (button.onclick = () => {
        const index = Number(button.dataset.index),
          to = index + Number(button.dataset.heroMove);
        [heroImages[index], heroImages[to]] = [heroImages[to], heroImages[index]];
        dirty = true;
        heroList();
      })
  );
  list.querySelectorAll('[data-hero-remove]').forEach(
    button =>
      (button.onclick = () => {
        heroImages.splice(Number(button.dataset.heroRemove), 1);
        dirty = true;
        heroList();
      })
  );
  const input = document.querySelector('[name=hero_photo]');
  if (input) input.disabled = heroImages.length >= 12 || !data.drive.connected;
}
const staffLabel = u =>
  u.display_name + (u.roles?.length ? '（' + u.roles.join('・') + '）' : '') + (u.logged_in ? '' : ' ・未ログイン');
function syncLabel(d) {
  if (!d?.configured) return 'Discord Botが未設定のため、スタッフページにログインした人だけを表示しています。';
  const time = d.synced_at ? dateLabel(d.synced_at) : '未取得';
  return (
    (d.error ? '最後の取得に失敗しました：' + d.error + ' ' : '') +
    'Discordから取得：' +
    time +
    (d.count != null ? '（' + d.count + '人）' : '')
  );
}
const stageLabel = s => (s >= 60 ? s / 60 + '時間前' : s + '分前');
const answerNames = { yes: '参加', no: '欠席', maybe: '未定' };
// Upcoming events with an attendance deadline, nearest first. Falls back to any upcoming event.
function rosterEvents() {
  const now = Date.now();
  return data.events
    .filter(e => Date.parse(e.ends_at) > now)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
}
function answerStatus(eventId, userId) {
  const answer = data.attendance.find(a => a.event_id === eventId && a.user_id === userId);
  if (answer) return { answered: true, label: answerNames[answer.answer] || '回答済み' };
  const target = data.roster?.target_ids?.includes(userId);
  const sent = (data.roster?.reminders || [])
    .filter(r => r.event_id === eventId && r.user_id === userId)
    .sort((a, b) => a.stage - b.stage)[0];
  const note = sent
    ? sent.status === 'sent'
      ? '通知済み（' + stageLabel(sent.stage) + '）'
      : sent.status === 'blocked'
        ? 'DMを受け取らない設定'
        : sent.status === 'pending'
          ? '通知中'
          : '通知できませんでした'
    : '';
  return { answered: false, target, label: '未回答', note };
}
function unansweredFor(event) {
  return data.users.filter(u => data.roster?.target_ids?.includes(u.id) && !answerStatus(event.id, u.id).answered);
}
function staffDirectory() {
  const events = rosterEvents();
  let users = data.users;
  const eventId =
    root.dataset.rosterEvent && events.some(e => e.id === root.dataset.rosterEvent)
      ? root.dataset.rosterEvent
      : events[0]?.id || '';
  const onlyMissing = root.dataset.onlyMissing === '1' && !!eventId;
  if (onlyMissing)
    users = users.filter(u => !answerStatus(eventId, u.id).answered && data.roster?.target_ids?.includes(u.id));
  const current = events.find(e => e.id === eventId);
  const missingCount = current ? unansweredFor(current).length : 0;
  root.innerHTML =
    title(
      'スタッフ一覧',
      '運営用Discordサーバーのメンバーとロール、営業回ごとの出欠の回答状況です。担当ロールがある人を出欠の対象にしています。',
      data.directory?.configured ? '<button class="button small" id="staff-sync">Discordから再取得</button>' : ''
    ) +
    `<section class="panel">${
      events.length
        ? `<div class="roster-controls">${select(
            '出欠を確認する営業回',
            'roster_event',
            events.map(e => [e.id, e.title + '（' + dateLabel(e.starts_at) + '）']),
            eventId
          )}<label class="check-row"><input type="checkbox" name="only_missing" ${onlyMissing ? 'checked' : ''}>未回答の人だけ表示</label></div>${current ? `<p class="roster-summary">${current.response_deadline ? '回答期限：' + esc(dateLabel(current.response_deadline)) + ' ／ ' : '回答期限は未設定です ／ '}未回答 <strong>${missingCount}</strong>人${data.reminders_ready && current.response_deadline ? '（期限の12時間前・1時間前・5分前にDMでお知らせします）' : ''}</p>` : ''}`
        : ''
    }<p class="quiet staff-sync-status${data.directory?.error ? ' is-error' : ''}">${esc(syncLabel(data.directory))}</p><div class="table-wrap"><table class="staff-table"><thead><tr><th>名前</th><th>ロール</th><th>スタッフページ</th>${eventId ? '<th>出欠</th>' : ''}</tr></thead><tbody>${users
      .map(
        u =>
          `<tr><td><strong>${esc(u.display_name)}</strong>${u.in_server || !data.directory?.configured ? '' : '<small class="quiet">運営用サーバーにいません</small>'}</td><td>${u.roles?.length ? esc(u.roles.join('・')) : '<span class="quiet">担当ロールなし</span>'}</td><td>${u.logged_in ? 'ログイン済み' : '<span class="quiet">未ログイン</span>'}</td>${
            eventId
              ? (() => {
                  const s = answerStatus(eventId, u.id);
                  return s.answered
                    ? `<td>${esc(s.label)}</td>`
                    : s.target
                      ? `<td><span class="answer-missing">未回答</span>${s.note ? `<small class="quiet">${esc(s.note)}</small>` : ''}</td>`
                      : '<td><span class="quiet">対象外</span></td>';
                })()
              : ''
          }</tr>`
      )
      .join(
        ''
      )}</tbody></table></div>${users.length ? '' : empty(onlyMissing ? '未回答の人はいません' : '運営用サーバーのメンバーはまだ取得されていません')}</section>`;
  const pick = root.querySelector('[name=roster_event]');
  if (pick)
    pick.onchange = () => {
      root.dataset.rosterEvent = pick.value;
      staffDirectory();
    };
  const only = root.querySelector('[name=only_missing]');
  if (only)
    only.onchange = () => {
      root.dataset.onlyMissing = only.checked ? '1' : '';
      staffDirectory();
    };
  const sync = document.getElementById('staff-sync');
  if (sync)
    sync.onclick = () =>
      submit(sync, async () => {
        const result = await api('/api/manage/staff-sync', { method: 'POST' });
        data.directory = result.directory;
        data.users = result.users;
        toast('Discordからメンバーを取得しました（' + result.directory.count + '人）');
        staffDirectory();
      });
}
function settings() {
  const s = siteContent(data.settings);
  heroImages =
    Array.isArray(s.hero_images) && s.hero_images.length ? [...s.hero_images] : s.hero_image ? [s.hero_image] : [];
  root.innerHTML =
    title(
      'サイト設定',
      'ホームの開催場所・プログラム・施設紹介・公式リンクを変更します。',
      '<a class="button secondary small" href="/" target="_blank" rel="noopener noreferrer">公開HPを確認</a>'
    ) +
    `<form class="panel" id="settings-form"><fieldset class="form-section"><legend>イベントの案内</legend>${textarea('イベント概要', 'about', s.about, 'maxlength="4000"')}<div class="field-pair">${field('開催ペースの補足', 'cadence', s.cadence || '', 'text', 'maxlength="160"')}${field('入場方法', 'admission', s.admission, 'text', 'maxlength="160"')}</div><p class="inline-help">営業曜日・時刻は「通常営業」で設定します。開催ペースの補足は、その時刻の下にも表示します。</p></fieldset>${contentSettingsFields(s, data.drive.connected)}${shareImageFields(s, data.drive.connected)}<fieldset class="form-section"><legend>公式リンク</legend><div class="field-pair">${field('公式XのURL', 'x_url', s.x_url || '', 'url')}${field('公式YouTubeのURL', 'youtube_url', s.youtube_url || '', 'url')}</div><p class="inline-help">空欄のリンクは、ホームのヘッダーとSNS欄に表示しません。</p>${field('募集フォームのURL', 'recruit_url', s.recruit_url || '', 'url')}<p class="inline-help">キャスト・スタッフ募集ページ（/recruit）の応募ボタンに使います。空欄の場合は受付準備中と表示します。</p>${field('埋め込むYouTubeの動画ID（11文字）', 'youtube_video', s.youtube_video || '', 'text', 'maxlength="11"')}<p class="inline-help">例：youtube.com/watch?v= の後にある11文字。未設定の場合は「動画は準備中です」と表示します。</p><div class="field-pair">${field('お客様用Discordの招待URL', 'discord_invite', s.discord_invite || '', 'url')}${field('VRChatグループのURL', 'vrchat_group_url', s.vrchat_group_url || '', 'url')}</div></fieldset><fieldset class="form-section"><legend>トップ写真</legend><p class="inline-help hero-help">トップの背景を6秒ごとに切り替えます（12枚まで）。写真がない場合は、同梱の施設写真3枚を使います。横長の写真がきれいに収まります。</p><ul class="hero-list" id="hero-list"></ul>${field('写真を追加', 'hero_photo', '', 'file', 'accept="image/jpeg,image/png,image/webp" multiple')}<p class="inline-help">新しい写真のアップロードにはGoogle Drive連携が必要です。</p></fieldset><div class="form-actions"><button class="button" type="submit">設定を保存する</button></div></form><section class="panel storage-panel"><h2>画像の保存先</h2><p>${data.drive.connected ? `連携済み：${esc(data.drive.email)}` : 'Google Driveは未連携です'}</p><p class="quiet">チェキは非公開で保存します。サイト設定・記事・キャスト紹介の写真は、保存して公開に使っている間だけ閲覧できます。</p><a class="button secondary" href="/auth/google">${data.drive.connected ? 'Google Driveを再連携' : 'Google Driveを連携する'}</a></section>`;
  const form = document.getElementById('settings-form');
  watch(form);
  heroList();
  bindContentPhotos(form, () => (dirty = true));
  bindShareImage(form, () => (dirty = true));
  form.elements.hero_photo.onchange = event =>
    submit(form.querySelector('[type=submit]'), async () => {
      const files = [...event.target.files].slice(0, 12 - heroImages.length);
      for (const file of files) {
        const upload = new FormData();
        upload.set('image', await optimizedImage(file));
        const image = await api('/api/manage/images', { method: 'POST', body: upload });
        heroImages.push(image.id);
        heroList();
      }
      event.target.value = '';
      dirty = true;
      toast(files.length + '枚追加しました。保存すると反映されます。');
    });
  form.onsubmit = event => {
    event.preventDefault();
    submit(event.submitter, async () => {
      const values = Object.fromEntries(new FormData(form));
      delete values.hero_photo;
      delete values.share_photo;
      readContentSettings(form, values);
      values.hero_images = heroImages;
      await api('/api/manage/settings', { method: 'POST', body: values });
      toast('サイト設定を保存しました');
      await refresh();
    });
  };
}
