"use client";

import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  firstComment,
  inspectFlac,
  rewriteFlac,
  type FlacPicture,
  type FlacTags,
} from "@/lib/flac";
import { compareDapOrder, dapOrderingTags, dapOutputFileName } from "@/lib/dap";
import { createStoredZip } from "@/lib/zip";

type DiscogsArtist = {
  name: string;
  anv?: string;
  join?: string;
};

type DiscogsTrack = {
  position?: string;
  type_: string;
  title: string;
  duration?: string;
  artists?: DiscogsArtist[];
  sub_tracks?: DiscogsTrack[];
};

type DiscogsSearchResult = {
  id: number;
  title: string;
  year?: string | number;
  country?: string;
  format?: string[];
  label?: string[];
  catno?: string;
  thumb?: string;
  cover_image?: string;
  uri?: string;
};

type DiscogsRelease = {
  id: number;
  title: string;
  artists_sort?: string;
  artists?: DiscogsArtist[];
  year?: number;
  released?: string;
  country?: string;
  genres?: string[];
  styles?: string[];
  labels?: Array<{ name: string; catno?: string }>;
  formats?: Array<{ name: string; qty?: string; descriptions?: string[] }>;
  identifiers?: Array<{ type: string; value: string }>;
  tracklist?: DiscogsTrack[];
  images?: Array<{
    type: "primary" | "secondary";
    uri: string;
    uri150?: string;
    width?: number;
    height?: number;
  }>;
  uri?: string;
};

type ReleaseTrack = {
  title: string;
  artist: string;
  position: string;
  duration: string;
  discNumber: number;
  trackNumber: number;
  trackTotal: number;
};

type LocalFlac = {
  id: string;
  file: File;
  status: "reading" | "ready" | "error";
  error?: string;
  existingTitle?: string;
  durationSeconds?: number | null;
  sampleRate?: number;
  bitsPerSample?: number;
  assignment: number | null;
  titleOverride?: string;
};

type CoverAsset = {
  blob: Blob;
  previewUrl: string;
  width: number;
  height: number;
};

type AlbumEdits = {
  artist: string;
  album: string;
  year: string;
  genres: string;
  label: string;
  catalogNumber: string;
  country: string;
};

type TaggedOutput = {
  id: string;
  name: string;
  blob: Blob;
  title: string;
  discNumber: number;
  trackNumber: number;
};

const EMPTY_ALBUM: AlbumEdits = {
  artist: "",
  album: "",
  year: "",
  genres: "",
  label: "",
  catalogNumber: "",
  country: "",
};

const DISCogs_API = "https://api.discogs.com";

