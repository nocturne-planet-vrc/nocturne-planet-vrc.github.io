import { renderVrchat } from './vrchat.mjs';
import { showCastPreview } from './casts.mjs';
import { editCastPhoto } from './cast-photo.mjs';
import {
  api,
  apiBlob,
  setSession,
  session,
  esc,
  safeLink,
  markdown,
  dateLabel,
  toast,
  submit,
  optimizedImage,
  empty,
  field,
  textarea,
  select
} from './ui.mjs';
import { createAttendanceView } from './attendance.mjs';
import { renderStaffPlacement } from './placement.mjs';

const memberImageUrls = new Set();
window.addEventListener('pagehide', () => {
  for (const url of memberImageUrls) URL.revokeObjectURL(url);
});
const area = location.pathname.replaceAll('/', '') || 'member',
  labels = { member: '会員ページ', staff: 'キャスト・スタッフページ', manage: '運営ページ' };
document.body.classList.add('portal-' + area);
document.title = `${labels[area]} | Nocturne Planet`;
document.getElementById('area-label').textContent = labels[area];
document.getElementById('login-title').textContent = labels[area];
document.getElementById('login-description').textContent =
  area === 'manage'
    ? '運営用Discordサーバーで「運営」ロールが付いている方が利用できます。'
    : area === 'staff'
      ? '運営用Discordサーバーに参加している方が利用できます。'
      : 'お客さん用Discordサーバーに参加している方が利用できます。';
const remember = document.getElementById('remember'),
  login = document.getElementById('login-button');
function loginUrl() {
  login.href = `/auth/discord?area=${area}&remember=${remember.checked ? '1' : '0'}`;
}
remember.addEventListener('change', loginUrl);
loginUrl();
const error = new URLSearchParams(location.search).get('error');
if (error) {
  const message = document.getElementById('login-message');
  message.textContent = error;
  message.hidden = false;
  history.replaceState(null, '', location.pathname);
}
let authenticated = false,
  initialData;
try {
  initialData = await api(`/api/${area}`);
  setSession(initialData.session);
  authenticated = true;
} catch (error) {
  if (error.status !== 401) {
    const message = document.getElementById('login-message');
    message.textContent = error.message;
    message.hidden = false;
  }
}
if (!authenticated) {
  document.getElementById('portal-loading').hidden = true;
  login.closest('.login-panel').hidden = false;
  if (area === 'member') {
    const invite = document.getElementById('login-invite');
    api('/api/public')
      .then(({ settings }) => {
        invite.hidden = !settings.discord_invite;
        if (settings.discord_invite) invite.querySelector('a').href = safeLink(settings.discord_invite);
      })
      .catch(() => {});
  }
}
if (authenticated) {
  document.getElementById('account-actions').innerHTML =
    `<span class="user-chip">${esc(session.user.name)}</span>${area === 'staff' && session.admin ? '<a class="button secondary small pill" href="/manage">運営ページ</a>' : ''}<button class="button secondary small pill" id="logout">ログアウト</button>`;
  document.getElementById('logout').addEventListener('click', event =>
    submit(event.currentTarget, async () => {
      await api('/api/logout', { method: 'POST' });
      location.reload();
    })
  );
  try {
    if (area === 'manage') {
      const { renderManage } = await import('./manage.mjs');
      await renderManage(initialData);
    } else if (area === 'staff') renderStaff(initialData);
    else await renderMember(initialData);
  } catch (error) {
    document.getElementById('portal-main').innerHTML =
      `<div class="dashboard"><h1>${labels[area]}</h1><div class="notice error">${esc(error.message)}</div><button class="button" id="retry-load">読み込み直す</button></div>`;
    document.getElementById('retry-load').onclick = () => location.reload();
  }
}

