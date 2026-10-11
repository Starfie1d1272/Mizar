import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const root = 'docs/development/evidence/pulse-stage-preview';
await mkdir(root, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const cases = ['playin-10','playin-00','bo3','semifinal','third-place','grand-final','long','unknown','local-missing','swiss-11','direct-bo3','upper-semifinal','lower-final','ranking'];
const report = [];
for (const name of cases) {
  await page.goto(`http://127.0.0.1:4197/__visual/program/default-stage-${name}`);
  await page.locator('[data-gameplay-hud]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(async () => {
    await Promise.allSettled([...document.images].map(i => i.decode()));
    const video = document.createElement('video');
    video.src = '/fixtures/epl-inferno-video/replay/background.mp4';
    video.muted = true;
    video.style.cssText = 'position:absolute;inset:0;width:1920px;height:1080px;object-fit:cover;z-index:-1';
    document.querySelector('[data-program-canvas]').prepend(video);
    await new Promise((resolve, reject) => { video.addEventListener('loadeddata', resolve, {once:true}); video.addEventListener('error', reject, {once:true}); });
    video.currentTime = 8;
    await new Promise(resolve => video.addEventListener('seeked', resolve, {once:true}));
    video.pause();
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const geometry = await page.evaluate(() => {
    const box = node => { const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
    const caption = document.querySelector('.match-header__stage-caption');
    const shell = document.querySelector('.match-header__score-shell');
    const names = [...document.querySelectorAll('.match-header__team-name')];
    const pips = [...document.querySelectorAll('.match-header__win-slots')];
    return { caption:caption ? {text:caption.textContent, box:box(caption), clipped:caption.scrollWidth>caption.clientWidth} : null, shell:box(shell), names:names.map(n=>({text:n.textContent, box:box(n)})), pips:pips.map(box), duplicateCaptions:document.querySelectorAll('.match-header__stage-caption').length };
  });
  if (name==='local-missing' ? geometry.caption!==null : geometry.duplicateCaptions!==1) throw new Error(`caption count ${name}`);
  if (geometry.caption && (Math.abs(geometry.caption.box.x+geometry.caption.box.width/2-960)>1 || geometry.caption.box.y<0 || geometry.caption.box.bottom>=geometry.shell.y)) throw new Error(`stage placement ${name}`);
  const gaps=geometry.pips.length===2 ? [geometry.pips[0].x-geometry.names[0].box.right,geometry.names[1].box.x-geometry.pips[1].right] : [];
  if(gaps.some(g=>g<8))throw new Error(`name/pip gap ${name}: ${gaps}`);
  await page.screenshot({path:`${root}/${name}-full.png`});
  await page.screenshot({path:`${root}/${name}-score.png`,clip:{x:520,y:0,width:880,height:160}});
  report.push({name,...geometry,gaps});
}
if(errors.length)throw new Error(errors.join('\n'));
await writeFile(`${root}/geometry.json`,JSON.stringify({viewport:{width:1920,height:1080},provenance:'Explicit synthetic stage/record presentation over a paused repository Inferno video; not a live website/Windows/OBS capture.',cases:report},null,2)+'\n');
await browser.close();
console.log(JSON.stringify(report.map(r=>({name:r.name,text:r.caption?.text,clipped:r.caption?.clipped,gaps:r.gaps})),null,2));
