/**
 * greyscale.js — VISUALS.md validation-protocol step 4, "the value check".
 *
 * The rule at the top of the ladder is that a fighter must read as a distinct
 * shape against the floor WHEN THE FRAME IS DESATURATED. Until this file existed
 * that step was done by eye, which meant in practice it was not done at all.
 *
 * Deliberately not a capture harness: it takes a PNG that some other script
 * already wrote and drops a `_grey` sibling next to it. Anything that captures
 * (verify.js, pose_grid.mjs, an ad-hoc _debug.mjs run) gets the value check by
 * adding one line, and nothing has to learn a second way to take a screenshot.
 *
 * The conversion is LINEAR-LIGHT Rec.709 luminance — sRGB decode, weight, sRGB
 * re-encode — not the naive 0.299/0.587/0.114 over gamma-encoded bytes. That
 * matters here specifically: the naive version overstates the brightness of
 * saturated mid-tones, which is exactly the mistake ("but it's a different
 * COLOUR") this check exists to catch. The values it produces line up with the
 * contrast ratios quoted in VISUALS.md, so a pixel read off a grey capture and a
 * ratio computed from config are talking about the same quantity.
 */
import { readFileSync, writeFileSync } from 'fs';

/** `foo.png` → `foo_grey.png`. */
export function greyPath(src) {
  return src.replace(/(\.png)$/i, '_grey$1');
}

/**
 * Write a desaturated copy of a PNG.
 *
 * @param {import('playwright').Page} page  any live page — used only as a host
 *        for a 2D canvas, the same way pose_grid.mjs assembles its contact
 *        sheets. Keeps the suite dependency-free (no image library).
 * @param {string} src  path to the colour PNG
 * @param {string} [dst]  defaults to greyPath(src)
 * @returns {Promise<string>} the path written
 */
export async function greyscaleCopy(page, src, dst = greyPath(src)) {
  const url = 'data:image/png;base64,' + readFileSync(src).toString('base64');

  const out = await page.evaluate(async (dataUrl) => {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload  = () => res(im);
      im.onerror = () => rej(new Error('greyscale: image decode failed'));
      im.src = dataUrl;
    });

    const canvas = document.createElement('canvas');
    canvas.width  = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);

    const px = g.getImageData(0, 0, canvas.width, canvas.height);
    const d  = px.data;

    // sRGB byte → linear, and back. 256-entry LUTs: the inverse is the
    // expensive half and it is called once per pixel, so it is worth the table.
    const toLin = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const c = i / 255;
      toLin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    const toSrgb = (v) => {
      const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
      return Math.max(0, Math.min(255, Math.round(c * 255)));
    };

    for (let i = 0; i < d.length; i += 4) {
      const y = toSrgb(0.2126 * toLin[d[i]] + 0.7152 * toLin[d[i + 1]] + 0.0722 * toLin[d[i + 2]]);
      d[i] = d[i + 1] = d[i + 2] = y;   // alpha untouched
    }
    g.putImageData(px, 0, 0);
    return canvas.toDataURL('image/png');
  }, url);

  writeFileSync(dst, Buffer.from(out.split(',')[1], 'base64'));
  return dst;
}
