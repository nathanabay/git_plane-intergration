// Context7 /websites/github_en_rest: PR discussion /issues/{number}/comments,
// commit /commits/{sha}/comments, App redelivery. Reports are recognized by the source's stable marker.
import {cfg, gh, sql, waitFor, scenario, name, assert, eq, pr, branch, delivery,
  settled, issueComments, ghAll, mappingSetting, auditMark} from './04-dev.mjs';
import {smartAudit,smartFixture} from './05-smartcommit.mjs';
const reports=(rows)=>rows.filter(c=>c.user?.type==='Bot'&&c.body?.includes('<!-- git-sync-problem:'));
export async function enableReports(ctx, enabled=true) { await mappingSetting(ctx,'reportProblems',enabled,{defect:'E2E-1'}); }
const unknown=(offset=0)=>`${cfg.projectKey}-${900000000+parseInt(cfg.runId.replace(/[^a-f0-9]/gi,'').slice(-6),16)+offset}`;
async function reportPr(ctx) {
  await enableReports(ctx);const key=unknown();const pull=await pr(ctx,{title:`Fixes ${key}`,body:name('Unknown key report fixture')});
  const found=await waitFor(async()=>{const r=reports(await issueComments(pull.number));return r.length&&r;},{label:'PR unknown-key report'});
  await delivery('pull_request',String(pull.number),{action:'opened'});await settled(String(pull.number));
  eq(found.length,1,'one unknown-key report');assert(found[0].body.includes(key),'report names unknown key');assert(!found[0].body.includes(`E2E-${cfg.runId.split('-')[0]}`),'fixture branch creates no unrelated key diagnostic');return {pull,key,report:found[0]};
}
scenario('S42','Unknown PR key posts one bot problem report',async ctx=>{
  const {pull,key,report}=await reportPr(ctx);eq(reports(await issueComments(pull.number)).length,1,'settled report count');ctx.evidence('PR problem report',{id:report.id,key,body:report.body});
},{needs:['reportProblems API']});
scenario('S43','Bad Smart Commit posts one commit problem report',async ctx=>{
  await enableReports(ctx);const command=`nosuchstate-${cfg.runId}`;const {item,b}=await smartFixture(ctx,`#${command}`);const key=item.key;
  const failed=await smartAudit(b.sha,{kind:'smart_commit_failed',outcome:'failed'});assert(failed.error?.includes('matches no state'),'actual unknown transition was rejected');
  const found=await waitFor(async()=>{const r=reports(await ghAll(`repo:/commits/${b.sha}/comments`));return r.length&&r;},{label:'commit problem report'});
  await delivery('push',b.sha);await settled(b.sha);eq(found.length,1,'one commit report');assert(found[0].body.includes(key),'commit report names rejected key');assert(found[0].body.includes(command),'commit report names rejected transition');
  eq(reports(await ghAll(`repo:/commits/${b.sha}/comments`)).length,1,'settled commit report count');ctx.evidence('commit report',{id:found[0].id,sha:b.sha,body:found[0].body});
},{needs:['reportProblems API']});
scenario('S44','Changed PR problem report is edited in place',async ctx=>{
  const {pull,key,report}=await reportPr(ctx);const next=unknown(1);const mark=await auditMark();
  const edit=await gh('PATCH',`repo:/pulls/${pull.number}`,{title:name(`Fixes ${next}`)});eq(edit.status,200,'edit owned PR key');
  await delivery('pull_request',String(pull.number),{action:'edited',after:mark});
  const updated=await waitFor(async()=>{const rows=reports(await issueComments(pull.number));return rows.some(c=>c.body.includes(next))&&rows;},{label:'report updated with new unknown key'});
  await settled(String(pull.number));eq(updated.length,1,'no duplicate problem report');eq(updated[0].id,report.id,'same comment updated');assert(updated[0].body!==report.body,'report body actually changed');assert(!updated[0].body.includes(key),'old diagnostic replaced');
  eq(reports(await issueComments(pull.number)).length,1,'settled edited report count');ctx.evidence('report edited',{id:report.id,before:key,after:next,body:updated[0].body});
},{needs:['reportProblems API']});
scenario('S45','Reports disabled suppress both PR and commit notices',async ctx=>{
  await enableReports(ctx,false);const key=unknown();const pull=await pr(ctx,{title:`Fixes ${key}`});
  await delivery('pull_request',String(pull.number),{action:'opened'});await settled(String(pull.number));
  const b=await branch({...ctx,id:`${ctx.id}-commit`},{message:name(`${key} #nosuchstate-${cfg.runId}`)});
  const audit=await smartAudit(b.sha,{kind:'smart_commit_failed',outcome:'failed'});await delivery('push',b.sha);await settled(b.sha);
  eq(reports(await issueComments(pull.number)).length,0,'no PR notice after processed invalid reference');
  eq(reports(await ghAll(`repo:/commits/${b.sha}/comments`)).length,0,'no commit notice after audited rejection');
  const intents=await sql(`SELECT id FROM outbound_writes WHERE workspace_slug=$1 AND write->>'kind'='problem_report' AND (write->'target'->>'sha'=$2 OR write->'target'->>'number'=$3)`,[cfg.slug,b.sha,String(pull.number)]);eq(intents.length,0,'opt-out does not register notices');
  ctx.evidence('report opt-out',{pr:pull.number,sha:b.sha,rejectionAudit:audit.id});
},{needs:['reportProblems API']});
