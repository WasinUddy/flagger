# Flagger

Flagger is a local-first FLAC metadata tagger for vinyl rips. It searches the
Discogs catalog, lets the listener choose the exact pressing, maps local FLAC
files to the release track list, embeds user-supplied artwork, and exports
DAP-friendly files.

The audio never leaves the browser. Flagger rewrites the native FLAC metadata
prefix and joins it to the original audio-frame Blob slice, so the encoded audio
bytes are not decoded or re-encoded.

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

## Validate

```bash
npm test
npm run lint
npx tsc --noEmit
```

The tests cover server rendering, FLAC STREAMINFO parsing, Vorbis comment and
PICTURE writing, preservation of existing unrelated tags and audio-frame bytes,
and the store-only album ZIP writer.

Album ZIPs use the store method because FLAC audio is already compressed.

## Privacy and Discogs

- FLAC files and uploaded cover artwork stay in the browser.
- Discogs receives catalog searches only.
- Discogs artwork is preview-only; users provide the image embedded in their files.
- A personal Discogs token is optional and remains in memory for the tab session.

Flagger uses Discogs’ API but is not affiliated with, sponsored or endorsed by
Discogs. “Discogs” is a trademark of Zink Media, LLC.
