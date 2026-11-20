// VRChat account linking, shared by the member and staff areas.
import { HttpError, rateLimit } from '../core.mjs';
import { vrchatStatus, vrchatAction } from '../vrchat.mjs';
import { syncCustomerNickname } from '../customer-name.mjs';
import { json, sessionData } from './shared.mjs';

async function vrchat({ request, env, fetcher, actor, area, match }) {
  const action = match[2];
  if (action === 'sync-name' && area !== 'member') throw new HttpError(404, 'ページが見つかりません。');
  if (action === 'sync-name') await rateLimit(env.DB, `nickname:retry:${actor.id}`, 5, 60);
  const status =
    action === 'sync-name'
      ? await vrchatStatus(actor.id, env)
      : await vrchatAction(action, request, actor, env, fetcher);
  if (area === 'member') {
    actor.name = status.linked?.display_name || actor.session.display_name;
    if (action === 'verify' || action === 'sync-name')
      status.nickname = await syncCustomerNickname(actor, status.linked, env, fetcher);
    status.session = await sessionData(actor, env);
  }
  return json(status);
}

export const vrchatRoute = ['POST', /^\/api\/(member|staff)\/vrchat\/(start|verify|unlink|sync-name)$/, vrchat];
