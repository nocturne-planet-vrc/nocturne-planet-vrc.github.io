// API entry point. Route handlers live in src/routes/, one file per area.
//
// Order of checks for signed-in areas (/api/member, /api/staff, /api/manage):
//   1. Discord membership / role for the area (actorFor)
//   2. CSRF and the per-user mutation rate limit for non-GET requests
//   3. Route lookup; unknown routes return 404 only after 1 and 2.
import { HttpError, rateLimit } from './core.mjs';
import { actorFor, requireMutation } from './auth.mjs';
import { ensureManageTrash } from './schema.mjs';
import { sendReminders, authorizeCron } from './reminders.mjs';
import { findRoute, json } from './routes/shared.mjs';
import { publicRoutes } from './routes/public.mjs';
import { memberRoutes } from './routes/member.mjs';
import { staffRoutes } from './routes/staff.mjs';
import { manageRoutes } from './routes/manage.mjs';

export { json };

async function cronReminders({ request, env, fetcher }) {
  authorizeCron(request, env);
  return json(await sendReminders(env, fetcher));
}

const openRoutes = [...publicRoutes, ['POST', '/api/cron/reminders', cronReminders]];
const areas = [
  ['manage', '/api/manage', manageRoutes],
  ['staff', '/api/staff', staffRoutes],
  ['member', '/api/member', memberRoutes]
];

export async function handleApi(request, env, fetcher = fetch) {
  await ensureManageTrash(env);
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method,
    ctx = { request, env, fetcher, url, path, method };

  const open = findRoute(openRoutes, method, path);
  if (open) return open.handler({ ...ctx, match: open.match });

  const [area, , routes] = areas.find(([, prefix]) => path.startsWith(prefix)) || [];
  if (!area) throw new HttpError(404, 'ページが見つかりません。');
  const actor = await actorFor(request, env, area, fetcher);
  if (method !== 'GET') {
    await requireMutation(request, actor, env);
    await rateLimit(env.DB, `mutation:${actor.id}`, 90);
  }
  const route = findRoute(routes, method, path);
  if (!route) throw new HttpError(404, 'ページが見つかりません。');
  return route.handler({ ...ctx, area, actor, match: route.match });
}
