// API sources: Context7 /websites/github_en_rest (git/refs, repos/contents, pulls, statuses),
// /websites/github_en (GraphQL ready-for-review), /websites/developers_plane_so (v1 work-items).
// Shared helpers stay in this owned module; importing it registers S28–S37 once through ESM caching.
import { cfg, gh, plane, planeAll, sql, app, web, waitFor, scenario, name, items, assert, eq,
  projectStates, linksForGh } from '../lib.mjs';
export { cfg, gh, plane, planeAll, sql, app, web, waitFor, scenario, name, items, assert, eq };
export const workspaceApi = `/git-sync/api/workspaces/${cfg.slug}`;
export const mappingApi = `${workspaceApi}/mappings/${cfg.mappingId}`;
export const keyOf = (item) => `${cfg.projectKey}-${item.sequence_id}`;
export const stateId = (item) => typeof item.state === 'object' ? item.state?.id : item.state;
export const devApi = (id) => `${workspaceApi}/projects/${cfg.projectId}/work-items/${id}`;
export async function browser(method, path, body) { return (await web([[method, path, body]]))[0]; }
export async function dev(item) {
  const r = await browser('GET', `${devApi(item.id)}/development`);
  eq(r.status, 200, 'Development API'); return r.data;
}
export async function fixture(ctx, title = ctx.id) {
  const states = await projectStates();
  const initial = states.find(s => s.group === 'unstarted') ?? states.find(s => s.group === 'backlog');
  assert(initial, 'project has an initial state');
  const created=await plane('POST',items(),{name:name(title),state:initial.id});eq(created.status,201,'create run-owned Plane fixture');const item=created.data;
  ctx.evidence(`Plane item ${keyOf(item)}`,item.id);
  // Check cleanup results, rather than treating a failed DELETE as a clean run.
  ctx.cleanup(async () => { const r = await plane('DELETE', items(item.id)); assert([204,404].includes(r.status), `fixture deletion → ${r.status}`); });
  return {...item, key: keyOf(item), initialState: initial.id, states};
}
export async function itemNow(item) {
  const r = await plane('GET', items(item.id)); eq(r.status, 200, 'fixture read'); return r.data;
}
export async function stateIs(item, group, label) {
  const target = item.states.find(s => s.group === group && (!label || s.name === label));
  assert(target, `fixture state ${group}:${label ?? '*'} exists`);
  return waitFor(async () => { const current = await itemNow(item); return stateId(current) === target.id && current; },
    {label: `${item.key} state ${target.name}`});
}
export async function auditMark() { return Number((await sql('SELECT coalesce(max(id),0) AS id FROM audit_log'))[0].id); }
export async function delivery(event, needle, {after=0, action}={}) {
  const row = await waitFor(async () => {
    const rows = await sql(`SELECT id, delivery_id, outcome, error, detail FROM audit_log
      WHERE kind='inbound_delivery' AND source='github' AND id > $1 AND detail->>'event'=$2
      AND detail->'payload'->'repository'->>'full_name'=$3 ORDER BY id DESC LIMIT 300`, [after,event,cfg.repo]);
    return rows.find(r => { const p=r.detail?.payload; if(!p || (action && p.action!==action)) return false;
      if(event==='pull_request') return Number(p.pull_request?.number)===Number(needle);
      if(event==='issues') return Number(p.issue?.number)===Number(needle);
      if(event==='issue_comment') return Number(p.comment?.id)===Number(needle);
      if(event==='status') return p.sha===needle;
      if(event==='push') return p.after===needle || p.commits?.some(c=>c.id===needle);
      return JSON.stringify(p).includes(String(needle)); });
  }, {label: `${event}${action ? ':'+action : ''} delivery for ${needle}`});
  assert(row.outcome !== 'failed', `GitHub delivery failed: ${row.error}`);
  return row;
}
export async function settled(needle) {
  return waitFor(async () => {
    const rows = await sql(`SELECT id,status,error FROM outbound_writes WHERE workspace_slug=$1 AND (
      (write->>'number'=$2 OR write->'target'->>'number'=$2)
      OR (length($2::text)>20 AND write::text LIKE $3))`,
      [cfg.slug, String(needle), `%${needle}%`]);
    const failed = rows.filter(r=>r.status==='failed');
    assert(!failed.length, `fixture outbound failures: ${JSON.stringify(failed).slice(0,500)}`);
    return !rows.some(r=>r.status==='pending') && {writes:rows.length};
  }, {label:`outbox settled for ${needle}`});
}
export async function ghAll(path) {
  const out=[];
  for(let page=1;page<=30;page++) {
    const r=await gh('GET',`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);
    eq(r.status,200,'GitHub list'); assert(Array.isArray(r.data),'GitHub list returns array'); out.push(...r.data);
    if(r.data.length<100) return out;
  }
  throw new Error('GitHub pagination exceeded safe bound; absence cannot be asserted');
}
export async function issueComments(number) { return ghAll(`repo:/issues/${number}/comments`); }
export async function comments(item) { return planeAll(`${items(item.id)}comments/`); }
export function closePr(ctx, number) { ctx.cleanup(async () => {
  const r=await gh('PATCH',`repo:/pulls/${number}`,{state:'closed'}); eq(r.status,200,'close owned PR');
}); }
export function deleteBranch(ctx, branch) {
  assert(branch.toLowerCase().includes(cfg.runId.toLowerCase()), 'cleanup branch must carry run ID');
  ctx.cleanup(async()=>{
    const r=await gh('DELETE',`repo:/git/refs/heads/${encodeURIComponent(branch)}`);
    if(r.status!==204) { const absent=await gh('GET',`repo:/git/ref/heads/${encodeURIComponent(branch)}`); eq(absent.status,404,'branch cleanup confirmed absence'); }
  });
}
export async function branch(ctx, {key, message=name(`${ctx.id} fixture`)}={}) {
  const info=await gh('GET','repo:'); eq(info.status,200,'repository metadata');
  const base=info.data.default_branch;
  const ref=await gh('GET',`repo:/git/ref/heads/${encodeURIComponent(base)}`); eq(ref.status,200,'base ref');
  const branchName=`e2e_${cfg.runId}-${ctx.id.toLowerCase()}${key ? '-'+key : ''}`;
  const r=await gh('POST','repo:/git/refs',{ref:`refs/heads/${branchName}`,sha:ref.data.object.sha});
  eq(r.status,201,'create owned branch'); deleteBranch(ctx,branchName);
  const path=`e2e/${cfg.runId}/${ctx.id.toLowerCase()}.txt`;
  const commit=await gh('PUT',`repo:/contents/${path}`,{branch:branchName,message,
    content:Buffer.from(name(`${ctx.id} fixture\n`)).toString('base64')});
  eq(commit.status,201,'commit fixture via Contents API');
  ctx.evidence('branch and commit',{branch:branchName,sha:commit.data.commit.sha});
  return {branch:branchName,base,sha:commit.data.commit.sha,path,blobSha:commit.data.content.sha};
}
export async function pr(ctx, {item, reference, draft=false, body='', title}={}) {
  const b=await branch(ctx);
  const r=await gh('POST','repo:/pulls',{title:name(title ?? `${reference ?? 'Fixes'} ${item?.key ?? ''}`),
    head:b.branch,base:b.base,body:name(body || `${ctx.id} fixture`),draft});
  eq(r.status,201,'create owned PR'); closePr(ctx,r.data.number); ctx.evidence('PR',r.data.html_url);
  return {...r.data,fixtureBranch:b};
}
async function mergeFixturePr(ctx, pull) {
  await waitFor(async()=>{const r=await gh('GET',`repo:/pulls/${pull.number}`); return r.status===200 && r.data.mergeable===true && r.data;},{label:'owned PR mergeable'});
  const after=await auditMark();
  const merged=await gh('PUT',`repo:/pulls/${pull.number}/merge`,{sha:pull.head.sha,merge_method:'merge',commit_title:name(`Merge ${ctx.id}`)});
  eq(merged.status,200,'merge owned test PR');eq(merged.data.merged,true,'merged');
  ctx.cleanup(async()=>{const file=await gh('GET',`repo:/contents/${pull.fixtureBranch.path}?ref=${encodeURIComponent(pull.fixtureBranch.base)}`);
    if(file.status===200) {const r=await gh('DELETE',`repo:/contents/${pull.fixtureBranch.path}`,{message:name(`Clean ${ctx.id} fixture`),sha:file.data.sha,branch:pull.fixtureBranch.base});eq(r.status,200,'remove merged fixture file');}else eq(file.status,404,'merged fixture file absent');});
  const event=await delivery('pull_request',String(pull.number),{after,action:'closed'});
  eq(event.detail.payload.pull_request.merged,true,'observed merged PR delivery');
  return {sha:merged.data.sha,audit:event.id};
}
async function uniquePrTier(item, number, tier) {
  const links=(await linksForGh(number)).filter(l=>l.gh_kind==='pr' && l.plane_issue_id===item.id);
  eq(links.length,1,'exactly one item/PR association, with no duplicate closing tier');
  eq(links[0].status,'active','PR association remains active');eq(links[0].tier,tier,'PR reference tier');
  return links[0];
}
export async function linked(item, number) {
  return waitFor(async()=> (await linksForGh(number)).find(l=>l.gh_kind==='pr' && l.status==='active' && l.plane_issue_id===item.id),
    {label:`PR #${number} links ${item.key}`});
}
export async function rollup(item, number, status) {
  return waitFor(async()=>{const d=await dev(item); return d.prs.find(p=>p.url.endsWith(`/pull/${number}`) && p.status===status) && d;},
    {label:`PR #${number} ${status} rollup`});
}
export async function mappingData() { const r=await browser('GET',`${workspaceApi}/mappings`); eq(r.status,200,'read mappings'); const m=r.data.find(m=>m.id===cfg.mappingId); assert(m,'test mapping exists'); return m; }
export async function mappingSetting(ctx, field, value, {defect}={}) {
  const before=await mappingData();
  const previous=before[field];
  if(previous===undefined) { if(defect) ctx.defect(defect); throw new Error(`${defect ?? 'configuration'}: ${field} not exposed by deployed API`); }
  ctx.cleanup(async()=>{const r=await browser('PATCH',mappingApi,{[field]:previous}); eq(r.status,200,`restore ${field}`);});
  const r=await browser('PATCH',mappingApi,{[field]:value});
  if(r.status!==200 && defect) ctx.defect(defect);
  eq(r.status,200,`set ${field} through API${defect?' ('+defect+')':''}`);
  const after=await mappingData(); eq(after[field],value,`persisted ${field}`);
  ctx.evidence(`mapping ${field}`,value);
}
export async function redeliver(ctx, auditRow) {
  const matches=await waitFor(()=>app(`
    const repoId=Number((await db.query('SELECT gh_repo_id FROM repo_mappings WHERE id=$1',[${cfg.mappingId}])).rows[0].gh_repo_id);
    let cursor;
    for(let page=0;page<10;page++) {
      const list=await ghClient.appRequest('GET /app/hook/deliveries',{per_page:100,...(cursor?{cursor}:{})});
      const d=list.data.find(d=>d.guid===${JSON.stringify(auditRow.delivery_id)} && Number(d.repository_id)===repoId);
      if(d) return {id:String(d.id),guid:d.guid,event:d.event};
      const next=list.headers?.link?.match(/<([^>]+)>; rel="next"/);
      if(!next) return null;
      cursor=new URL(next[1]).searchParams.get('cursor');
      if(!cursor) throw new Error('App delivery next page lacks cursor');
    }
    throw new Error('App delivery pagination exceeded safe bound');
  `),{label:`App delivery ${auditRow.delivery_id}`});
  ctx.evidence('selected App delivery',matches);
  // The ingress queue retains completed jobs for a day. A replay can be rejected by BullMQ
  // before the worker, so a second audit row is not required. Observe the actual duplicate
  // enqueue event, matching this exact delivery, rather than merely seeing App HTTP 202.
  // Context7 /websites/api_bullmq_io: QueueEventsListener.duplicated({jobId}, streamId).
  const result=await app(`
    const {createRequire}=await import('node:module');
    const {QueueEvents}=createRequire('/app/package.json')('bullmq');
    const events=new QueueEvents('inbound-github',{connection:{url:config.REDIS_URL},prefix:config.QUEUE_PREFIX});
    const expected=${JSON.stringify('github-'+matches.guid)};
    let timer;
    const observed=new Promise(resolve=>{
      events.on('duplicated',({jobId},streamId)=>{if(jobId===expected)resolve({jobId,streamId});});
      events.on('error',error=>resolve({error:String(error.message).slice(0,300)}));
      timer=setTimeout(()=>resolve({error:'No backend duplicate enqueue observed within 60s'}),60000);
    });
    try {
      await events.waitUntilReady();
      const r=await ghClient.appRequest('POST /app/hook/deliveries/{delivery_id}/attempts',{delivery_id:${JSON.stringify(matches.id)}});
      return {status:r.status,duplicate:await observed};
    } finally {clearTimeout(timer);await events.close();}
  `,{timeout:80000});
  ctx.evidence('App redelivery and backend duplicate',result);eq(result.status,202,'real App redelivery accepted');
  eq(result.duplicate?.jobId,'github-'+matches.guid,'signed redelivery reached the backend and was deduplicated');
  assert(result.duplicate.streamId,'queue duplication stream receipt');
  ctx.evidence('real redelivery',{...matches,...result.duplicate});
}

scenario('S28','Development panel data and rendered branch template',async ctx=>{
  const item=await fixture(ctx); const d=await dev(item);
  eq(d.key,item.key,'item key'); eq(d.title,item.name,'item title'); eq(d.canCreateBranch,true,'member can create branch');
  for(const field of ['prs','builds','deployments','previews','branches']) assert(Array.isArray(d[field]),`panel ${field} array`);
  const repo=d.repos.find(r=>r.mappingId===cfg.mappingId); assert(repo,'mapped repository offered'); eq(repo.repo,cfg.repo,'repository scope');
  assert(repo.branchName.toUpperCase().includes(item.key),'template includes work-item key');
  assert(repo.branchName.toLowerCase().includes(cfg.runId.toLowerCase()),'template includes run-marked title');
  assert(repo.branchUrl.startsWith(`https://github.com/${cfg.repo}/tree/`),'branch URL on mapped GitHub host');
  // Compare the actual template renderer on the deployed service, including a linked username.
  const expected=await app(`const {renderBranchName}=await import('/app/src/sync/dev-info.ts');
    const m=(await db.query('SELECT branch_template FROM repo_mappings WHERE id=$1',[${cfg.mappingId}])).rows[0];
    const u=(await db.query('SELECT gh_login FROM user_map WHERE workspace_slug=$1',[${JSON.stringify(cfg.slug)}])).rows[0];
    return renderBranchName(m.branch_template,{key:${JSON.stringify(item.key)},title:${JSON.stringify(item.name)},username:u?.gh_login??null});`);
  eq(repo.branchName,expected,'configured template rendered'); ctx.evidence('Development panel',d);
});
scenario('S29','Create branch from panel is real and idempotent',async ctx=>{
  const item=await fixture(ctx); const offered=(await dev(item)).repos.find(r=>r.mappingId===cfg.mappingId);
  assert(offered?.branchName.toLowerCase().includes(cfg.runId.toLowerCase()),'run-scoped branch');
  const absent=await gh('GET',`repo:/git/ref/heads/${encodeURIComponent(offered.branchName)}`); eq(absent.status,404,'branch initially absent');
  deleteBranch(ctx,offered.branchName);
  const first=await browser('POST',`${devApi(item.id)}/branches`,{mappingId:cfg.mappingId}); eq(first.status,201,'first branch creation'); eq(first.data.created,true,'created');
  eq(first.data.branch,offered.branchName,'offered name used');
  const actual=await gh('GET',`repo:/git/ref/heads/${encodeURIComponent(first.data.branch)}`); eq(actual.status,200,'real branch exists');
  const second=await browser('POST',`${devApi(item.id)}/branches`,{mappingId:cfg.mappingId}); eq(second.status,200,'repeat branch creation'); eq(second.data.created,false,'confirmed existing branch');
  const same=await gh('GET',`repo:/git/ref/heads/${encodeURIComponent(first.data.branch)}`); eq(same.data.object.sha,actual.data.object.sha,'repeat did not move branch');
  ctx.evidence('branch creation',{first:first.data,second:second.data,sha:actual.data.object.sha});
});
scenario('S30','Pushed key branch links item and starts work',async ctx=>{
  const item=await fixture(ctx); const b=await branch(ctx,{key:item.key});
  await delivery('push',b.sha); const current=await stateIs(item,'started','In Progress');
  const panel=await waitFor(async()=>{const d=await dev(item); return d.branches.some(v=>v.text?.includes(b.branch)) && d;},{label:'branch development link'});
  ctx.evidence('branch links and state',{branches:panel.branches,state:stateId(current)});
});
scenario('S31','Draft closing PR starts work with one linkback',async ctx=>{
  const item=await fixture(ctx); const pull=await pr(ctx,{item,draft:true}); await linked(item,pull.number);
  await stateIs(item,'started','In Progress'); await rollup(item,pull.number,'OPEN');
  const rows=await waitFor(async()=>{const c=(await issueComments(pull.number)).filter(c=>c.body?.includes('Linked Plane work item')&&c.body.includes(item.key)); return c.length&&c;},{label:'one PR linkback'});
  await settled(item.id); eq(rows.length,1,'one linkback'); eq((await issueComments(pull.number)).filter(c=>c.body?.includes('Linked Plane work item')&&c.body.includes(item.key)).length,1,'settled linkback count');
  ctx.evidence('draft PR linkback',{id:rows[0].id,body:rows[0].body});
});
scenario('S32','Ready draft then merge completes item and rollup',async ctx=>{
  const item=await fixture(ctx); const pull=await pr(ctx,{item,draft:true}); await linked(item,pull.number); await stateIs(item,'started','In Progress');
  const ready=await app(`const id=await ghClient.installationIdFor(${JSON.stringify(cfg.owner)},${JSON.stringify(cfg.repoName)});
    const client=await installationOctokit(id); const r=await client.request('POST /graphql', {query:'mutation($input:MarkPullRequestReadyForReviewInput!){markPullRequestReadyForReview(input:$input){pullRequest{isDraft number}}}',variables:{input:{pullRequestId:${JSON.stringify(pull.node_id)}}}});
    return {errors:r.data.errors??[],pr:r.data.data?.markPullRequestReadyForReview?.pullRequest};`);
  eq(ready.errors,[],'ready mutation'); eq(ready.pr?.isDraft,false,'PR ready');
  await delivery('pull_request',String(pull.number),{action:'ready_for_review'});
  await waitFor(async()=>{const r=await gh('GET',`repo:/pulls/${pull.number}`); return r.status===200 && r.data.mergeable===true && r.data;},{label:'owned PR mergeable'});
  const merged=await gh('PUT',`repo:/pulls/${pull.number}/merge`,{sha:pull.head.sha,merge_method:'merge',commit_title:name(`Merge ${ctx.id}`)});
  eq(merged.status,200,'merge owned test PR'); eq(merged.data.merged,true,'merged');
  ctx.cleanup(async()=>{const file=await gh('GET',`repo:/contents/${pull.fixtureBranch.path}?ref=${encodeURIComponent(pull.fixtureBranch.base)}`);
    if(file.status===200) {const r=await gh('DELETE',`repo:/contents/${pull.fixtureBranch.path}`,{message:name(`Clean ${ctx.id} fixture`),sha:file.data.sha,branch:pull.fixtureBranch.base});eq(r.status,200,'remove merged fixture file');}else eq(file.status,404,'merged fixture file absent');});
  await stateIs(item,'completed','Done'); const panel=await rollup(item,pull.number,'MERGED'); eq(panel.prStatus,'MERGED','item PR rollup');
  ctx.evidence('merge and completed rollup',{sha:merged.data.sha,status:panel.prStatus});
});
scenario('S33','Closed unmerged PR follows configured lifecycle rule',async ctx=>{
  const item=await fixture(ctx); const existing=await browser('GET',`${mappingApi}/rules`); eq(existing.status,200,'snapshot rules');
  // Scope the first rule to the exact owned head branch so other suite objects are unaffected.
  const yaml=`- name: ${JSON.stringify(name('closed unmerged fixture'))}\n  when: pull_request.closed_unmerged\n  if:\n    head_branch: ${JSON.stringify(`^e2e_${cfg.runId}-s33$`)}\n  then:\n    - set_state: 'cancelled:Cancelled'\n`;
  ctx.cleanup(async()=>{const r=await browser('PUT',`${mappingApi}/rules`,{yaml:existing.data.yaml});eq(r.status,200,'restore rules');});
  const save=await browser('PUT',`${mappingApi}/rules`,{yaml:yaml+existing.data.yaml.replace(/^#.*\n/,'')}); ctx.evidence('scoped rule API',{status:save.status,data:save.data});eq(save.status,200,'save scoped closed rule');
  const pull=await pr(ctx,{item}); await linked(item,pull.number); await stateIs(item,'started','In Progress');
  const closed=await gh('PATCH',`repo:/pulls/${pull.number}`,{state:'closed'});eq(closed.status,200,'close unmerged PR');
  await delivery('pull_request',String(pull.number),{action:'closed'}); await stateIs(item,'cancelled','Cancelled'); const panel=await rollup(item,pull.number,'DECLINED');
  ctx.evidence('closed rule',{version:save.data.version,status:panel.prStatus,state:stateId(await itemNow(item))});
});
scenario('S34','Ref KEY starts work but skips the final merge state',async ctx=>{
  const item=await fixture(ctx); const pull=await pr(ctx,{item,reference:'Ref'}); await linked(item,pull.number);
  await delivery('pull_request',String(pull.number),{action:'opened'});
  const started=await stateIs(item,'started','In Progress');
  await rollup(item,pull.number,'OPEN');await settled(item.id);await settled(String(pull.number));
  await uniquePrTier(item,pull.number,'non_closing');
  eq(stateId(await itemNow(item)),stateId(started),'Ref opening advances to In Progress');
  const merged=await mergeFixturePr(ctx,pull);
  await rollup(item,pull.number,'MERGED');await settled(item.id);await settled(String(pull.number));
  const current=await itemNow(item);const link=await uniquePrTier(item,pull.number,'non_closing');
  eq(stateId(current),stateId(started),'Ref merge preserves In Progress and skips Done');
  assert(item.states.find(s=>s.id===stateId(current))?.group!=='completed','Ref merge must not complete the item');
  ctx.evidence('Ref open and merge semantics',{tier:link.tier,before:item.initialState,opened:stateId(started),merged:stateId(current),delivery:merged});
});
scenario('S35','Skip/ignore suppress linking; Relates to leaves state unchanged on open and merge',async ctx=>{
  for(const word of ['skip','ignore']) {
    const item=await fixture(ctx,`${ctx.id} ${word}`);
    // Distinct branch fixtures within this scenario: context id includes the directive.
    const sub={...ctx,id:`${ctx.id}-${word}`}; const pull=await pr(sub,{item,body:`Fixes ${item.key}\n${word} ${item.key}`});
    await delivery('pull_request',String(pull.number),{action:'opened'}); await settled(item.id);
    eq((await linksForGh(pull.number)).filter(l=>l.plane_issue_id===item.id).length,0,`${word} leaves no sync link`);
    const panel=await dev(item);eq(panel.prs.length,0,`${word} leaves no PR rollup`);eq(stateId(await itemNow(item)),item.initialState,`${word} leaves state`);
    ctx.evidence(`${word} no link`,{number:pull.number,key:item.key});
  }
  const item=await fixture(ctx,`${ctx.id} relation`);const sub={...ctx,id:`${ctx.id}-relation`};
  const pull=await pr(sub,{item,reference:'Relates to'});await linked(item,pull.number);
  await delivery('pull_request',String(pull.number),{action:'opened'});
  await rollup(item,pull.number,'OPEN');await settled(item.id);await settled(String(pull.number));
  await uniquePrTier(item,pull.number,'relation');
  eq(stateId(await itemNow(item)),item.initialState,'Relates to opening leaves state unchanged');
  const merged=await mergeFixturePr(sub,pull);
  await rollup(item,pull.number,'MERGED');await settled(item.id);await settled(String(pull.number));
  const current=await itemNow(item);const link=await uniquePrTier(item,pull.number,'relation');
  eq(stateId(current),item.initialState,'Relates to merge leaves state unchanged');
  ctx.evidence('Relates to open and merge semantics',{number:pull.number,key:item.key,tier:link.tier,before:item.initialState,after:stateId(current),delivery:merged});
});
scenario('S36','Project NEW directive creates exactly one linked item',async ctx=>{
  const pull=await pr(ctx,{title:`Fixes ${cfg.projectKey}-NEW`,body:`Create ${cfg.projectKey}-NEW`});
  // Register discovery cleanup before polling so a late create is still cleaned on assertion failure.
  ctx.cleanup(async()=>{for(const l of await linksForGh(pull.number)) if(l.gh_kind==='pr') {
    const item=await plane('GET',items(l.plane_issue_id)); if(item.status===200 && item.data.name.includes(cfg.runId)) { const r=await plane('DELETE',items(l.plane_issue_id));assert([204,404].includes(r.status),'delete NEW item'); }
  }});
  const rows=await waitFor(async()=>{const r=(await linksForGh(pull.number)).filter(l=>l.gh_kind==='pr'&&l.status==='active');return r.length&&r;},{label:'NEW directive link'});
  eq(rows.length,1,'one NEW item');const r=await plane('GET',items(rows[0].plane_issue_id));eq(r.status,200,'NEW item exists');assert(r.data.name.includes(cfg.runId),'NEW item carries run ID');
  const states=await projectStates();eq(states.find(s=>s.id===stateId(r.data))?.group,'started','NEW item started');
  await delivery('pull_request',String(pull.number),{action:'opened'}); await settled(r.data.id);eq((await linksForGh(pull.number)).filter(l=>l.status==='active').length,1,'settled NEW count');ctx.evidence('NEW item',{id:r.data.id,key:keyOf(r.data)});
});
scenario('S37','User commit status produces CI rollup on linked item',async ctx=>{
  const item=await fixture(ctx);const pull=await pr(ctx,{item}); await linked(item,pull.number);await rollup(item,pull.number,'OPEN');
  const context=`e2e/${cfg.runId}/${ctx.id}`;const r=await gh('POST',`repo:/statuses/${pull.head.sha}`,{state:'success',context,description:name('CI passed'),target_url:pull.html_url});eq(r.status,201,'user commit status created');
  const statusDelivery=await delivery('status',pull.head.sha);await settled(item.id);ctx.evidence('processed user status',{statusId:r.data.id,sha:pull.head.sha,deliveryId:statusDelivery.delivery_id,audit:statusDelivery.id});ctx.evidence('panel after status',await dev(item));
  const panel=await waitFor(async()=>{const d=await dev(item); return d.builds.some(b=>b.text?.includes('pass'))&&d;},{label:'CI pass rollup after observed status delivery',timeout:30000});
  assert(panel.builds.some(b=>b.url.includes(pull.head.sha)||b.url===pull.html_url),'CI links to tested head or status URL');ctx.evidence('CI rollup',{context,sha:pull.head.sha,builds:panel.builds});
});
