import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--host-resolver-rules=MAP plane.example.com:80 127.0.0.1:3199'] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: 'session-id', value: 'admin', domain: 'plane.example.com', path: '/' }, { name: 'admin-session-id', value: 'god', domain: 'plane.example.com', path: '/' }]);
const p = await ctx.newPage();
await p.goto('http://plane.example.com' + process.argv[2], { waitUntil: 'networkidle' }); await p.waitForTimeout(800);
const html = await p.evaluate(() => document.querySelector('main').outerHTML.replace(/<option[^>]*>[^<]*<\/option>/g, (m) => m.length > 80 ? m.slice(0, 80) : m));
console.log(html.replace(/></g, '>\n<').split('\n').filter(l => /<(h[1-4]|label|select|textarea|button|input|table|th|section|pre|fieldset|legend)/.test(l)).slice(0, Number(process.argv[3] || 80)).join('\n'));
await b.close();