export default function FlaggerApp() {
  const [query, setQuery] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [searchResults, setSearchResults] = useState<DiscogsSearchResult[]>([]);
  const [searchState, setSearchState] = useState<
    "idle" | "searching" | "done" | "error"
  >("idle");
  const [searchMessage, setSearchMessage] = useState("");
  const [loadingReleaseId, setLoadingReleaseId] = useState<number | null>(null);
  const [release, setRelease] = useState<DiscogsRelease | null>(null);
  const [albumEdits, setAlbumEdits] = useState<AlbumEdits>(EMPTY_ALBUM);
  const [localFiles, setLocalFiles] = useState<LocalFlac[]>([]);
  const [isReadingFiles, setIsReadingFiles] = useState(false);
  const [cover, setCover] = useState<CoverAsset | null>(null);
  const [coverError, setCoverError] = useState("");
  const [isPreparingCover, setIsPreparingCover] = useState(false);
  const [outputs, setOutputs] = useState<TaggedOutput[]>([]);
  const [exportState, setExportState] = useState<
    "idle" | "working" | "ready" | "error"
  >("idle");
  const [exportMessage, setExportMessage] = useState("");
  const [isZipping, setIsZipping] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const releaseRequestRef = useRef(0);

  const releaseTracks = useMemo(
    () => (release ? flattenTracklist(release.tracklist ?? [], albumEdits.artist) : []),
    [release, albumEdits.artist],
  );
  const primaryImage = useMemo(
    () =>
      release?.images?.find((image) => image.type === "primary") ??
      release?.images?.[0] ??
      null,
    [release],
  );
  const readyFiles = useMemo(
    () => localFiles.filter((item) => item.status === "ready"),
    [localFiles],
  );
  const assignedTracks = readyFiles
    .map((item) => item.assignment)
    .filter((value): value is number => value !== null);
  const assignmentsComplete =
    readyFiles.length > 0 && assignedTracks.length === readyFiles.length;
  const assignmentsUnique = new Set(assignedTracks).size === assignedTracks.length;
  const canExport = Boolean(
    release &&
      cover &&
      readyFiles.length > 0 &&
      assignmentsComplete &&
      assignmentsUnique &&
      exportState !== "working",
  );
  const discTotal = Math.max(1, ...releaseTracks.map((track) => track.discNumber));

  async function runSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;

    setSearchState("searching");
    setSearchMessage("");
    setSearchResults([]);
    const directId = releaseIdFromInput(trimmed);

    try {
      if (directId) {
        await chooseRelease(directId);
        return;
      }

      const params = new URLSearchParams({
        q: trimmed,
        type: "release",
        per_page: "12",
      });
      const response = await discogsFetch<{ results?: DiscogsSearchResult[] }>(
        `/database/search?${params.toString()}`,
        token,
      );
      const results = response.results ?? [];
      setSearchResults(results);
      setSearchState("done");
      setSearchMessage(
        results.length
          ? `${results.length} pressings found. Choose the exact label and catalog number.`
          : "No pressings found. Try the catalog number or a Discogs release URL.",
      );
    } catch (error) {
      setSearchState("error");
      setSearchMessage(discogsErrorMessage(error));
    }
  }

  async function chooseRelease(id: number) {
    const requestId = releaseRequestRef.current + 1;
    releaseRequestRef.current = requestId;
    setLoadingReleaseId(id);
    setSearchMessage("");
    try {
      const nextRelease = await discogsFetch<DiscogsRelease>(
        `/releases/${id}`,
        token,
      );
      if (requestId !== releaseRequestRef.current) return;
      const edits = albumFieldsFromRelease(nextRelease);
      const tracks = flattenTracklist(nextRelease.tracklist ?? [], edits.artist);
      if (!tracks.length) {
        throw new Error("This Discogs release does not contain a usable track list.");
      }
      setRelease(nextRelease);
      setAlbumEdits(edits);
      setSearchResults([]);
      setOutputs([]);
      setExportState("idle");
      setLocalFiles((current) => autoAssign(current, tracks.length));
      setSearchState("done");
      setSearchMessage("Pressing selected. Add your FLAC files and sleeve artwork next.");
      window.setTimeout(() => {
        document.getElementById("files")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 80);
    } catch (error) {
      if (requestId !== releaseRequestRef.current) return;
      setSearchState("error");
      setSearchMessage(discogsErrorMessage(error));
    } finally {
      if (requestId === releaseRequestRef.current) setLoadingReleaseId(null);
    }
  }

  async function addFiles(files: File[]) {
    const candidates = files.filter(
      (file) =>
        file.name.toLowerCase().endsWith(".flac") || file.type === "audio/flac",
    );
    if (!candidates.length) {
      setExportState("error");
      setExportMessage("Choose native .flac files. Ogg-FLAC is not supported yet.");
      return;
    }

    const existingKeys = new Set(
      localFiles.map((item) => `${item.file.name}:${item.file.size}:${item.file.lastModified}`),
    );
    const fresh = candidates.filter(
      (file) => !existingKeys.has(`${file.name}:${file.size}:${file.lastModified}`),
    );
    if (!fresh.length) return;

    const pending: LocalFlac[] = fresh.map((file, index) => ({
      id: `${Date.now()}-${index}-${file.name}`,
      file,
      status: "reading",
      assignment: null,
    }));
    setIsReadingFiles(true);
    setOutputs([]);
    setExportState("idle");
    setExportMessage("");
    setLocalFiles((current) =>
      autoAssign(naturalSortFiles([...current, ...pending]), releaseTracks.length),
    );

    for (const item of pending) {
      try {
        const parsed = await inspectFlac(item.file);
        setLocalFiles((current) =>
          current.map((candidate) =>
            candidate.id === item.id
              ? {
                  ...candidate,
                  status: "ready",
                  existingTitle: firstComment(parsed.comments, "TITLE"),
                  durationSeconds: parsed.durationSeconds,
                  sampleRate: parsed.sampleRate,
                  bitsPerSample: parsed.bitsPerSample,
                }
              : candidate,
          ),
        );
      } catch (error) {
        setLocalFiles((current) =>
          current.map((candidate) =>
            candidate.id === item.id
              ? {
                  ...candidate,
                  status: "error",
                  error: error instanceof Error ? error.message : "Could not read this FLAC.",
                }
              : candidate,
          ),
        );
      }
    }

    setLocalFiles((current) => autoAssign(current, releaseTracks.length));
    setIsReadingFiles(false);
  }

  function onFileInput(event: ChangeEvent<HTMLInputElement>) {
    void addFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    void addFiles(Array.from(event.dataTransfer.files));
  }

  async function onCoverInput(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!/^image\/(jpeg|png)$/.test(file.type)) {
      setCoverError("Please choose a JPEG or PNG image.");
      return;
    }

    setIsPreparingCover(true);
    setCoverError("");
    setOutputs([]);
    setExportState("idle");
    try {
      const prepared = await prepareCover(file);
      setCover((current) => {
        if (current) URL.revokeObjectURL(current.previewUrl);
        return prepared;
      });
    } catch (error) {
      setCoverError(error instanceof Error ? error.message : "Could not read that image.");
    } finally {
      setIsPreparingCover(false);
    }
  }

  function removeFile(id: string) {
    setOutputs([]);
    setExportState("idle");
    setLocalFiles((current) =>
      autoAssign(
        current.filter((item) => item.id !== id),
        releaseTracks.length,
      ),
    );
  }

  function moveFile(id: string, direction: -1 | 1) {
    setOutputs([]);
    setExportState("idle");
    setLocalFiles((current) => {
      const index = current.findIndex((item) => item.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return autoAssign(next, releaseTracks.length);
    });
  }

  function changeAssignment(id: string, value: string) {
    setOutputs([]);
    setExportState("idle");
    setLocalFiles((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              assignment: value === "" ? null : Number(value),
              titleOverride: undefined,
            }
          : item,
      ),
    );
  }

  function changeTitle(id: string, title: string) {
    setOutputs([]);
    setExportState("idle");
    setLocalFiles((current) =>
      current.map((item) =>
        item.id === id ? { ...item, titleOverride: title } : item,
      ),
    );
  }

  function updateAlbumField(field: keyof AlbumEdits, value: string) {
    setAlbumEdits((current) => ({ ...current, [field]: value }));
    setOutputs([]);
    setExportState("idle");
  }

  async function prepareTaggedFiles() {
    if (!release || !cover || !canExport) return;
    setExportState("working");
    setExportMessage("Preparing the first track…");
    setOutputs([]);

    const nextOutputs: TaggedOutput[] = [];
    const picture: FlacPicture = {
      blob: cover.blob,
      mimeType: "image/jpeg",
      width: cover.width,
      height: cover.height,
      depth: 24,
      description: "Front cover",
    };
    const barcode =
      release.identifiers?.find((identifier) => identifier.type === "Barcode")?.value ?? "";
    const media =
      release.formats
        ?.map((format) => [format.name, ...(format.descriptions ?? [])].join(", "))
        .join("; ") ?? "";
    const releaseUrl = discogsReleaseUrl(release);

    try {
      for (let index = 0; index < readyFiles.length; index += 1) {
        const item = readyFiles[index];
        const track =
          item.assignment === null ? null : releaseTracks[item.assignment];
        if (!track) continue;
        const title = (item.titleOverride ?? track.title).trim() || track.title;
        const order = {
          discNumber: track.discNumber,
          discTotal,
          trackNumber: track.trackNumber,
          trackTotal: track.trackTotal,
        };
        const tags: FlacTags = {
          TITLE: title,
          ARTIST: track.artist || albumEdits.artist,
          ALBUM: albumEdits.album,
          ALBUMARTIST: albumEdits.artist,
          DATE: albumEdits.year,
          GENRE: splitGenres(albumEdits.genres),
          ...dapOrderingTags(order),
          VINYLTRACK: track.position,
          LABEL: albumEdits.label,
          CATALOGNUMBER: albumEdits.catalogNumber,
          COUNTRY: albumEdits.country,
          BARCODE: barcode,
          MEDIA: media,
          DISCOGS_RELEASE_ID: release.id,
          DISCOGS_RELEASE_URL: releaseUrl,
          COMMENT: "Tagged locally with Flagger using Discogs catalog metadata.",
        };
        setExportMessage(`Tagging ${index + 1} of ${readyFiles.length}: ${title}`);
        const blob = await rewriteFlac(item.file, tags, picture);
        nextOutputs.push({
          id: item.id,
          name: dapOutputFileName(order, title),
          blob,
          title,
          discNumber: track.discNumber,
          trackNumber: track.trackNumber,
        });
      }
      nextOutputs.sort(compareDapOrder);
      setOutputs(nextOutputs);
      setExportState("ready");
      setExportMessage(
        `${nextOutputs.length} tagged FLAC${nextOutputs.length === 1 ? " is" : "s are"} ready in disc and track order. Audio frames were left untouched.`,
      );
    } catch (error) {
      setExportState("error");
      setExportMessage(
        error instanceof Error ? error.message : "The tagged files could not be prepared.",
      );
    }
  }

  async function downloadAll() {
    if (!outputs.length || isZipping) return;
    setIsZipping(true);
    setExportMessage("Checking the finished FLACs for the album ZIP…");
    try {
      const zip = await createStoredZip(
        outputs.map((output) => ({ name: output.name, blob: output.blob })),
        (completed, total) =>
          setExportMessage(`Packing ${completed} of ${total} files into one ZIP…`),
      );
      triggerDownload(zip, `${safeFilePart(albumEdits.album) || "Flagger album"}.zip`);
      setExportMessage(
        `Album ZIP ready (${formatBytes(zip.size)}). Your browser should begin the download.`,
      );
    } catch (error) {
      setExportMessage(
        error instanceof Error
          ? error.message
          : "Could not prepare the album ZIP. Download the tracks individually.",
      );
    } finally {
      setIsZipping(false);
    }
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Flagger home">
          <span className="brand-mark" aria-hidden="true">
            F
          </span>
          <span>
            <strong>Flagger</strong>
            <small>FLAC + TAGGER</small>
          </span>
        </a>
        <div className="local-pill">
          <span aria-hidden="true" />
          Files stay on this device
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">VINYL RIP WORKBENCH / 01</p>
          <h1>
            From needle drop
            <em>to a tidy library.</em>
          </h1>
          <ScribbleUnderline />
          <p className="hero-lede">
            Find the exact Discogs pressing, line it up with your FLAC rips, add your
            own cover, and export device-ready files—without uploading your music.
          </p>
          <div className="hero-actions">
            <a className="primary-button" href="#catalog">
              Find your pressing <span aria-hidden="true">↓</span>
            </a>
            <span className="format-note">Native FLAC · JPEG / PNG · No re-encode</span>
          </div>
        </div>
        <div className="record-stage" aria-hidden="true">
          <RecordOrbitDoodle />
          <div className="record-shadow" />
          <div className="record-disc">
            <div className="record-groove groove-one" />
            <div className="record-groove groove-two" />
            <div className="record-label">
              <span>FLAGGER</span>
              <strong>LOCAL</strong>
              <small>96 / 24</small>
            </div>
          </div>
          <div className="tonearm" />
          <div className="stage-sticker">AUDIO UNTOUCHED</div>
        </div>
      </section>

      <WaveformDivider />

      <nav className="workflow-nav" aria-label="Workflow steps">
        <a href="#catalog" className={release ? "complete" : "active"}>
          <span>01</span> Find pressing
        </a>
        <a href="#files" className={readyFiles.length ? "complete" : ""}>
          <span>02</span> Add files + cover
        </a>
        <a href="#match" className={outputs.length ? "complete" : ""}>
          <span>03</span> Match + export
        </a>
      </nav>

      <section className="workspace-section" id="catalog">
        <div className="section-heading">
          <div className="heading-title">
            <p className="section-number">01 / CATALOG</p>
            <h2>Find the exact pressing</h2>
            <SectionDoodle variant="search" />
          </div>
          <p>
            Search artist, album, catalog number, barcode, or paste a Discogs release
            URL.
          </p>
        </div>

        <div className="search-panel">
          <form onSubmit={runSearch} className="search-form">
            <label htmlFor="release-search">Discogs release search</label>
            <div className="search-row">
              <input
                id="release-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="e.g. Miles Davis Kind of Blue 88697680571"
                autoComplete="off"
              />
              <button
                className="primary-button"
                disabled={searchState === "searching" || loadingReleaseId !== null}
              >
                {searchState === "searching" ? "Searching…" : "Search Discogs"}
              </button>
            </div>
          </form>
          <button
            type="button"
            className="text-button"
            onClick={() => setShowToken((current) => !current)}
            aria-expanded={showToken}
          >
            {showToken ? "Hide" : "Use"} a personal Discogs token
          </button>
          {showToken ? (
            <div className="token-row">
              <div>
                <label htmlFor="discogs-token">Personal token (kept in memory only)</label>
                <p>Useful if anonymous search is rate-limited. It is never saved.</p>
              </div>
              <input
                id="discogs-token"
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="Paste token"
                autoComplete="off"
              />
              <a
                href="https://www.discogs.com/settings/developers"
                target="_blank"
                rel="noreferrer"
              >
                Get token ↗
              </a>
            </div>
          ) : null}
          {searchMessage ? (
            <p className={`status-message ${searchState}`} role="status">
              {searchMessage}
            </p>
          ) : null}
          <a
            className="discogs-credit search-credit"
            href="https://www.discogs.com/"
            target="_blank"
            rel="noreferrer"
          >
            Data provided by Discogs ↗
          </a>
        </div>

        {searchResults.length ? (
          <div className="result-grid" aria-label="Discogs search results">
            {searchResults.map((result) => {
              const image = result.cover_image || result.thumb;
              return (
                <article className="release-card" key={result.id}>
                  <button
                    className="release-select"
                    onClick={() => void chooseRelease(result.id)}
                    disabled={loadingReleaseId !== null}
                  >
                    <span className="cover-frame">
                      <span className="cover-fallback" aria-hidden="true">
                        <i />
                      </span>
                      {image ? (
                        // Discogs artwork is preview-only and is never read into the FLAC.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={image}
                          alt=""
                          referrerPolicy="no-referrer"
                          onError={(event) => {
                            event.currentTarget.style.display = "none";
                          }}
                        />
                      ) : null}
                    </span>
                    <span className="release-copy">
                      <strong>{result.title}</strong>
                      <span>
                        {[result.year, result.country, result.format?.join(" / ")]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      <small>
                        {result.label?.[0] ?? "Unknown label"} · {result.catno || "No cat#"}
                      </small>
                      <b>
                        {loadingReleaseId === result.id ? "Loading…" : "Use this pressing →"}
                      </b>
                    </span>
                  </button>
                  <a
                    className="discogs-credit"
                    href={discogsResultUrl(result)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Data provided by Discogs ↗
                  </a>
                </article>
              );
            })}
          </div>
        ) : null}

        {release ? (
          <article className="selected-release">
            <div className="selected-cover">
              <span className="cover-fallback" aria-hidden="true">
                <i />
              </span>
              {primaryImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={primaryImage.uri}
                  alt={`${albumEdits.album} cover preview on Discogs`}
                  referrerPolicy="no-referrer"
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                  }}
                />
              ) : null}
            </div>
            <div className="selected-copy">
              <p className="selected-kicker">SELECTED PRESSING · #{release.id}</p>
              <h3>{albumEdits.album}</h3>
              <p className="selected-artist">{albumEdits.artist}</p>
              <div className="release-facts">
                <span>{albumEdits.year || "Year unknown"}</span>
                <span>{albumEdits.country || "Country unknown"}</span>
                <span>{albumEdits.label || "Label unknown"}</span>
                <span>{albumEdits.catalogNumber || "No catalog #"}</span>
              </div>
              <p className="selected-note">
                {releaseTracks.length} tracks · Discogs art is shown only as a reference.
                Upload your own cover in step 02.
              </p>
              <a
                className="discogs-credit"
                href={discogsReleaseUrl(release)}
                target="_blank"
                rel="noreferrer"
              >
                Data provided by Discogs ↗
              </a>
            </div>
            <button
              type="button"
              className="quiet-button"
              onClick={() => {
                setRelease(null);
                setAlbumEdits(EMPTY_ALBUM);
                setOutputs([]);
              }}
            >
              Change
            </button>
          </article>
        ) : null}
      </section>

      <section className="workspace-section files-section" id="files">
        <div className="section-heading">
          <div className="heading-title">
            <p className="section-number">02 / LOCAL FILES</p>
            <h2>Add your FLACs + cover</h2>
            <SectionDoodle variant="files" />
          </div>
          <p>Your files are opened locally. Nothing here is sent to Flagger or Discogs.</p>
        </div>

        <div className="upload-grid">
          <div className="upload-card">
            <div className="card-label-row">
              <span className="card-label">AUDIO FILES</span>
              <span>{localFiles.length ? `${localFiles.length} selected` : "Native .flac"}</span>
            </div>
            <div
              className="drop-zone"
              onDragOver={(event) => event.preventDefault()}
              onDrop={onDrop}
            >
              <div className="drop-icon" aria-hidden="true">
                FLAC
              </div>
              <h3>Drop your album tracks here</h3>
              <p>Natural filename order is used first. You can rearrange every track.</p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => fileInputRef.current?.click()}
              >
                Choose FLAC files
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".flac,audio/flac"
                multiple
                onChange={onFileInput}
                className="visually-hidden"
              />
            </div>
            {isReadingFiles ? <p className="mini-status">Reading FLAC headers…</p> : null}
          </div>

          <div className="upload-card cover-upload-card">
            <div className="card-label-row">
              <span className="card-label">YOUR COVER</span>
              <span>Required · JPEG / PNG</span>
            </div>
            {cover ? (
              <div className="cover-ready">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={cover.previewUrl} alt="Your cover ready to embed" />
                <div>
                  <span className="success-chip">READY TO EMBED</span>
                  <h3>{cover.width} × {cover.height} JPEG</h3>
                  <p>Optimized for portable players and baked into every track.</p>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => coverInputRef.current?.click()}
                  >
                    Replace cover
                  </button>
                </div>
              </div>
            ) : (
              <div className="cover-empty">
                <div className="cover-placeholder" aria-hidden="true">
                  <span>+</span>
                </div>
                <div>
                  <h3>Add your sleeve scan</h3>
                  <p>
                    Use artwork you own or have permission to use. Flagger converts it
                    to a DAP-friendly JPEG.
                  </p>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => coverInputRef.current?.click()}
                    disabled={isPreparingCover}
                  >
                    {isPreparingCover ? "Preparing…" : "Choose cover image"}
                  </button>
                </div>
              </div>
            )}
            <input
              ref={coverInputRef}
              type="file"
              accept="image/jpeg,image/png"
              onChange={onCoverInput}
              className="visually-hidden"
            />
            {coverError ? <p className="status-message error">{coverError}</p> : null}
          </div>
        </div>

        {localFiles.length ? (
          <div className="file-list" aria-label="Selected FLAC files">
            <div className="file-list-header">
              <span>ORDER</span>
              <span>LOCAL FILE</span>
              <span>TECHNICAL</span>
              <span>STATUS</span>
              <span />
            </div>
            {localFiles.map((item, index) => (
              <div className={`file-row ${item.status}`} key={item.id}>
                <div className="order-controls">
                  <b>{String(index + 1).padStart(2, "0")}</b>
                  <span>
                    <button
                      type="button"
                      onClick={() => moveFile(item.id, -1)}
                      disabled={index === 0}
                      aria-label={`Move ${item.file.name} up`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveFile(item.id, 1)}
                      disabled={index === localFiles.length - 1}
                      aria-label={`Move ${item.file.name} down`}
                    >
                      ↓
                    </button>
                  </span>
                </div>
                <div className="file-name">
                  <strong>{item.file.name}</strong>
                  <span>
                    {item.existingTitle ? `Existing title: ${item.existingTitle}` : formatBytes(item.file.size)}
                  </span>
                </div>
                <div className="technical">
                  {item.status === "ready" ? (
                    <>
                      <span>{formatDuration(item.durationSeconds)}</span>
                      <span>{formatAudioSpec(item.sampleRate, item.bitsPerSample)}</span>
                    </>
                  ) : (
                    <span>—</span>
                  )}
                </div>
                <div>
                  <span className={`file-status ${item.status}`}>
                    {item.status === "reading"
                      ? "Reading"
                      : item.status === "ready"
                        ? "Valid FLAC"
                        : "Needs attention"}
                  </span>
                  {item.error ? <small className="file-error">{item.error}</small> : null}
                </div>
                <button
                  type="button"
                  className="remove-button"
                  onClick={() => removeFile(item.id)}
                  aria-label={`Remove ${item.file.name}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="workspace-section match-section" id="match">
        <div className="section-heading">
          <div className="heading-title">
            <p className="section-number">03 / TAG + EXPORT</p>
            <h2>Match the tracks</h2>
            <SectionDoodle variant="match" />
          </div>
          <p>Confirm the order, make any corrections, then prepare the finished album.</p>
        </div>

        {!release || !readyFiles.length ? (
          <div className="locked-panel">
            <span aria-hidden="true">03</span>
            <div>
              <h3>This step unlocks when the pressing and FLACs are ready.</h3>
              <p>Select a Discogs release above, then add at least one valid file.</p>
            </div>
          </div>
        ) : (
          <>
            <div className="metadata-editor">
              <div className="editor-heading">
                <div>
                  <span className="card-label">ALBUM TAGS</span>
                  <h3>Clean up the shared metadata</h3>
                </div>
                <div className="panel-actions">
                  <a
                    className="discogs-credit panel-credit"
                    href={discogsReleaseUrl(release)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Data provided by Discogs ↗
                  </a>
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => {
                      setAlbumEdits(albumFieldsFromRelease(release));
                      setOutputs([]);
                      setExportState("idle");
                    }}
                  >
                    Reset from Discogs
                  </button>
                </div>
              </div>
              <div className="field-grid">
                <label>
                  Album artist
                  <input
                    value={albumEdits.artist}
                    onChange={(event) => updateAlbumField("artist", event.target.value)}
                  />
                </label>
                <label className="field-wide">
                  Album title
                  <input
                    value={albumEdits.album}
                    onChange={(event) => updateAlbumField("album", event.target.value)}
                  />
                </label>
                <label>
                  Year
                  <input
                    value={albumEdits.year}
                    inputMode="numeric"
                    onChange={(event) => updateAlbumField("year", event.target.value)}
                  />
                </label>
                <label>
                  Label
                  <input
                    value={albumEdits.label}
                    onChange={(event) => updateAlbumField("label", event.target.value)}
                  />
                </label>
                <label>
                  Catalog number
                  <input
                    value={albumEdits.catalogNumber}
                    onChange={(event) => updateAlbumField("catalogNumber", event.target.value)}
                  />
                </label>
                <label>
                  Country
                  <input
                    value={albumEdits.country}
                    onChange={(event) => updateAlbumField("country", event.target.value)}
                  />
                </label>
                <label className="field-wide">
                  Genres / styles
                  <input
                    value={albumEdits.genres}
                    onChange={(event) => updateAlbumField("genres", event.target.value)}
                    placeholder="Jazz; Modal; Cool Jazz"
                  />
                </label>
              </div>
            </div>

            <div className="mapping-panel">
              <div className="mapping-toolbar">
                <div>
                  <span className="card-label">TRACK MAP</span>
                  <p>{readyFiles.length} files ↔ {releaseTracks.length} release tracks</p>
                </div>
                <div className="panel-actions">
                  <a
                    className="discogs-credit panel-credit"
                    href={discogsReleaseUrl(release)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Data provided by Discogs ↗
                  </a>
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => {
                      setLocalFiles((current) =>
                        autoAssign(current, releaseTracks.length),
                      );
                      setOutputs([]);
                      setExportState("idle");
                    }}
                  >
                    Match by current order
                  </button>
                </div>
              </div>
              <div className="mapping-list">
                {readyFiles.map((item) => {
                  const track =
                    item.assignment === null ? null : releaseTracks[item.assignment];
                  return (
                    <div className="mapping-row" key={item.id}>
                      <div className="source-file">
                        <span>LOCAL FLAC</span>
                        <strong>{item.file.name}</strong>
                        <small>{formatDuration(item.durationSeconds)}</small>
                      </div>
                      <PatchCableArrow />
                      <label className="track-select">
                        Discogs track
                        <select
                          value={item.assignment ?? ""}
                          onChange={(event) => changeAssignment(item.id, event.target.value)}
                        >
                          <option value="">Choose a track…</option>
                          {releaseTracks.map((option, optionIndex) => (
                            <option key={`${option.position}-${optionIndex}`} value={optionIndex}>
                              {option.position || String(optionIndex + 1)} · {option.title}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="title-edit">
                        Final title
                        <input
                          value={item.titleOverride ?? track?.title ?? ""}
                          onChange={(event) => changeTitle(item.id, event.target.value)}
                          disabled={!track}
                        />
                      </label>
                      <div className="track-meta">
                        {track ? (
                          <>
                            <b>#{track.trackNumber}</b>
                            <span>{track.position || "—"}</span>
                            <small>{track.duration || "No duration"}</small>
                          </>
                        ) : (
                          <span>Unmatched</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {!assignmentsUnique ? (
                <p className="status-message error">
                  Each local file must map to a different Discogs track.
                </p>
              ) : null}
            </div>

            <div className="export-panel">
              <div className="export-copy">
                <p className="section-number">FINAL CHECK</p>
                <h3>Ready for your Walkman, FiiO, or SnowSky.</h3>
                <ul>
                  <li className={release ? "done" : ""}>Discogs pressing selected</li>
                  <li className={assignmentsComplete && assignmentsUnique ? "done" : ""}>
                    Every FLAC matched once
                  </li>
                  <li className={cover ? "done" : ""}>Your cover ready to embed</li>
                  <li className="done">DAP-safe filenames + ordered album ZIP</li>
                  <li className="done">Audio frames will remain byte-for-byte intact</li>
                </ul>
              </div>
              <div className="export-action">
                <div className="export-count">
                  <strong>{String(readyFiles.length).padStart(2, "0")}</strong>
                  <span>tracks</span>
                </div>
                <button
                  type="button"
                  className="primary-button export-button"
                  disabled={!canExport}
                  onClick={() => void prepareTaggedFiles()}
                >
                  {exportState === "working" ? "Tagging files…" : "Prepare tagged FLACs"}
                </button>
                {!cover ? <small>Add your cover to continue.</small> : null}
              </div>
            </div>
          </>
        )}

        {exportMessage ? (
          <p className={`status-message export-status ${exportState}`} role="status">
            {exportMessage}
          </p>
        ) : null}

        {outputs.length ? (
          <div className="download-panel">
            <div className="download-heading">
              <div>
                <span className="success-chip">ALBUM READY</span>
                <h3>Download your finished FLACs</h3>
                <p>
                  SnowSky tip: extract the album ZIP directly into a new empty folder on
                  the SD card; File view may follow copy order.
                </p>
              </div>
              <button
                type="button"
                className="primary-button"
                onClick={() => void downloadAll()}
                disabled={isZipping}
              >
                {isZipping ? "Preparing ZIP…" : `Download album ZIP (${outputs.length})`}
              </button>
            </div>
            <div className="download-list">
              {outputs.map((output, index) => (
                <div key={output.id}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <p>
                    <strong>{output.title}</strong>
                    <small>{output.name}</small>
                  </p>
                  <b>{formatBytes(output.blob.size)}</b>
                  <button
                    type="button"
                    onClick={() => triggerDownload(output.blob, output.name)}
                  >
                    Download ↓
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <section className="privacy-strip">
        <div className="privacy-record" aria-hidden="true"><span /></div>
        <div>
          <p className="section-number">LOCAL BY DESIGN</p>
          <h2>Your masters do not need a cloud.</h2>
        </div>
        <p>
          Flagger reads only the metadata area of each FLAC and joins the untouched audio
          to new tags in your browser. Discogs receives catalog searches—not music files,
          cover uploads, or listening data.
        </p>
      </section>

      <footer>
        <div className="brand footer-brand">
          <span className="brand-mark" aria-hidden="true">F</span>
          <span><strong>Flagger</strong><small>FLAC + TAGGER</small></span>
        </div>
        <p>
          This application uses Discogs’ API but is not affiliated with, sponsored or
          endorsed by Discogs. “Discogs” is a trademark of Zink Media, LLC.
        </p>
        <a href="#top">Back to top ↑</a>
      </footer>
    </main>
  );
}

function ScribbleUnderline() {
  return (
    <svg
      className="hand-doodle hero-underline"
      viewBox="0 0 620 44"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="doodle-path"
        pathLength={1}
        d="M7 23 C86 8 155 33 235 19 C328 3 421 32 613 12"
      />
      <path
        className="doodle-path doodle-echo"
        pathLength={1}
        d="M18 32 C116 20 178 38 265 27 C370 14 457 34 596 22"
      />
    </svg>
  );
}

function RecordOrbitDoodle() {
  return (
    <svg
      className="hand-doodle record-orbit-doodle"
      viewBox="0 0 520 520"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="doodle-path"
        pathLength={1}
        d="M75 370 C18 279 45 139 151 72 C254 8 401 54 463 169 C521 276 472 414 359 467 C257 515 132 463 75 370 Z"
      />
      <path
        className="doodle-path doodle-accent doodle-delay"
        pathLength={1}
        d="M31 192 C22 176 24 153 38 140 M24 153 L10 149 M25 153 L32 137 M449 429 C464 435 482 431 493 418 M480 430 L495 439 M480 430 L484 413"
      />
      <path
        className="doodle-path doodle-delay-two"
        pathLength={1}
        d="M457 76 L465 55 L474 76 L496 84 L475 92 L467 114 L458 94 L437 85 Z"
      />
    </svg>
  );
}

function WaveformDivider() {
  return (
    <div className="waveform-divider">
      <svg
        className="hand-doodle"
        viewBox="0 0 1440 80"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <path
          className="doodle-path"
          pathLength={1}
          d="M0 44 C45 42 62 42 98 43 L132 43 L146 21 L160 66 L176 33 L193 53 L215 42 C267 40 308 43 355 43 L391 43 L405 9 L421 71 L438 26 L455 57 L476 43 C535 40 578 44 628 43 L665 43 L681 18 L697 64 L714 30 L731 55 L753 43 C812 40 856 44 910 43 L944 43 L959 11 L976 72 L994 27 L1011 58 L1032 43 C1092 40 1138 44 1190 43 L1226 43 L1241 22 L1257 64 L1273 33 L1290 53 L1312 43 C1358 41 1397 43 1440 42"
        />
        <path
          className="doodle-path doodle-echo doodle-delay"
          pathLength={1}
          d="M0 51 C179 54 314 50 480 52 C641 54 802 49 978 52 C1130 55 1288 50 1440 52"
        />
      </svg>
      <span>ANALOG IN · CLEAN TAGS OUT · AUDIO UNTOUCHED</span>
    </div>
  );
}

function SectionDoodle({ variant }: { variant: "search" | "files" | "match" }) {
  if (variant === "search") {
    return (
      <svg
        className="hand-doodle section-doodle"
        viewBox="0 0 132 92"
        aria-hidden="true"
        focusable="false"
      >
        <path
          className="doodle-path"
          pathLength={1}
          d="M18 38 C17 17 38 7 56 13 C76 20 80 43 67 57 C53 72 27 62 19 45 C12 30 23 15 38 11"
        />
        <path
          className="doodle-path doodle-delay"
          pathLength={1}
          d="M66 57 C80 66 92 75 106 84 M95 75 L108 84 L103 69"
        />
      </svg>
    );
  }
  if (variant === "files") {
    return (
      <svg
        className="hand-doodle section-doodle"
        viewBox="0 0 132 92"
        aria-hidden="true"
        focusable="false"
      >
        <path
          className="doodle-path"
          pathLength={1}
          d="M20 25 C43 19 69 20 93 23 L96 67 C68 71 45 68 18 71 Z M27 17 C48 12 76 14 103 18 L105 58"
        />
        <path
          className="doodle-path doodle-accent doodle-delay"
          pathLength={1}
          d="M31 48 C39 47 40 34 47 34 C55 35 54 58 62 57 C70 56 70 38 78 39 C84 40 86 50 94 49"
        />
      </svg>
    );
  }
  return (
    <svg
      className="hand-doodle section-doodle"
      viewBox="0 0 132 92"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="doodle-path"
        pathLength={1}
        d="M14 48 C28 49 37 48 48 49 M84 49 C96 49 106 49 119 47 M47 35 L63 50 L84 27 M48 39 L63 55 L87 31"
      />
      <path
        className="doodle-path doodle-accent doodle-delay"
        pathLength={1}
        d="M24 27 L28 16 M17 31 L8 24 M101 67 L109 77 M108 62 L122 64"
      />
    </svg>
  );
}

function PatchCableArrow() {
  return (
    <svg
      className="hand-doodle mapping-arrow patch-cable"
      viewBox="0 0 66 30"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="doodle-path" pathLength={1} cx="7" cy="15" r="4" />
      <path
        className="doodle-path doodle-accent doodle-delay"
        pathLength={1}
        d="M11 15 C22 2 37 28 51 14 C55 10 58 11 61 14"
      />
      <path
        className="doodle-path doodle-delay-two"
        pathLength={1}
        d="M54 8 L62 14 L54 21"
      />
    </svg>
  );
}

async function discogsFetch<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${DISCogs_API}${path}`, {
    headers: {
      Accept: "application/vnd.discogs.v2.discogs+json",
      ...(token.trim() ? { Authorization: `Discogs token=${token.trim()}` } : {}),
    },
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { message?: string } | null;
    const error = new Error(detail?.message || `Discogs returned ${response.status}.`);
    Object.assign(error, { status: response.status });
    throw error;
  }
  return (await response.json()) as T;
}

function discogsErrorMessage(error: unknown): string {
  const status =
    typeof error === "object" && error && "status" in error
      ? Number((error as { status: unknown }).status)
      : 0;
  if (status === 401 || status === 403) {
    return "Discogs asked for authentication. Open the personal token field and try again.";
  }
  if (status === 429) {
    return "Discogs is rate-limiting requests. Wait a minute, or use a personal token.";
  }
  return error instanceof Error ? error.message : "Could not reach Discogs right now.";
}

function releaseIdFromInput(value: string): number | null {
  const urlMatch = value.match(/discogs\.com\/(?:[^/]+\/)?release\/(\d+)/i);
  const directMatch = value.match(/^#?(\d{3,})$/);
  const raw = urlMatch?.[1] ?? directMatch?.[1];
  return raw ? Number(raw) : null;
}

function albumFieldsFromRelease(release: DiscogsRelease): AlbumEdits {
  const artist = formatArtists(release.artists) || cleanDiscogsName(release.artists_sort ?? "");
  return {
    artist,
    album: release.title,
    year: String(release.year || release.released?.slice(0, 4) || ""),
    genres: [...(release.genres ?? []), ...(release.styles ?? [])].join("; "),
    label: release.labels?.[0]?.name ?? "",
    catalogNumber: release.labels?.[0]?.catno ?? "",
    country: release.country ?? "",
  };
}

function flattenTracklist(tracklist: DiscogsTrack[], albumArtist: string): ReleaseTrack[] {
  const flat: Array<{
    title: string;
    artist: string;
    position: string;
    duration: string;
    discNumber: number;
  }> = [];

  const addTrack = (track: DiscogsTrack, parent?: DiscogsTrack) => {
    if (track.type_ !== "track") return;
    const artist = formatArtists(track.artists) || formatArtists(parent?.artists) || albumArtist;
    flat.push({
      title: track.title,
      artist,
      position: track.position || parent?.position || "",
      duration: track.duration || parent?.duration || "",
      discNumber: inferDiscNumber(track.position || parent?.position || ""),
    });
  };

  for (const track of tracklist) {
    if (track.type_ !== "track") continue;
    if (track.sub_tracks?.length) {
      track.sub_tracks.forEach((subTrack) => addTrack(subTrack, track));
    } else {
      addTrack(track);
    }
  }

  const counters = new Map<number, number>();
  const totals = new Map<number, number>();
  flat.forEach((track) => totals.set(track.discNumber, (totals.get(track.discNumber) ?? 0) + 1));
  return flat.map((track) => {
    const trackNumber = (counters.get(track.discNumber) ?? 0) + 1;
    counters.set(track.discNumber, trackNumber);
    return {
      ...track,
      trackNumber,
      trackTotal: totals.get(track.discNumber) ?? flat.length,
    };
  });
}

function inferDiscNumber(position: string): number {
  const numbered = position.match(/^(\d+)[.-]\d+/);
  if (numbered) return Math.max(1, Number(numbered[1]));
  const side = position.trim().toUpperCase().match(/^([A-Z])/);
  if (side) return Math.floor((side[1].charCodeAt(0) - 65) / 2) + 1;
  return 1;
}

function formatArtists(artists?: DiscogsArtist[]): string {
  if (!artists?.length) return "";
  return artists
    .map((artist, index) => {
      const name = cleanDiscogsName(artist.anv || artist.name);
      const join = artist.join ?? (index < artists.length - 1 ? ", " : "");
      return `${name}${join}`;
    })
    .join("")
    .trim();
}

function cleanDiscogsName(value: string): string {
  return value.replace(/\s+\(\d+\)$/u, "").trim();
}

function naturalSortFiles(files: LocalFlac[]): LocalFlac[] {
  return [...files].sort((left, right) =>
    left.file.name.localeCompare(right.file.name, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

function autoAssign(files: LocalFlac[], trackCount: number): LocalFlac[] {
  let readyIndex = 0;
  return files.map((item) => {
    if (item.status === "error") return { ...item, assignment: null };
    const assignment = trackCount && readyIndex < trackCount ? readyIndex : null;
    readyIndex += 1;
    return { ...item, assignment, titleOverride: undefined };
  });
}

async function prepareCover(file: File): Promise<CoverAsset> {
  if (file.size > 50 * 1024 * 1024) {
    throw new Error("That image is unusually large. Please choose one under 50 MB.");
  }
  const bitmap = await createImageBitmap(file);
  const maxEdge = 1400;
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("Your browser could not prepare the cover image.");
  }
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error("Could not encode the cover."))),
      "image/jpeg",
      0.9,
    );
  });
  return { blob, width, height, previewUrl: URL.createObjectURL(blob) };
}

function splitGenres(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((genre) => genre.trim())
    .filter(Boolean);
}

function formatDuration(seconds?: number | null): string {
  if (!seconds || !Number.isFinite(seconds)) return "—:—";
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function formatAudioSpec(sampleRate?: number, bitsPerSample?: number): string {
  if (!sampleRate || !bitsPerSample) return "FLAC";
  const rate = sampleRate % 1000 === 0 ? String(sampleRate / 1000) : (sampleRate / 1000).toFixed(1);
  return `${rate} kHz / ${bitsPerSample}-bit`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes > 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function safeFilePart(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function discogsResultUrl(result: DiscogsSearchResult): string {
  if (result.uri?.startsWith("/")) return `https://www.discogs.com${result.uri}`;
  return `https://www.discogs.com/release/${result.id}`;
}

function discogsReleaseUrl(release: DiscogsRelease): string {
  if (release.uri?.startsWith("http")) return release.uri;
  if (release.uri?.startsWith("/")) return `https://www.discogs.com${release.uri}`;
  return `https://www.discogs.com/release/${release.id}`;
}