async function loadMemberImages() {
  for (const img of document.querySelectorAll('[data-private-image]')) {
    try {
      const blob = await apiBlob(img.dataset.privateImage);
      if (!img.isConnected) continue;
      const url = URL.createObjectURL(blob);
      memberImageUrls.add(url);
      img.src = url;
      img.alt = img.alt.replace('（読み込み中）', '');
    } catch (error) {
      img.alt = error.message;
      toast(error.message, true);
    }
  }
}
async function renderMember(initial) {
  const [data, publicData] = await Promise.all([initial || api('/api/member'), api('/api/public')]);
  for (const url of memberImageUrls) URL.revokeObjectURL(url);
  memberImageUrls.clear();
  const currentEvents = publicData.events.filter(
    e =>
      e.checkin_opens_at &&
      e.checkin_closes_at &&
      Date.now() >= Date.parse(e.checkin_opens_at) &&
      Date.now() <= Date.parse(e.checkin_closes_at)
  );
  document.getElementById('portal-main').innerHTML =
    `<div class="dashboard"><div class="dashboard-title"><h1>会員ページ</h1><p>${esc(session.user.name)}さんの来店記録・お気に入り・チェキ</p></div><div class="dashboard-grid"><section class="panel"><h2>来店記録</h2><div class="stats"><div><div class="number">${data.visits.length}<small>回</small></div><p>これまでの来店</p></div><div><p>直近の来店</p><span>${data.visits[0] ? esc(dateLabel(data.visits[0].checked_in_at, false)) : 'まだ記録がありません'}</span></div></div>${data.visits.length ? `<details><summary>来店履歴を見る</summary><ul class="record-list">${data.visits.map(v => `<li><strong>${esc(v.title)}</strong><small>${esc(dateLabel(v.checked_in_at))}</small></li>`).join('')}</ul></details>` : ''}</section><section class="panel"><h2>本日のチェックイン</h2>${
      currentEvents.length
        ? `<form id="checkin-form">${select(
            '営業回',
            'event_id',
            currentEvents.map(e => [e.id, e.title])
          )}${field('会場で案内された合言葉', 'passphrase', '', 'text', 'required maxlength="80" autocomplete="off"')}<button class="button pill" type="submit">チェックインする</button></form>`
        : empty('受付中の営業はありません')
    }</section><section class="panel full"><h2>お気に入りのキャスト</h2><p class="quiet">複数人を選べます。選択内容はほかのお客さんには表示されません。</p>${publicData.casts.length ? `<form id="favorite-form"><div class="favorite-list">${publicData.casts.map(c => `<label class="favorite-cast"><input type="checkbox" name="cast" value="${esc(c.id)}" ${data.favorites.includes(c.id) ? 'checked' : ''}><span class="favorite-photo${c.image_id ? '' : ' no-photo'}"><img src="${c.image_id ? '/api/images/' + encodeURIComponent(c.image_id) : '/assets/logo-dark.svg'}" alt="" loading="lazy" width="900" height="1200"></span><span class="favorite-name">${esc(c.display_name)}</span></label>`).join('')}</div><div class="form-actions"><button class="button small pill" type="submit">保存する</button></div></form>` : empty('キャスト紹介の公開後に登録できます')}</section><section class="panel full"><h2>受け取ったチェキ</h2><p class="quiet">キャストからあなた宛てに届いたチェキです。</p><div class="cheki-grid">${data.cheki.map(c => `<article class="cheki-card"><img data-private-image="/api/images/${esc(c.image_id)}" alt="${esc(c.sender_name)}さんからのチェキ（読み込み中）"><div><strong>${esc(c.sender_name)}</strong><p>${esc(c.message)}</p><small class="quiet">${esc(dateLabel(c.created_at, false))}${c.event_title ? ' ／ ' + esc(c.event_title) : ''}</small><button class="button secondary small pill" data-download="${esc(c.id)}">画像を保存</button></div></article>`).join('') || empty('チェキが届くと、ここに表示されます')}</div></section></div></div>`;
  document
    .querySelector('.dashboard-title')
    .insertAdjacentHTML('beforeend', '<a class="text-link vrchat-shortcut" href="#vrchat-account">VRChat連携へ</a>');
  const accountPanel = document.createElement('section');
  accountPanel.className = 'panel full';
  accountPanel.id = 'vrchat-account';
  accountPanel.tabIndex = -1;
  document.querySelector('.dashboard-grid').append(accountPanel);
  renderVrchat(accountPanel, data.vrchat, 'member', status => {
    data.vrchat = status;
    const chip = document.querySelector('.user-chip');
    if (chip) chip.textContent = session.user.name;
    document.querySelector('.dashboard-title p').textContent = `${session.user.name}さんの来店記録・お気に入り・チェキ`;
  });
  void loadMemberImages();
  document.getElementById('checkin-form')?.addEventListener('submit', event => {
    event.preventDefault();
    submit(event.submitter, async () => {
      const result = await api('/api/member/checkin', {
        method: 'POST',
        body: Object.fromEntries(new FormData(event.target))
      });
      toast(result.already ? 'この営業はチェックイン済みです' : 'チェックインしました');
      await renderMember();
    });
  });
  document.getElementById('favorite-form')?.addEventListener('submit', event => {
    event.preventDefault();
    submit(event.submitter, async () => {
      await api('/api/member/favorites', {
        method: 'PUT',
        body: { cast_ids: new FormData(event.target).getAll('cast') }
      });
      toast('お気に入りを保存しました');
    });
  });
  document.querySelectorAll('[data-download]').forEach(button =>
    button.addEventListener('click', () =>
      submit(button, async () => {
        const cheki = data.cheki.find(c => c.id === button.dataset.download),
          blob = await apiBlob(`/api/images/${encodeURIComponent(cheki.image_id)}`);
        const blobUrl = URL.createObjectURL(blob),
          link = document.createElement('a');
        link.href = blobUrl;
        link.download = `nocturne-planet-${cheki.id}.webp`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
        await api(`/api/member/cheki/${encodeURIComponent(cheki.id)}/opened`, { method: 'POST', body: {} });
      })
    )
  );
}

