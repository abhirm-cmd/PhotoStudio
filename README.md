# PhotoStudio

**Alternative for Lightroom**

A desktop RAW photo manager and non-destructive editor (Electron + React + TypeScript + WebGL2 + SQLite).

**Everything runs on your computer.** Photos are never uploaded, originals are never modified, and every edit is stored as settings in the catalog with full history.

## What works

| Area | Status |
| --- | --- |
| Import | Files or folders (recursive), add in place or copy, duplicate detection, keywords and a preset on import. RAW (CR2, CR3, NEF, ARW, RAF, ORF, RW2, PEF, DNG) via LibRaw (WebAssembly), plus JPEG, PNG, TIFF, WebP and HEIC. |
| Library | SQLite catalog, virtualized grid, loupe, survey, filmstrip, ratings, flags, color labels, favorites, keywords, IPTC, EXIF panel, folders, collections, smart collections, natural-language search ("5 star portraits shot at 85mm"), virtual copies. |
| Develop | GPU pipeline in linear Rec. 2020: white balance (Kelvin + tint, picker), profiles, exposure/contrast/highlights/shadows/whites/blacks, texture, clarity, dehaze, vibrance, saturation, parametric and point tone curves (RGB + channels), HSL mixer with targeted adjustment, 3-way color grading, calibration, sharpening, noise reduction, lens corrections (Lensfun import), Upright and guided transform, crop and straighten, vignette and grain, portrait tools, history, snapshots, before/after. |
| Masking | Up to 12 masks, each combining components with add/subtract/intersect: brush, linear, radial, color range, luminance range, and on-device subject, sky, background, people, object, skin, eyes, teeth detection. All local adjustments per mask. |
| Presets | ~30 built-in presets in 10 folders, live preview thumbnails, hover preview, amount 0–200 %, favorites, import/export, apply to many photos. |
| Reference Grade | Drop in a reference image (or pick a catalog photo). PhotoStudio measures its tone and color, fits ordinary editable settings to your photo in a closed loop, and shows Reference / Original / Result. Color Only or Full Grade, Strength 0–150 %, apply, save as preset. |
| AI | Auto Enhance, scene tagging and mask detection run locally (heuristics today; the provider interface accepts ONNX models). |
| Export | Tiled full-resolution GPU render to JPEG, PNG, TIFF (8/16-bit) and linear DNG, resize modes, sRGB / Display P3 / Adobe RGB / ProPhoto with embedded ICC, output sharpening, metadata control, filename templates, watermark, export presets. |
| Safety | Automatic catalog backups and restore, originals checked by hash in the end-to-end test, nothing is deleted without confirmation. |

## Development

    npm install
    npm run dev          # Vite + Electron with reload
    npm run build && npm start
    npm run typecheck
    npm test             # unit tests
    npm run demo         # regenerate the demo photos in resources/demo
    npm run test:e2e     # drives the built app end to end (see tests/fixtures/README.md)
    npm run dist         # installers via electron-builder

## Known limits

- Zooming past the 2560 px preview upsamples instead of re-rendering a full-resolution tile.
- AI masks use on-device heuristics until a segmentation model is plugged into `registerMaskProvider`.
- Eye and teeth detection need Chromium's FaceDetector (enabled by the app at start-up); without it those targets report that no face was found.
