# Bill Generator

A 100% static, vanilla web app (no framework, no build step, no backend, no npm)
for a small shopkeeper. It produces **realistic handwritten cash memos** and
**clean computerized bills**, prints to one page (A5/A4), saves as PDF/PNG, and
works fully offline after the fonts are bundled.

## Run it

1. Double-click `index.html` (opens in Chrome or Edge). That's it — no install,
   no server, no internet needed once the fonts are present.
2. Fill in shop info (saved automatically), bill number/date/customer, line
   items, optional discount and tax %. The live preview updates as you type.
3. Toggle **Handwritten** / **Computerized** in the toolbar.
4. **Print** (or Ctrl+P) prints only the bill on one page. In the print dialog
   choose a printer, or **Save as PDF** to get a PDF file.
5. **Re-roll look** regenerates the handwriting (new seed) so you can pick a look
   you like. **New** starts a fresh bill (auto-increments the bill number when
   that option is on). **Save PNG** exports an image of the current bill.

Everything (shop info, settings, and the in-progress bill) is saved in your
browser's `localStorage`, so it is restored on reload. No data leaves your
machine.

## Fonts (bundled, offline)

The handwriting fonts are bundled under `assets/fonts/` and loaded via
`@font-face`, so the app works offline. They come from the
[google/fonts](https://github.com/google/fonts) repo:

| Font | License | Local file |
|---|---|---|
| Patrick Hand (primary) | SIL Open Font License 1.1 | `PatrickHand-Regular.ttf` |
| Caveat | SIL Open Font License 1.1 | `Caveat-wght.ttf` |
| Kalam | SIL Open Font License 1.1 | `Kalam-Regular.ttf` |
| Indie Flower | SIL Open Font License 1.1 | `IndieFlower-Regular.ttf` |
| Gaegu | SIL Open Font License 1.1 | `Gaegu-Regular.ttf` |
| Shadows Into Light | SIL Open Font License 1.1 | `ShadowsIntoLight.ttf` |
| Homemade Apple | Apache License 2.0 | `HomemadeApple-Regular.ttf` |
| Just Another Hand | Apache License 2.0 | `JustAnotherHand-Regular.ttf` |

Full license texts are bundled next to the fonts: `assets/fonts/OFL.txt`
(SIL Open Font License 1.1) and `assets/fonts/Apache-2.0.txt` (Apache 2.0).
The two Apache-licensed fonts are freely redistributable under those terms.

### Re-downloading fonts (optional)

The fonts are already bundled. If you ever need to fetch them again, run from
PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File "d:\bill generator\assets\fonts\download-fonts.ps1"
```

The script downloads from `raw.githubusercontent.com/google/fonts` and tolerates
per-file failures. Note: `Caveat[wght].ttf` is saved locally as
`Caveat-wght.ttf` because square brackets in filenames break
`Invoke-WebRequest -OutFile`; the `@font-face` rule references the local name.

If a font file is missing, the app automatically inserts a Google Fonts `<link>`
fallback and shows a small notice: you need internet that one time to load the
handwriting fonts; afterwards it works offline again.

## How the "handwritten" look works

Handwriting is rendered as an inline SVG where **every character is placed
independently** with a seeded random rotation, x/y offset, scale, ink
opacity, ink colour (dark-blue / blue-black / blue), and occasional font
substitution. The seed is stored per bill (`renderSeed`), so the same bill
renders identically after a reload, while different bills (or a re-roll) look
different. The paper has a subtle cream tint, faint ruled lines and grain
(via SVG `feTurbulence`), a slight tilt, a faux "PAID" rubber stamp, and a
signature scribble.

## File layout

```
index.html            entry page
css/styles.css        all styling: @font-face, layout, print CSS
js/app.js             form logic, totals, amount-in-words, persistence, print
js/handwriting.js     realistic-handwriting renderer (per-char SVG + seeded PRNG)
assets/fonts/         bundled OFL + Apache fonts + license texts + fetch script
```

## Notes / limitations

- Currency is Indian Rupees (INR); amount-in-words uses Indian numbering
  (crore / lakh / thousand) with paise.
- Discount is a flat amount (not a percentage).
- "Save PNG" is a best-effort export. Custom handwriting fonts may be
  substituted by a system font in the PNG image (a browser limitation of
  SVG-to-canvas rasterization); the on-screen and printed/PDF bill always use
  the real bundled fonts.
- Browsers: current Chrome and Edge on Windows.