function renderStaff(data) {
  const attendanceView = createAttendanceView(data, data.regular_hours);
  const manualBodies = new Map();
  const resources = {
    assignments: {
      title: '今回の配置',
      value: data.placement,
      path: '/api/staff/placement',
      render: (root, value) => renderStaffPlacement(root, value, data.assignments)
    },
    manuals: {
      title: 'マニュアル',
      value: data.manuals,
      path: '/api/staff/manuals',
      render: (root, value) => renderStaffManuals(root, value, manualBodies)
    }
  };
  for (const resource of Object.values(resources)) resource.loadedAt = Date.now();
  let vrchatView,
    tabVersion = 0;
  document.getElementById('portal-main').innerHTML =
    `<div class="dashboard staff-dashboard"><div class="dashboard-title"><h1>キャスト・スタッフページ</h1><p>出欠の回答・配置の確認・マニュアル・チェキ送信</p></div><div class="tabs" role="tablist" aria-label="スタッフメニュー"><button role="tab" aria-selected="true" data-staff-tab="attendance">出欠・シフト</button><button role="tab" aria-selected="false" data-staff-tab="assignments">今回の配置</button><button role="tab" aria-selected="false" data-staff-tab="manuals">マニュアル</button><button role="tab" aria-selected="false" data-staff-tab="cheki">チェキを送る</button><button role="tab" aria-selected="false" data-staff-tab="vrchat">VRChat連携</button><button role="tab" aria-selected="false" data-staff-tab="profile">キャスト紹介</button></div><div id="staff-content"></div></div>`;
  async function switchTab(name) {
    const version = ++tabVersion;
    document
      .querySelectorAll('[data-staff-tab]')
      .forEach(b => b.setAttribute('aria-selected', String(b.dataset.staffTab === name)));
    const root = document.getElementById('staff-content');
    if (name === 'attendance') {
      if (!root.contains(attendanceView)) root.replaceChildren(attendanceView);
    } else if (Object.hasOwn(resources, name)) {
      const resource = resources[name];
      const { title, render, path, value } = resource;
      const expired = name === 'assignments' && Date.parse(value?.event?.ends_at) <= Date.now();
      const canDisplay = value != null && !expired;
      if (canDisplay) {
        render(root, value);
        if (Date.now() - resource.loadedAt < 30_000) return;
      } else {
        root.innerHTML = `<section class="panel"><h2>${title}</h2><p role="status">読み込んでいます…</p></section>`;
      }
      try {
        resource.pending ??= api(path)
          .then(result => {
            resource.value = name === 'manuals' ? result.manuals : result;
            resource.loadedAt = Date.now();
            return resource.value;
          })
          .finally(() => (resource.pending = null));
        const fresh = await resource.pending;
        if (version === tabVersion && (!canDisplay || JSON.stringify(value) !== JSON.stringify(fresh)))
          render(root, fresh);
      } catch (error) {
        if (error.status === 401 || error.status === 403) {
          resource.value = null;
          manualBodies.clear();
        } else if (canDisplay) return;
        if (version !== tabVersion) return;
        root.innerHTML = `<section class="panel"><h2>${title}</h2><p class="notice error">${esc(error.message)}</p><button class="button secondary small" type="button">読み込み直す</button></section>`;
        root.querySelector('button').onclick = () => switchTab(name);
      }
    } else if (name === 'profile')
      renderCastProfile(root, data.profile, value => {
        data.profile = value;
      });
    else if (name === 'vrchat') {
      if (!vrchatView) {
        vrchatView = document.createElement('section');
        vrchatView.className = 'panel';
        vrchatView.id = 'vrchat-account';
        root.replaceChildren(vrchatView);
        renderVrchat(vrchatView, data.vrchat, 'staff');
      } else if (!root.contains(vrchatView)) root.replaceChildren(vrchatView);
    } else renderCheki(root, data);
  }
  document
    .querySelectorAll('[data-staff-tab]')
    .forEach(button => button.addEventListener('click', () => switchTab(button.dataset.staffTab)));
  switchTab('attendance');
}
function manualBody(html) {
  return html || empty('Google ドキュメントにまだ本文がありません');
}
function addManualContents(body, nav, manualIndex, title) {
  const headings = [...body.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter(heading => heading.textContent.trim());
  if (!headings.length) return;
  const firstLevel = headings.reduce((level, heading) => Math.min(level, Number(heading.tagName[1])), 6);
  if (title) {
    const label = document.createElement('p');
    label.textContent = title;
    nav.append(label);
  }
  const list = document.createElement('ul');
  for (const [index, heading] of headings.entries()) {
    heading.id ||= `staff-manual-${manualIndex}-heading-${index + 1}`;
    heading.tabIndex = -1;
    const item = document.createElement('li');
    item.dataset.depth = Math.min(2, Number(heading.tagName[1]) - firstLevel);
    const link = document.createElement('a');
    link.href = `#${heading.id}`;
    link.textContent = heading.textContent.trim();
    link.addEventListener('click', event => {
      event.preventDefault();
      heading.focus({ preventScroll: true });
      heading.scrollIntoView({ block: 'start' });
    });
    item.append(link);
    list.append(item);
  }
  nav.append(list);
}
function renderStaffManuals(root, manuals, manualBodies) {
  const oneDocument = manuals.filter(manual => manual.google_doc_inline).length === 1;
  root.innerHTML = `<div class="manual-layout"><aside class="manual-sidebar" aria-label="マニュアルの目次"><p>目次</p><div class="manual-sidebar-list"></div></aside><section class="panel"><h2>マニュアル</h2>${
    manuals
      .map((manual, index) => {
        if (!manual.google_doc_url)
          return `<details data-manual-index="${index}"><summary>${esc(manual.title)}</summary><div class="prose manual-doc-body">${markdown(manual.body)}</div><p class="quiet">更新：${esc(dateLabel(manual.updated_at, false))}</p></details>`;
        const hasBody = typeof manual.google_doc_html === 'string';
        return `<article class="manual-document">
      <div><h3>${esc(manual.title)}</h3>${manual.excerpt ? `<p>${esc(manual.excerpt)}</p>` : ''}</div>
      <a class="button secondary small" href="${esc(manual.google_doc_url)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(manual.title)}を Google ドキュメントで開く（新しいタブ）">Google ドキュメントで開く</a>
      ${manual.google_doc_inline ? `<details data-manual-index="${index}" ${oneDocument ? 'open' : ''}><summary>本文を読む</summary><div class="prose manual-doc-body">${hasBody ? manualBody(manual.google_doc_html) : ''}</div></details>` : ''}
      ${manual.body ? `<details><summary>補足を読む</summary><div class="prose">${markdown(manual.body)}</div></details>` : ''}
    </article>`;
      })
      .join('') || empty('マニュアルは準備中です')
  }</section></div>`;
  const sidebar = root.querySelector('.manual-sidebar-list');
  const readers = root.querySelectorAll('[data-manual-index]');
  for (const details of readers) {
    const manualIndex = Number(details.dataset.manualIndex);
    const manual = manuals[manualIndex];
    const body = details.querySelector('.manual-doc-body');
    const nav = document.createElement('nav');
    nav.className = 'manual-contents';
    nav.setAttribute('aria-label', manual.title);
    nav.hidden = true;
    sidebar.append(nav);
    const updateContentsVisibility = () => (nav.hidden = !details.open || !nav.childElementCount);
    details.addEventListener('toggle', updateContentsVisibility);
    const showContents = () => {
      addManualContents(body, nav, manualIndex + 1, readers.length > 1 ? manual.title : '');
      updateContentsVisibility();
    };
    if (!manual.google_doc_url || typeof manual.google_doc_html === 'string') {
      showContents();
      continue;
    }
    const key = `${manual.id}:${manual.updated_at}`;
    let loading = false,
      loaded = false;
    async function load() {
      if (!details.open || loading || loaded) return;
      loading = true;
      body.innerHTML = '<p role="status">本文を読み込んでいます…</p>';
      if (!manualBodies.has(key)) {
        const pending = api(`/api/staff/manuals/${encodeURIComponent(manual.id)}/document`).catch(error => {
          if (manualBodies.get(key) === pending) manualBodies.delete(key);
          throw error;
        });
        manualBodies.set(key, pending);
      }
      try {
        const result = await manualBodies.get(key);
        loaded = true;
        if (body.isConnected) {
          body.innerHTML = manualBody(result.html);
          showContents();
        }
      } catch {
        if (body.isConnected) {
          body.innerHTML =
            '<p class="notice error">本文を読み込めませんでした。もう一度試すか、上のリンクから Google ドキュメントを開いてください。</p><button type="button" class="button secondary small">読み込み直す</button>';
          body.querySelector('button').onclick = load;
        }
      } finally {
        loading = false;
      }
    }
    details.addEventListener('toggle', load);
    void load();
  }
}
function renderCheki(root, data) {
  let audience = null,
    image = null,
    previewUrl = null,
    confirmed = false,
    batchId = crypto.randomUUID(),
    generation = 0;
  const events = data.cheki_events.filter(e => Date.parse(e.starts_at) <= Date.now());
  root.innerHTML = `<div class="staff-layout"><section class="panel"><h2>チェキを一斉送信</h2><p>自分をお気に入り登録していて、選んだ営業回にもチェックイン済みのお客さんに送ります。あとから両方の登録を済ませた人にも届きます。</p>${
    !data.cheki_cast
      ? '<p class="notice">送信するには、運営にキャスト紹介と本人のDiscordアカウントの紐付けを依頼してください。</p>'
      : !events.length
        ? empty('送信できる営業回はまだありません')
        : `<p class="quiet">送信するキャスト：${esc(data.cheki_cast.display_name)}</p><form id="cheki-form">${select(
            '来店を確認する営業回',
            'event_id',
            events.map(e => [e.id, `${dateLabel(e.starts_at, false)} ${e.title}`])
          )}<button class="button secondary small" type="button" id="check-audience">対象人数を確認する</button><p id="cheki-audience" class="cheki-audience" role="status">営業回を選び、対象人数を確認してください。</p>${field('書き込み済みのチェキ画像', 'image', '', 'file', 'accept="image/jpeg,image/png,image/webp" required')}<p class="inline-help">JPEG・PNG・WebP。長辺2400pxまでに整えて保存します。</p><img id="cheki-preview" class="image-preview" alt="送信するチェキの確認" hidden>${textarea('メッセージ（任意）', 'message', '', 'maxlength="500"')}<div class="cheki-confirm" id="cheki-confirm" hidden></div><div class="form-actions"><button class="button" type="submit" disabled>送信内容を確認する</button></div></form>`
  }</section><section class="panel"><h2>送信履歴</h2><ul class="record-list">${data.sent.map(c => `<li><strong>${esc(c.event_title || '過去のチェキ')} ／ ${esc(c.recipient_count)}人</strong><small>${esc(dateLabel(c.created_at))}${c.withdrawn ? ' ／ 取り消し済み' : ''}</small>${c.message ? `<p>${esc(c.message)}</p>` : ''}${!c.withdrawn ? `<div><button class="text-button" data-withdraw="${esc(c.id)}">送信を取り消す</button></div>` : ''}</li>`).join('') || empty('送信履歴はありません')}</ul></section></div>`;
  const form = root.querySelector('#cheki-form');
  if (form) {
    const send = form.querySelector('[type=submit]'),
      check = root.querySelector('#check-audience'),
      summary = root.querySelector('#cheki-audience'),
      confirmation = root.querySelector('#cheki-confirm'),
      preview = root.querySelector('#cheki-preview');
    function resetConfirmation() {
      confirmed = false;
      batchId = crypto.randomUUID();
      confirmation.hidden = true;
      send.textContent = '送信内容を確認する';
    }
    form.elements.event_id.onchange = () => {
      generation++;
      audience = null;
      send.disabled = true;
      summary.textContent = '対象人数を確認してください。';
      resetConfirmation();
    };
    form.elements.message.oninput = resetConfirmation;
    check.onclick = async () => {
      check.disabled = true;
      const version = ++generation,
        eventId = form.elements.event_id.value;
      audience = null;
      send.disabled = true;
      resetConfirmation();
      summary.textContent = '対象人数を確認しています…';
      try {
        const fresh = await api('/api/staff/recipients?event_id=' + encodeURIComponent(eventId));
        if (version !== generation) return;
        audience = fresh;
        summary.textContent = fresh.count
          ? `現在の対象：${fresh.count}人`
          : '現在の対象：0人。あとから条件がそろうと届きます。';
        send.disabled = false;
      } catch (error) {
        if (version === generation) summary.textContent = '人数を確認できませんでした。もう一度確認してください。';
        toast(error.message, true);
      } finally {
        check.disabled = false;
        send.disabled = !audience;
      }
    };
    form.elements.image.onchange = async event => {
      image = null;
      resetConfirmation();
      preview.hidden = true;
      const file = event.target.files[0];
      try {
        const optimized = await optimizedImage(file);
        if (event.target.files[0] !== file) return;
        image = optimized;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = URL.createObjectURL(image);
        preview.src = previewUrl;
        preview.hidden = false;
      } catch (error) {
        toast(error.message, true);
      }
    };
    form.onsubmit = event => {
      event.preventDefault();
      submit(event.submitter, async () => {
        if (!audience || audience.event.id !== form.elements.event_id.value)
          throw new Error('対象人数を確認してください。');
        if (!image) throw new Error('チェキ画像の準備ができてから確認してください。');
        if (!confirmed) {
          confirmation.innerHTML = `<h3>送信内容の確認</h3><p>${esc(dateLabel(audience.event.starts_at, false))} ${esc(audience.event.title)}</p><p><strong>${audience.count}人に、この画像とメッセージを送ります。</strong></p><p class="quiet">あとからお気に入り登録とチェックインを済ませた人にも届きます。</p>${form.elements.message.value ? `<p class="preserve">${esc(form.elements.message.value)}</p>` : '<p class="quiet">メッセージなし</p>'}`;
          confirmation.hidden = false;
          send.textContent = audience.count ? `${audience.count}人に一斉送信する` : 'チェキを登録する';
          confirmed = true;
          return;
        }
        const upload = new FormData();
        upload.set('event_id', audience.event.id);
        upload.set('audience_hash', audience.audience_hash);
        upload.set('batch_id', batchId);
        upload.set('image', image);
        upload.set('message', form.elements.message.value);
        try {
          const result = await api('/api/staff/cheki', { method: 'POST', body: upload });
          toast(
            result.count
              ? `${result.count}人にチェキを送りました`
              : 'チェキを登録しました。条件がそろったお客さんに届きます'
          );
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          renderCheki(root, await api('/api/staff'));
        } catch (error) {
          if (error.code === 'AUDIENCE_CHANGED') {
            audience = null;
            send.disabled = true;
            summary.textContent = '対象人数を確認し直してください。';
            resetConfirmation();
          }
          throw error;
        }
      }).finally(() => {
        send.disabled = !audience;
      });
    };
  }
  root.querySelectorAll('[data-withdraw]').forEach(
    button =>
      (button.onclick = () =>
        submit(button, async () => {
          if (
            !confirm('対象のお客さん全員へのチェキ表示を取り消します。保存済みの画像は取り消せません。よろしいですか？')
          )
            return;
          await api('/api/staff/cheki/withdraw', { method: 'POST', body: { id: button.dataset.withdraw } });
          toast('送信を取り消しました');
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          renderCheki(root, await api('/api/staff'));
        }))
  );
}

function renderCastProfile(root, profile, onChange) {
  root.innerHTML = `<section class="panel"><h2>キャスト紹介を編集</h2>${!profile ? '<p class="notice">運営にキャスト紹介の登録と、本人のDiscordアカウントの紐付けを依頼してください。</p>' : `<p><strong>${esc(profile.display_name)}</strong><span class="quiet"> ／ ${profile.active ? '公開中' : '非公開'}</span></p><p class="quiet">${profile.active ? '保存すると公開HPに反映されます。' : '現在は非公開です。運営が公開するとHPに表示されます。'}</p><form id="cast-profile-form">${field('ひとこと', 'tagline', profile.tagline, 'text', 'maxlength="120"')}${textarea('プロフィール', 'bio', profile.bio, 'maxlength="3000"')}${field('プロフィール写真', 'photo', '', 'file', 'accept="image/jpeg,image/png,image/webp"')}<p class="inline-help">写真は3:4（900×1200px）に調整できます。</p><button class="button secondary small" type="button" id="adjust-staff-cast-photo" ${profile.image_id ? '' : 'hidden'}>写真を調整する</button><input type="hidden" name="image_id" value="${esc(profile.image_id || '')}"><img id="staff-cast-image-preview" class="image-preview" alt="プロフィール写真" ${profile.image_id ? `src="/api/images/${encodeURIComponent(profile.image_id)}"` : 'hidden'}><div class="field-pair">${field('XのURL', 'x_url', profile.x_url, 'url', 'maxlength="2048" placeholder="https://x.com/…"')}${field('YouTubeのURL', 'youtube_url', profile.youtube_url, 'url', 'maxlength="2048" placeholder="https://www.youtube.com/…"')}</div><div class="form-actions"><button class="button secondary" type="button" id="preview-cast-profile">プレビュー</button><button class="button" type="submit">紹介を保存する</button></div></form>`}</section>`;
  const form = root.querySelector('#cast-profile-form');
  if (!form) return;
  const photoInput = form.elements.photo,
    adjustButton = root.querySelector('#adjust-staff-cast-photo'),
    previewButton = root.querySelector('#preview-cast-profile'),
    saveButton = form.querySelector('[type=submit]');
  let sourcePhoto = null,
    photoBusy = false;
  async function saveProfile(values) {
    const result = await api('/api/staff/profile', { method: 'POST', body: values });
    onChange(result.profile);
    renderCastProfile(root, result.profile, onChange);
    toast('キャスト紹介を保存しました');
  }
  function profileValues() {
    const values = Object.fromEntries(new FormData(form));
    delete values.photo;
    return { cast_id: profile.id, ...values };
  }
  previewButton.onclick = () => {
    if (form.reportValidity()) {
      const values = profileValues();
      showCastPreview({ ...profile, ...values }, { onSave: () => saveProfile(values) });
    }
  };
  async function adjustPhoto(selected) {
    if (photoBusy) return;
    photoBusy = true;
    const controls = [photoInput, adjustButton, previewButton, saveButton],
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
      upload.set('cast_id', profile.id);
      upload.set('image', adjusted);
      const image = await api('/api/staff/profile/image', { method: 'POST', body: upload });
      sourcePhoto = original;
      form.elements.image_id.value = image.id;
      const preview = root.querySelector('#staff-cast-image-preview');
      preview.src = image.url;
      preview.hidden = false;
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
    submit(event.submitter, () => saveProfile(profileValues()));
  };
}
