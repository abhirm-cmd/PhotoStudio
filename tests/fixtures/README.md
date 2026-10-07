# Test fixtures

The end-to-end test imports every file in this folder together with the generated demo photos in `resources/demo`.
RAW samples are not committed. Put a few RAW files here (any of CR2, CR3, NEF, ARW, RAF, ORF, RW2, PEF, DNG) before running:

    npm run build
    xvfb-run -a node tests/e2e/run.mjs     # or just `node tests/e2e/run.mjs` on a desktop

The test checks that the files are byte-for-byte unchanged afterwards.
