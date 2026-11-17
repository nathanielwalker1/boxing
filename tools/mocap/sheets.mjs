// Stick-figure contact sheets: per clip 8 evenly spaced frames, side view (opponent to the right) and
// front view (as the opponent sees him: his left on screen right). Left limbs orange, right limbs blue.
import { chromium } from 'playwright';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const PER_SHEET = 7, SAMPLES = 8, CW = 92, CH = 150, LABEL_W = 230;

export async function renderSheets(dir, rows, raws) {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (/^sheet_\d+\.png$/.test(f)) unlinkSync(join(dir, f));
  const data = rows.map((r) => {
    const raw = raws[r.slug], n = raw.frames.length;
    const idx = Array.from({ length: SAMPLES }, (_, i) => Math.round((i * (n - 1)) / (SAMPLES - 1)));
    return { slug: r.slug, label: r.label, auto: r.auto, sec: r.stats.seconds, dup: r.dupOf || r.mirrorOf ? (r.dupOf ? 'dup of ' + r.dupOf : 'mirror of ' + r.mirrorOf) : '',
      bones: raw.bones, parents: raw.parents, idx, fps: raw.fps, h0: raw.frames[0].p[0], frames: idx.map((f) => raw.frames[f].p) };
  });
  const browser = await chromium.launch();
  let count = 0;
  for (let s = 0; s < data.length; s += PER_SHEET) {
    const page = await browser.newPage({ viewport: { width: LABEL_W + CW * SAMPLES * 2 + 20, height: 400 } });
    page.on('pageerror', (e) => console.error('sheet page error:', e.message));
    const chunk = data.slice(s, s + PER_SHEET);
    await page.setContent(`<html><body style="margin:0;background:#fff;font:12px monospace"><canvas id=c></canvas><script>
      const D = ${JSON.stringify(chunk)}, CW=${CW}, CH=${CH}, LW=${LABEL_W}, S=${SAMPLES}, K=72;
      const c = document.getElementById('c'); c.width = LW + CW*S*2 + 20; c.height = CH*D.length + 4;
      const g = c.getContext('2d'); g.fillStyle='#fff'; g.fillRect(0,0,c.width,c.height);
      D.forEach((d, row) => {
        const y0 = row*CH;
        g.fillStyle = row%2 ? '#f4f4f4' : '#fff'; g.fillRect(0, y0, c.width, CH);
        g.fillStyle='#000'; g.font='bold 13px monospace'; g.fillText(d.slug, 6, y0+18);
        g.font='12px monospace'; const words = d.label.split(' '); let line='', ly=y0+36;
        for (const w of words) { if ((line+w).length > 28) { g.fillText(line, 6, ly); ly+=15; line=''; } line += w+' '; } g.fillText(line, 6, ly);
        g.fillStyle='#666'; g.fillText(d.sec+' s', 6, ly+16); if (d.dup) g.fillText(d.dup, 6, ly+31);
        if (d.auto !== d.label) { g.fillText('auto: '+d.auto.slice(0,22), 6, ly+46); }
        for (let view=0; view<2; view++) for (let i=0; i<S; i++) {
          const ox = LW + (view*S + i)*CW + (view ? 20 : 0), gy = y0 + CH - 8;
          g.strokeStyle='#ccc'; g.lineWidth=1; g.strokeRect(ox, y0+2, CW, CH-4);
          g.beginPath(); g.moveTo(ox, gy); g.lineTo(ox+CW, gy); g.stroke();
          g.fillStyle='#999'; g.font='10px monospace'; g.fillText((view?'F ':'S ')+'f'+d.idx[i], ox+3, y0+13);
          const P = d.frames[i], hc = P[0];
          const off = view ? hc[0]-d.h0[0] : hc[2]-d.h0[2];
          if (Math.abs(off) > 0.05) g.fillText((off>0?'+':'')+off.toFixed(2)+'m', ox+3, y0+25);
          const X = (p) => ox + CW/2 + (view ? (p[0]-hc[0]) : (p[2]-hc[2])) * K;
          const Y = (p) => gy - p[1]*K;
          g.save(); g.beginPath(); g.rect(ox, y0+2, CW, CH-4); g.clip();
          d.bones.forEach((b, bi) => { const pi = d.parents[bi]; if (pi < 0) return;
            const col = b.startsWith('Left') ? '#e8701a' : b.startsWith('Right') ? '#1a5ee8' : '#333';
            g.strokeStyle = col; g.lineWidth = 2.5; g.beginPath(); g.moveTo(X(P[pi]), Y(P[pi])); g.lineTo(X(P[bi]), Y(P[bi])); g.stroke(); });
          const h = P[d.bones.indexOf('Head')]; g.strokeStyle='#333'; g.lineWidth=2; g.beginPath(); g.arc(X(h), Y(h)-0.09*K, 0.09*K, 0, 7); g.stroke();
          for (const side of ['LeftHand','RightHand']) { const p = P[d.bones.indexOf(side)]; g.fillStyle = side[0]==='L' ? '#e8701a' : '#1a5ee8'; g.beginPath(); g.arc(X(p), Y(p), 4, 0, 7); g.fill(); }
          g.restore();
        }
      });
    </script></body></html>`);
    const el = await page.$('#c');
    count++;
    await el.screenshot({ path: join(dir, `sheet_${String(count).padStart(2, '0')}.png`) });
    await page.close();
  }
  await browser.close();
  return count;
}
