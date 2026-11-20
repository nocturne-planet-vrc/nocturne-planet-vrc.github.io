import { api, esc, dateLabel, field, toast, setSession } from './ui.mjs';
const syncTimers = new WeakMap();
const renderVersions = new WeakMap();
const ownProfile = 'https://vrchat.com/home/profile';
const profileHelp = 'https://help.vrchat.com/hc/en-us/articles/4408181867027';
const errorMessage = '<p class="vrchat-error" role="alert" hidden></p>';

function challengeMarkup(challenge) {
  return `<div class="vrchat-challenge">
    <ol class="vrchat-steps">
      <li>
        <h3>確認コードをコピー</h3>
        <div class="vrchat-code-row"><input id="vrchat-code" class="vrchat-code" type="text" aria-label="確認コード" value="${esc(challenge.code)}" readonly><button class="button secondary small" type="button" id="vrchat-copy-code">コピー</button></div>
        <p class="quiet" id="vrchat-copy-status" role="status"></p>
      </li>
      <li>
        <h3>VRChatの自己紹介に貼って保存</h3>
        <p>「Edit Profile」で、自己紹介（Bio）の末尾にコードだけの行を追加してください。</p>
        <a class="button secondary small" href="${esc(challenge.profile_url || ownProfile)}" target="_blank" rel="noopener noreferrer">VRChatプロフィールを開く</a>
      </li>
      <li>
        <h3>のくぷらに戻って連携</h3>
        <form id="vrchat-verify">
          ${
            challenge.profile_url
              ? ''
              : `${field('プロフィールURLまたはユーザーID', 'profile_url', '', 'text', 'required inputmode="url" maxlength="300" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://vrchat.com/home/user/usr_…"')}
          <p class="quiet vrchat-field-help"><a class="text-link" href="${profileHelp}" target="_blank" rel="noopener noreferrer">プロフィールURLの見つけ方</a></p>`
          }
          <button class="button small" type="submit" data-vrchat-mutation>確認して連携する</button>${errorMessage}
        </form>
      </li>
    </ol>
    <form id="vrchat-start" class="vrchat-reissue"><div><span class="quiet">有効期限 ${esc(dateLabel(challenge.expires_at))}</span><button class="text-button" type="submit" data-vrchat-mutation>コードを発行し直す</button></div>${errorMessage}</form>
  </div>`;
}

