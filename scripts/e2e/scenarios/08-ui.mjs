// Browser control comes from G3's web() contract. These checks read only run-scoped test pages.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {cfg, web, scenario, eq, assert, fixture, dev} from './04-dev.mjs';
async function screenshot(ctx,path,texts,{admin=false}={}) {
  const file=join(cfg.outDir,cfg.runId,`${ctx.id.toLowerCase()}.png`);
  const [r]=await web([['SCREENSHOT',path,undefined,{file,expectText:texts,textWaitMs:45000}]],{admin});
  ctx.evidence('screenshot',file);ctx.evidence('rendered DOM',{status:r.status,found:r.found,frames:r.frames,finalUrl:r.finalUrl,error:r.error});
  eq(r.status,200,'browser page loads');assert(existsSync(file),'screenshot artifact written');
  for(const text of texts)eq(r.found?.[text],true,`rendered text ${text}`);
  return r;
}
scenario('S50','God-mode GitHub Sync page and sidebar render',async ctx=>{
  const r=await screenshot(ctx,'/god-mode/git-sync/',['GitHub Sync','GitHub App','Workspace GitHub App installations'],{admin:true});
  assert(r.finalUrl?.endsWith('/god-mode/git-sync/')||r.finalUrl?.endsWith('/god-mode/git-sync'),'God-mode stays on requested page');
  const frame=r.frames?.find(f=>f.title==='GitHub Sync Admin Configuration');assert(frame,'admin configuration iframe attached');assert(frame.src.includes('/git-sync/ui/admin'),'correct admin iframe');assert(frame.height>=frame.viewportHeight-100,'admin iframe fills dashboard');
},{needs:['headless browser','iframe geometry'],timeout:360000});
scenario('S51','Workspace GitHub Sync settings render at full height',async ctx=>{
  const r=await screenshot(ctx,`/${cfg.slug}/settings/git-sync/`,['GitHub Sync','Repositories',cfg.repo]);
  const frame=r.frames?.find(f=>f.title==='GitHub Sync Workspace Configuration');assert(frame,'workspace settings iframe attached');
  assert(frame.src.endsWith(`/git-sync/ui/workspaces/${cfg.slug}`),'iframe scoped to test workspace');assert(frame.width>500,'settings app usable width');
  assert(frame.height>=frame.viewportHeight-150,`settings iframe full height: ${frame.height} of ${frame.viewportHeight}`);
  assert(frame.height<=frame.viewportHeight+20,'iframe does not exceed viewport');ctx.evidence('full-height iframe',frame);
},{needs:['headless browser','iframe geometry'],timeout:360000});
scenario('S52','Development panel renders inside work-item sidebar',async ctx=>{
  const item=await fixture(ctx);const panel=await dev(item);eq(panel.key,item.key,'Development positive API control');
  const r=await screenshot(ctx,`/${cfg.slug}/projects/${cfg.projectId}/issues/${item.id}/`,[item.key,'Development','Start work',cfg.repo,'Create branch']);
  const frame=r.frames?.find(f=>f.title==='Development');assert(frame,'Development iframe attached to item');
  assert(frame.src.includes(`/work-items/${item.id}/development`),'Development scoped to run-owned item');assert(frame.height>=200,'Development panel is visible');
  ctx.evidence('work-item Development',{key:item.key,frame});
},{needs:['headless browser','iframe geometry'],timeout:360000});
