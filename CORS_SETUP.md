# Firebase Storage CORS — one-time setup

**Why:** features that read pixel data from the floor plan image
(Fit-to-walls, Auto-detect rooms) need CORS headers from Firebase Storage.
Without them, the browser blocks `getImageData()` with the error
"The canvas has been tainted by cross-origin data."

**One-time fix.** After running this once, every Firebase Storage upload
serves the right headers for canvas access. New uploads work
automatically — no app code changes needed.

## Steps

1. Install Google Cloud SDK if you don't have it:
   ```bash
   brew install --cask google-cloud-sdk
   ```

2. Authenticate (the same Google account that owns the Firebase project):
   ```bash
   gcloud auth login
   ```

3. Apply the CORS config (file `cors.json` in this folder):
   ```bash
   cd "/Users/diskc/Documents/Claude/Projects/Office map"
   gsutil cors set cors.json gs://suitesforall.firebasestorage.app
   ```

4. Verify:
   ```bash
   gsutil cors get gs://suitesforall.firebasestorage.app
   ```
   Should print the same JSON.

5. Refresh your browser (Cmd+Shift+R) and try Fit-to-walls again. Should work.

## What `cors.json` allows

```json
[
  {
    "origin": ["https://suitesforall.web.app", ...],
    "method": ["GET"],
    "maxAgeSeconds": 3600,
    "responseHeader": ["Content-Type", "Access-Control-Allow-Origin"]
  }
]
```

- `origin` — only your domains (locked down, not `["*"]`)
- `method` — GET only (uploads are not CORS — they go through Firebase SDK)
- `maxAgeSeconds` — preflight cache 1 hour (cuts roundtrips)
- `responseHeader` — what the browser sees back

## If you don't want to run gsutil

Alternative workaround in-app: re-upload the floor plan image. During upload
the file is accessible same-origin (via FileReader as data URL) BEFORE
hitting Firebase. You can cache the data URL in `floor.bg.dataUrl` and
have fit-to-walls use that instead of the Firebase URL.

This requires adding ~15 lines to the upload flow and ~3 lines to
`_loadImageForPixelAccess`. Tell Claude "use the dataUrl cache approach"
if you'd rather not touch CORS.
