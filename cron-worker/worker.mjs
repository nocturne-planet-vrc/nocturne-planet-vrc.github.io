// Runs every minute and asks the site to send attendance-deadline reminders.
// Cloudflare Pages Functions cannot run on a schedule, so this tiny Worker carries the cron trigger.
// Secret: CRON_SECRET (same value as the Pages project's CRON_SECRET).
export default {
  async scheduled(controller,env,ctx){
    const response=await fetch(env.SITE_ORIGIN+'/api/cron/reminders',{method:'POST',headers:{Authorization:'Bearer '+env.CRON_SECRET}});
    if(!response.ok)throw new Error('reminders failed: '+response.status+' '+(await response.text()).slice(0,200));
  },
  async fetch(){return new Response('Not found',{status:404});}
};

