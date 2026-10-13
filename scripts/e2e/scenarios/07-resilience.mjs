// Context7 /websites/github_en_rest: issue discussion and JWT-authenticated App delivery redelivery;
// /websites/developers_plane_so: work-item deletion, comment pagination. Reconcile is deployed source behavior.
import {createGhIssue, waitForPlaneItem, linksForGh, planeOrmJson} from '../lib.mjs';
import {cfg, gh, plane, sql, app, waitFor, scenario, name, items, assert, eq, fixture,
  pr, linked, comments, delivery, settled, redeliver, browser, mappingApi} from './04-dev.mjs';
export async function mirror(ctx) {
  const label=await gh('GET','repo:/labels/plane');eq(label.status,200,'shared plane opt-in label already exists'); const issue=await createGhIssue(ctx,`${ctx.id} reconciliation fixture`,name('Run-owned mirror'),['plane']);
  // Discovery cleanup also catches a mirror created after a polling failure.
  ctx.cleanup(async()=>{for(const l of await linksForGh(issue.number)) if(l.gh_kind==='issue') {
    const r=await plane('GET',items(l.plane_issue_id));if(r.status===200&&r.data.name.includes(cfg.runId)) { const deleted=await plane('DELETE',items(l.plane_issue_id)); assert([204,404].includes(deleted.status),`mirror cleanup → ${deleted.status}`); }
  }});
  const item=await waitForPlaneItem(issue.number);await delivery('issues',issue.number,{action:'opened'});await settled(item.id);await settled(String(issue.number));
  assert(item.name.includes(cfg.runId),'mirror carries run ID');ctx.evidence('mirror fixture',{issue:issue.number,item:item.id});return {issue,item};
}
export async function sweep(item) {
  // Filter only the list of candidate links. The actual reducer, lookup and classification run unchanged.
  // This prevents a test-triggered sweep from marking other authors' fixtures orphaned.
  return app(`const {reconcileOnce}=await import('/app/src/sync/reconcile.ts');
    const scopedDb={...db, query:async(text,values=[])=>{
      if(text.startsWith('SELECT * FROM sync_links WHERE status =')) {
        text=text.replace(' ORDER BY id', ' AND plane_issue_id = $'+(values.length+1)+' ORDER BY id');
        values=[...values,${JSON.stringify(item.id)}];
      }
      return db.query(text,values);
    }};
    const result=await reconcileOnce({db:scopedDb,plane:planeClient});
    const links=(await db.query('SELECT id,status,plane_archived_at,missing_since FROM sync_links WHERE plane_issue_id=$1',[${JSON.stringify(item.id)}])).rows;
    return {result,links};`);
}
scenario('S46','Real issue-comment redelivery has no second mirror effect',async ctx=>{
  const {issue,item}=await mirror(ctx);const text=name(`${ctx.id} once-only GitHub comment`);
  const c=await gh('POST',`repo:/issues/${issue.number}/comments`,{body:text});eq(c.status,201,'owned GitHub comment');
  const original=await delivery('issue_comment',c.data.id,{action:'created'});
  const before=await waitFor(async()=>{const r=(await comments(item)).filter(c=>c.comment_html?.includes(text));return r.length&&r;},{label:'original mirrored comment'});
  eq(before.length,1,'positive control one mirror');await settled(item.id);await redeliver(ctx,original);await settled(item.id);
  const after=(await comments(item)).filter(c=>c.comment_html?.includes(text));eq(after.map(c=>c.id),before.map(c=>c.id),'same single Plane comment after observed redelivery');
  ctx.evidence('mirrored comment deduplication',{githubComment:c.data.id,planeComment:before[0].id});
});
scenario('S47','Deleted item is orphaned on first sweep and GitHub remains untouched',async ctx=>{
  const {issue,item}=await mirror(ctx);const before=await gh('GET',`repo:/issues/${issue.number}`);eq(before.status,200,'GitHub positive control');
  const deleted=await plane('DELETE',items(item.id));eq(deleted.status,204,'delete owned Plane mirror');
  // Plane records deletion asynchronously. Wait for that evidence before the one decisive sweep.
  const activity=await waitFor(()=>planeOrmJson(`from plane.db.models import IssueActivity\nrows=list(IssueActivity.objects.filter(issue_id=${JSON.stringify(item.id)},verb='deleted').values('id','verb','field'))\nprint(json.dumps([{**r,'id':str(r['id'])} for r in rows]))`).then(rows=>rows.length&&rows),{label:'Plane deletion activity'});
  const first=await sweep(item);eq(first.result.errors,0,'first sweep has no errors');eq(first.links.length,1,'one fixture mirror link');eq(first.links[0].status,'orphaned','first sweep orphaned');eq(first.result.orphaned,1,'one first-sweep orphan');
  const after=await gh('GET',`repo:/issues/${issue.number}`);eq(after.status,200,'GitHub issue still readable');
  eq({state:after.data.state,title:after.data.title,body:after.data.body,updated:after.data.updated_at},
    {state:before.data.state,title:before.data.title,body:before.data.body,updated:before.data.updated_at},'sweep does not mutate GitHub');
  ctx.evidence('first deletion sweep',{activity,first,githubState:after.data.state});
});
scenario('S48','Archived mirror stays active across two sweeps',async ctx=>{
  const {issue,item}=await mirror(ctx);const before=await gh('GET',`repo:/issues/${issue.number}`);
  // Deliberately bypass the activity task, reproducing E2E-2's decisive real-Plane failure mode.
  ctx.cleanup(async()=>{const restored=await planeOrmJson(`from plane.db.models import Issue\nn=Issue.objects.filter(id=${JSON.stringify(item.id)},project_id=${JSON.stringify(cfg.projectId)},workspace__slug=${JSON.stringify(cfg.slug)}).update(archived_at=None)\nprint(json.dumps({'restored':n}))`);eq(restored.restored,1,'restore owned archive before deleting');});
  const archived=await planeOrmJson(`from django.utils import timezone\nfrom plane.db.models import Issue\nn=Issue.objects.filter(id=${JSON.stringify(item.id)},project_id=${JSON.stringify(cfg.projectId)},workspace__slug=${JSON.stringify(cfg.slug)}).update(archived_at=timezone.now())\nprint(json.dumps({'archived':n}))`);eq(archived.archived,1,'archive only owned mirror');
  const hidden=await plane('GET',items(item.id));eq(hidden.status,404,'archived detail is hidden');
  const first=await sweep(item);const second=await sweep(item);ctx.evidence('two archive sweeps',{first,second});
  for(const [label,run] of [['first',first],['second',second]]) {eq(run.result.errors,0,`${label} archive sweep errors`);eq(run.links.length,1,`${label} one mirror link`);eq(run.links[0].status,'active',`${label} archive stays active`);assert(run.links[0].plane_archived_at,`${label} archive classification recorded`);eq(run.result.orphaned,0,`${label} no orphan`);eq(run.result.archived,1,`${label} recognized archive`);}
  const after=await gh('GET',`repo:/issues/${issue.number}`);eq({state:after.data.state,updated:after.data.updated_at},{state:before.data.state,updated:before.data.updated_at},'archive sweep leaves GitHub untouched');
},{defect:'E2E-2'});
scenario('S49','Backfill restores an existing PR reference',async ctx=>{
  const item=await fixture(ctx);const pull=await pr(ctx,{item});const original=await linked(item,pull.number);
  await delivery('pull_request',String(pull.number),{action:'opened'});await settled(item.id);
  // Simulate a historical missing association only on this run-created link, after its webhook settled.
  const removed=await sql(`DELETE FROM sync_links WHERE id=$1 AND plane_issue_id=$2 AND gh_number=$3 AND gh_kind='pr' AND created_by<>'label_sync' RETURNING id`,[original.id,item.id,pull.number]);eq(removed.length,1,'remove exactly one owned association');eq((await linksForGh(pull.number)).filter(l=>l.plane_issue_id===item.id).length,0,'backfill positive absence control');
  let cursor;const pages=[];
  for(let page=0;page<10;page++) {const r=await browser('POST',`${mappingApi}/backfill`,cursor?{cursor}:{});eq(r.status,200,'backfill through admin API');pages.push(r.data);if(r.data.complete!==false)break;cursor=r.data.cursor;assert(cursor,'partial backfill gives cursor');if(page===9)throw new Error('backfill pagination bound reached');}
  const restored=await linked(item,pull.number);eq(restored.tier,'closing','existing PR closing reference restored');eq(restored.created_by,'magic_word','backfill reference attribution');
  assert(pages.reduce((sum,r)=>sum+r.linked,0)>=1,'API reports links established');ctx.evidence('backfill restored reference',{pr:pull.number,key:item.key,beforeId:original.id,afterId:restored.id,pages});
});