export function renderVrchat(
  root,
  status = { configured: false, linked: null, challenge: null },
  area,
  onChange = () => {}
) {
  clearTimeout(syncTimers.get(root));
  const version = {};
  renderVersions.set(root, version);
  if (status.session) setSession(status.session);
  onChange(status);
  const linked = status.linked,
    challenge = status.challenge;
  const previousProfile = root.querySelector('[name=profile_url]');
  const keepProfile = previousProfile && root.querySelector('#vrchat-code')?.value === challenge?.code;
  const restoreFocus = keepProfile && document.activeElement === previousProfile;
  root.innerHTML = `<h2 tabindex="-1">VRChatアカウント</h2>
    ${linked ? `<div class="vrchat-linked"><strong>${esc(linked.display_name)}</strong><span class="quiet">本人確認済み</span><a class="text-link" href="${esc(linked.profile_url)}" target="_blank" rel="noopener noreferrer">VRChatプロフィールを開く</a><p class="quiet">確認日 ${esc(dateLabel(linked.verified_at, false))}</p><button class="text-button" type="button" id="vrchat-unlink" data-vrchat-mutation>連携を解除する</button></div>` : ''}
    ${
      !status.configured
        ? '<p class="notice">自動本人確認は準備中です。利用できるようになり次第、お知らせします。</p>'
        : challenge
          ? challengeMarkup(challenge)
          : `<form id="vrchat-start">
      ${linked ? '' : '<p>VRChatの自己紹介に確認コードを貼り付けて、アカウントを連携できます。</p>'}
      <button class="button ${linked ? 'secondary ' : ''}small" type="submit" data-vrchat-mutation>${linked ? '連携先を変更する' : 'VRChat連携をはじめる'}</button>${errorMessage}
    </form>`
    }`;
  const profileInput = root.querySelector('[name=profile_url]');
  if (keepProfile && profileInput) {
    profileInput.value = previousProfile.value;
    if (restoreFocus) {
      profileInput.focus({ preventScroll: true });
      profileInput.setSelectionRange(previousProfile.selectionStart, previousProfile.selectionEnd);
    }
  }
  if (area === 'member') {
    const explanation = document.createElement('p');
    explanation.className = 'quiet';
    explanation.textContent =
      '連携後は会員ページにVRChat名を表示し、お客様用Discordサーバーのニックネームも同じ名前に更新します。';
    root.querySelector('h2').after(explanation);
    if (linked) {
      const sync = document.createElement('div');
      sync.className = 'vrchat-nickname';
      sync.innerHTML = `<p class="${status.nickname?.status === 'synced' ? 'quiet' : 'notice'}" role="status">${esc(status.nickname?.message || 'お客様用Discordサーバーのニックネームは自動で同期します。')}</p><p class="quiet">Discord側の名前は32文字までです。連携を解除しても、Discordのニックネームは元に戻りません。</p>`;
      root.querySelector('.vrchat-linked').after(sync);
    }
  }
  const action = (name, body = {}) => api(`/api/${area}/vrchat/${name}`, { method: 'POST', body });
  let working = false;
  if (area === 'member' && linked && status.nickname?.status !== 'synced') {
    const retry = async () => {
      if (!root.isConnected) return;
      if (document.hidden || working) {
        syncTimers.set(root, setTimeout(retry, 30000));
        return;
      }
      let fresh;
      try {
        fresh = await action('sync-name');
      } catch {
        fresh = {
          ...status,
          nickname: {
            status: 'failed',
            message: 'Discordの名前は時間を置いて自動で同期します。',
            retry_after: Math.floor(Date.now() / 1000) + 300
          }
        };
      }
      if (!root.isConnected || renderVersions.get(root) !== version) return;
      if (working) {
        syncTimers.set(root, setTimeout(retry, 30000));
        return;
      }
      renderVrchat(root, fresh, area, onChange);
    };
    const delay = Math.max(
      1000,
      (status.nickname?.retry_after || Math.floor(Date.now() / 1000) + 300) * 1000 - Date.now() + 1000
    );
    syncTimers.set(root, setTimeout(retry, delay));
  }
  async function mutate(button, name, body, message, focus) {
    if (working) return;
    working = true;
    const buttons = root.querySelectorAll('[data-vrchat-mutation]');
    const errorNode = button.form?.querySelector('.vrchat-error');
    buttons.forEach(control => {
      control.disabled = true;
    });
    if (errorNode) {
      errorNode.hidden = true;
      errorNode.textContent = '';
    }
    try {
      const fresh = await action(name, body);
      if (renderVersions.get(root) !== version) return;
      renderVrchat(root, fresh, area, onChange);
      if (root.isConnected) {
        root.querySelector(focus)?.focus({ preventScroll: true });
        if (message) toast(message);
      }
    } catch (error) {
      if (errorNode) {
        errorNode.hidden = false;
        errorNode.textContent = error.message;
      } else if (root.isConnected) toast(error.message, true);
    } finally {
      working = false;
      buttons.forEach(control => {
        control.disabled = false;
      });
    }
  }
  const start = root.querySelector('#vrchat-start');
  if (start)
    start.onsubmit = event => {
      event.preventDefault();
      void mutate(start.querySelector('button'), 'start', {}, '', '#vrchat-copy-code');
    };
  const verify = root.querySelector('#vrchat-verify');
  if (verify)
    verify.onsubmit = event => {
      event.preventDefault();
      void mutate(
        verify.querySelector('button'),
        'verify',
        Object.fromEntries(new FormData(verify)),
        'VRChatアカウントを連携しました。自己紹介からコードを削除できます。',
        'h2'
      );
    };
  const copy = root.querySelector('#vrchat-copy-code');
  if (copy)
    copy.onclick = async () => {
      const code = root.querySelector('#vrchat-code'),
        feedback = root.querySelector('#vrchat-copy-status');
      try {
        await navigator.clipboard.writeText(code.value);
        feedback.textContent = 'コピーしました';
      } catch {
        code.focus();
        code.select();
        feedback.textContent = 'コードを選択しました。長押しやキーボードでコピーしてください。';
      }
    };
  const unlink = root.querySelector('#vrchat-unlink');
  if (unlink)
    unlink.onclick = () => {
      if (confirm('VRChatアカウントの連携を解除します。来店記録やチェキは残ります。よろしいですか？'))
        void mutate(unlink, 'unlink', {}, 'VRChatアカウントの連携を解除しました', 'h2');
    };
}
