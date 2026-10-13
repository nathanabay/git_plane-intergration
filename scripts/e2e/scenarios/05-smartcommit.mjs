// Context7: /websites/github_en_rest (Contents commits, App delivery attempts),
// /websites/developers_plane_so (v1 comments and states). Commands themselves are repository behavior.
import {cfg, sql, waitFor, scenario, name, assert, eq, fixture, branch, comments,
  stateIs, stateId, itemNow, delivery, settled, redeliver} from './04-dev.mjs';
export async function smartAudit(sha, {kind='smart_commit', outcome}={}) {
  return waitFor(async()=> (await sql(`SELECT id,kind,outcome,error,detail,delivery_id FROM audit_log
    WHERE workspace_slug=$1 AND source='github' AND kind=$2 AND detail->>'sha'=$3 ORDER BY id DESC`,[cfg.slug,kind,sha])).find(r=>!outcome||r.outcome===outcome),
    {label:`${kind} ${sha.slice(0,7)}`});
}
export async function smartFixture(ctx, command) {
  const item=await fixture(ctx);const b=await branch(ctx,{message:name(`${item.key} ${command}`)});
  ctx.evidence('Smart Commit source',{key:item.key,sha:b.sha,command}); return {item,b};
}
scenario('S38','Smart Commit comment is attributed and linked to commit',async ctx=>{
  const text=name(`${ctx.id} comment payload`);const {item,b}=await smartFixture(ctx,`#comment ${text}`);
  const row=await smartAudit(b.sha);assert(['registered','applied'].includes(row.outcome),'comment command accepted');
  const found=await waitFor(async()=>{const c=(await comments(item)).filter(c=>c.comment_html?.includes(text));return c.length&&c;},{label:'Smart Commit comment'});
  await settled(item.id);eq(found.length,1,'one Smart Commit comment');assert(found[0].comment_html.includes(b.sha),'comment has source commit link');assert(found[0].comment_html.includes(`by ${cfg.owner}`),'comment attributes authenticated sender');
  ctx.evidence('Smart Commit comment',{id:found[0].id,html:found[0].comment_html,audit:row.id});
});
scenario('S39','Smart Commit done transition completes linked item',async ctx=>{
  const {item,b}=await smartFixture(ctx,'#done');const row=await smartAudit(b.sha);assert(['registered','applied'].includes(row.outcome),'transition accepted');
  const current=await stateIs(item,'completed','Done');ctx.evidence('done command',{sha:b.sha,state:stateId(current),audit:row.id});
});
scenario('S40','Smart Commit executes once on real push redelivery',async ctx=>{
  const text=name(`${ctx.id} once only`);const {item,b}=await smartFixture(ctx,`#comment ${text}`);
  await smartAudit(b.sha);await waitFor(async()=> (await comments(item)).some(c=>c.comment_html?.includes(text)),{label:'original command applied'});
  await settled(item.id);const before=(await comments(item)).filter(c=>c.comment_html?.includes(text));eq(before.length,1,'positive control original comment');
  const stepsBefore=await sql(`SELECT id,delivery_id FROM audit_log WHERE workspace_slug=$1 AND kind='smart_commit_step' AND detail->>'sha'=$2`,[cfg.slug,b.sha]);eq(stepsBefore.length,1,'one command step');
  const original=await delivery('push',b.sha);await redeliver(ctx,original);await settled(item.id);
  eq((await comments(item)).filter(c=>c.comment_html?.includes(text)).length,1,'no duplicate comment after observed redelivery');
  const after=await sql(`SELECT id,delivery_id FROM audit_log WHERE workspace_slug=$1 AND kind='smart_commit_step' AND detail->>'sha'=$2`,[cfg.slug,b.sha]);eq(after,stepsBefore,'no second registered step');
  ctx.evidence('once-only comment',{id:before[0].id,step:stepsBefore[0].delivery_id});
});
scenario('S41','Unknown Smart Commit transition is rejected and audited',async ctx=>{
  const command=`nosuchstate-${cfg.runId}`;const {item,b}=await smartFixture(ctx,`#${command}`);
  const failed=await smartAudit(b.sha,{kind:'smart_commit_failed',outcome:'failed'});
  assert(failed.error?.includes('matches no state'),'audit records unknown state reason');eq(failed.detail.key,item.key,'audit identifies intended item');
  await delivery('push',b.sha);await settled(item.id);eq(stateId(await itemNow(item)),item.initialState,'unknown command leaves state unchanged');
  const applied=await sql(`SELECT id FROM audit_log WHERE workspace_slug=$1 AND kind='smart_commit_step' AND detail->>'sha'=$2`,[cfg.slug,b.sha]);eq(applied.length,0,'no successful step for invalid transition');
  ctx.evidence('unknown transition audit',{id:failed.id,error:failed.error,detail:failed.detail});
});
