# PhotoStudio Pro

**Video editor in the PhotoStudio family** — multi-track editing like Premiere Pro, a color page and mixer like DaVinci Resolve, and FFmpeg rendering. Electron + React + TypeScript + WebGL2.

**Everything runs on your computer.** Media is never uploaded and never modified: projects only reference your files, and exports always write a new file (PhotoStudio Pro refuses to render over a source file).

## Pages

| Page | What it does |
| --- | --- |
| Media | Import files or folders (drag and drop too), thumbnail/list bin with search, clip info (codec, frame rate, color space, rotation), source monitor with in/out marks, relink offline media. |
| Edit | Source and program monitors over a multi-track timeline (video tracks stack bottom-up, audio tracks below). Insert and overwrite edits from the source monitor, drag from the bin, filmstrips and waveforms on clips, move across tracks, trim (ripple with Ctrl/⌘ or the ripple toggle), razor, split at playhead, ripple delete, close gap, snapping, marquee select, linked audio/video (Alt to act on one side), copy/paste, markers, in/out range, zoom. Inspector for position, scale, rotation, crop, flip, opacity, speed (10–400 %, pitch-preserving), fades, transitions (cross dissolve, dip to black, slide), titles and color mattes. Drag the selected clip's picture directly in the program monitor. |
| Color | Clip strip, lift/gamma/gain/offset color wheels with master rollers, exposure, temperature, tint, contrast with pivot, saturation, Y/R/G/B curves, .cube LUT import with strength, bypass, copy/paste grade. Waveform, RGB parade, vectorscope (with 75 % targets and skin line) and histogram scopes. |
| Audio | Mixer with a fader, balance, mute/solo and peak meter per track plus a master meter, over the timeline. Clip volume and fades in the inspector. |
| Deliver | H.264, H.265, ProRes 422 HQ, WAV, MP3 or AAC; sequence size or scaled; quality and bitrate; whole timeline or in/out range; render queue with progress, ETA, speed and cancel; shows the exact FFmpeg command. |

Projects (`.psproj`, JSON) save atomically with a `.bak` copy, autosave every 20 seconds and offer recovery after a crash. Closing or opening another project with unsaved changes asks first. Formats the built-in player can't decode (ProRes, HEVC, DNxHD, MXF…) get a 720p H.264 preview proxy automatically; export always reads the original.

### Match Edit

**Match Edit** (Edit page, timeline toolbar) uses a video you've already edited as a template. Pick the reference and your new footage, and it rebuilds the same edit on the timeline:

- Every cut lands on the same frame as in the reference, so shot lengths match exactly.
- Dissolves (with their length), dips to black, and the fade in and fade out are copied.
- Zoom-in, zoom-out and pan moves within a shot are measured and replayed as animated crops on the new clip.
- The reference's look (exposure, contrast, saturation, white balance, black level) can be matched as a grade.
- The reference's soundtrack can be used, so cuts stay on the beat. You can also keep the footage's own sound, use both, or use none.

Shots are dealt to your clips in the order you tick them and spread through each clip. Everything it creates is ordinary clip settings you can change, and the whole build is one undo step.

Analysis runs on this computer with FFmpeg. Nothing is uploaded. Speed changes in the reference can't be told apart from normal footage, so clips play at 100 %.

### Preview equals export

The program monitor and the exporter share one description of the timeline (`src/shared/timeline.ts`): which clips are visible at each frame, transition and fade ramps, picture placement and the color grade, which is baked into a 33³ 3D LUT used as a GPU texture in the preview and by FFmpeg's `lut3d` on export. The end-to-end test compares preview and rendered frames.

## Development

    cd pro
    npm install          # FFmpeg/FFprobe binaries; the rest is shared with the repository root
    npm run media        # generate the test footage in tests/media
    npm run dev          # Vite + Electron with reload
    npm run build && npm start
    npm run typecheck
    npm test             # unit tests (timeline, grading, real FFmpeg exports)
    npm run build && xvfb-run -a npm run test:e2e

Keyboard shortcuts are listed in the app (Ctrl/⌘ + /): Space, J/K/L, I/O, `,` insert, `.` overwrite, V/C tools, Ctrl/⌘+K split, Shift+Delete ripple delete and more.

## Known limits

- No keyframes yet: transforms, opacity and grades are constant per clip. Fades, transitions and Match Edit zoom/pan moves animate.
- Reverse shuttle (J) steps frame by frame rather than playing smoothly.
- Grades are primary corrections per clip; there are no power windows or node graphs.
- Titles are single text blocks (font, size, weight, color, alignment, position, box, shadow).

## License note

FFmpeg is bundled through `ffmpeg-static`, a GPL build that includes libx264 and libx265. Distributing PhotoStudio Pro builds means complying with the GPL for that binary.
