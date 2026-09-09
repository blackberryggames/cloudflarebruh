// ─────────────────────────────────────────────────────────────────────────────
// YT-Proxy — Cloudflare Worker
// Proxies the Invidious open-source YouTube API (no API key needed).
// Routes:
//   GET /              → serves the frontend HTML
//   GET /api/*         → proxies to Invidious API (instance rotation)
//   GET /stream?id=&itag= → streams video bytes back to browser
// ─────────────────────────────────────────────────────────────────────────────

const INSTANCES = [
  "https://inv.nadeko.net",
  "https://invidious.tiekoetter.com",
  "https://invidious.nerdvpn.de",
  "https://yt.chocolatemoo53.com",
];

// ── helpers ──────────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
  };
}

async function tryInstances(path) {
  let lastErr;
  for (const inst of INSTANCES) {
    try {
      const r = await fetch(`${inst}${path}`, {
        headers: { "User-Agent": "Mozilla/5.0 yt-proxy/1.0", Accept: "application/json" },
        signal: AbortSignal.timeout(9000),
        cf: { cacheTtl: 120, cacheEverything: false },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      return { data, instance: inst };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("All instances failed");
}

// ── route: /api ───────────────────────────────────────────────────────────────

async function handleApi(url) {
  // Strip /api prefix, forward rest to Invidious
  const invPath = url.pathname.replace(/^\/api/, "") + url.search;
  try {
    const { data, instance } = await tryInstances(invPath);
    return Response.json({ data, instance }, {
      headers: { ...corsHeaders(), "Cache-Control": "public, max-age=120" },
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 502, headers: corsHeaders() });
  }
}

// ── route: /stream ────────────────────────────────────────────────────────────
// Fetches the direct video URL from Invidious then pipes bytes to the client.
// This works because Invidious returns GoogleVideo URLs that are public but
// have strict Referer/Origin requirements — piping through the worker sidesteps that.

async function handleStream(url, request) {
  const id = url.searchParams.get("id");
  const itag = url.searchParams.get("itag") || "18"; // 18 = 360p mp4, always available

  if (!id) return new Response("Missing ?id=", { status: 400 });

  // 1. Ask Invidious for video metadata to get the stream URL
  let videoData;
  try {
    const { data } = await tryInstances(`/api/v1/videos/${id}?fields=formatStreams,adaptiveFormats`);
    videoData = data;
  } catch (e) {
    return new Response(`Could not fetch video info: ${e.message}`, { status: 502 });
  }

  // 2. Find the requested format
  const allFormats = [
    ...(videoData.formatStreams ?? []),
    ...(videoData.adaptiveFormats ?? []),
  ];

  // Prefer exact itag match; fall back to first mp4 format
  let format =
    allFormats.find((f) => String(f.itag) === String(itag)) ||
    allFormats.find((f) => f.container === "mp4" || (f.type && f.type.includes("video/mp4"))) ||
    allFormats[0];

  if (!format?.url) {
    return new Response("No streamable format found for this video", { status: 404 });
  }

  // 3. Pipe the video stream, forwarding Range headers for seek support
  const streamHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Referer: "https://www.youtube.com/",
    Origin: "https://www.youtube.com",
  };
  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) streamHeaders["Range"] = rangeHeader;

  const upstream = await fetch(format.url, { headers: streamHeaders });

  // Forward relevant headers
  const responseHeaders = {
    ...corsHeaders(),
    "Content-Type": upstream.headers.get("Content-Type") || "video/mp4",
    "Accept-Ranges": "bytes",
  };
  if (upstream.headers.get("Content-Length"))
    responseHeaders["Content-Length"] = upstream.headers.get("Content-Length");
  if (upstream.headers.get("Content-Range"))
    responseHeaders["Content-Range"] = upstream.headers.get("Content-Range");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

// ── route: /formats ───────────────────────────────────────────────────────────
// Returns available formats for a video ID so the frontend can offer quality options

async function handleFormats(url) {
  const id = url.searchParams.get("id");
  if (!id) return Response.json({ error: "Missing ?id=" }, { status: 400 });

  try {
    const { data, instance } = await tryInstances(
      `/api/v1/videos/${id}?fields=title,author,description,lengthSeconds,viewCount,formatStreams,adaptiveFormats,videoThumbnails`
    );

    const formats = [
      ...(data.formatStreams ?? []).map((f) => ({
        itag: f.itag,
        label: f.qualityLabel || f.quality,
        container: f.container,
        type: f.type,
        hasAudio: true, // formatStreams always have audio
      })),
    ];

    return Response.json(
      {
        title: data.title,
        author: data.author,
        description: data.description,
        lengthSeconds: data.lengthSeconds,
        viewCount: data.viewCount,
        thumbnail: data.videoThumbnails?.find((t) => t.quality === "maxres")?.url ||
          data.videoThumbnails?.[0]?.url,
        formats,
        instance,
      },
      { headers: { ...corsHeaders(), "Cache-Control": "public, max-age=300" } }
    );
  } catch (e) {
    return Response.json({ error: e.message }, { status: 502, headers: corsHeaders() });
  }
}

// ── route: / (frontend HTML) ──────────────────────────────────────────────────

function serveFrontend() {
  return new Response(HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ── main handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname.startsWith("/api/")) return handleApi(url);
    if (url.pathname === "/stream") return handleStream(url, request);
    if (url.pathname === "/formats") return handleFormats(url);
    return serveFrontend();
  },
};

// ── Frontend HTML/CSS/JS (all inline for single-file deployment) ──────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>YT Proxy</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0f0f0f;
    --surface: #1a1a1a;
    --surface2: #242424;
    --border: #333;
    --accent: #ff4444;
    --accent2: #cc2222;
    --text: #e8e8e8;
    --muted: #888;
    --radius: 8px;
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
  }

  header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 14px 20px;
    display: flex;
    align-items: center;
    gap: 16px;
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .logo {
    font-size: 1.3rem;
    font-weight: 700;
    color: var(--accent);
    letter-spacing: -0.5px;
    white-space: nowrap;
    text-decoration: none;
    cursor: pointer;
  }

  .search-bar {
    display: flex;
    flex: 1;
    max-width: 640px;
    gap: 8px;
  }

  .search-bar input {
    flex: 1;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 9px 14px;
    color: var(--text);
    font-size: 0.95rem;
    outline: none;
    transition: border-color 0.2s;
  }
  .search-bar input:focus { border-color: var(--accent); }

  .search-bar button {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--radius);
    padding: 9px 18px;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
  }
  .search-bar button:hover { background: var(--accent2); }

  main { padding: 24px 20px; max-width: 1200px; margin: 0 auto; }

  /* ── Player ── */
  #player-section {
    display: none;
    margin-bottom: 32px;
  }
  #player-section.visible { display: block; }

  .player-grid {
    display: grid;
    grid-template-columns: 1fr 340px;
    gap: 20px;
  }
  @media (max-width: 800px) {
    .player-grid { grid-template-columns: 1fr; }
  }

  .video-wrap {
    background: #000;
    border-radius: var(--radius);
    overflow: hidden;
    aspect-ratio: 16/9;
    position: relative;
  }
  #video-player {
    width: 100%;
    height: 100%;
    display: block;
    background: #000;
  }

  .video-meta { padding-top: 12px; }
  .video-title { font-size: 1.15rem; font-weight: 700; line-height: 1.4; margin-bottom: 6px; }
  .video-sub {
    font-size: 0.85rem;
    color: var(--muted);
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }

  .quality-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .quality-btn {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    padding: 4px 10px;
    font-size: 0.8rem;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .quality-btn:hover { background: var(--border); }
  .quality-btn.active { border-color: var(--accent); color: var(--accent); }

  .desc-box {
    background: var(--surface2);
    border-radius: var(--radius);
    padding: 12px;
    font-size: 0.82rem;
    color: var(--muted);
    line-height: 1.6;
    max-height: 120px;
    overflow-y: auto;
    white-space: pre-wrap;
  }

  /* ── Related / Search results ── */
  .section-title {
    font-size: 0.85rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin-bottom: 14px;
  }

  .results-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 16px;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    cursor: pointer;
    transition: transform 0.15s, border-color 0.15s;
  }
  .card:hover { transform: translateY(-2px); border-color: #555; }

  .card-thumb {
    width: 100%;
    aspect-ratio: 16/9;
    object-fit: cover;
    background: var(--surface2);
    display: block;
  }
  .card-body { padding: 10px 12px 12px; }
  .card-title {
    font-size: 0.88rem;
    font-weight: 600;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin-bottom: 4px;
  }
  .card-meta { font-size: 0.76rem; color: var(--muted); }

  /* ── Status / loading ── */
  .status {
    text-align: center;
    padding: 48px 20px;
    color: var(--muted);
    font-size: 0.95rem;
  }
  .spinner {
    width: 36px; height: 36px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    margin: 0 auto 16px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .err { color: #f87171; }

  /* ── Instance badge ── */
  #instance-badge {
    font-size: 0.7rem;
    color: var(--muted);
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 8px;
    margin-left: auto;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
  }
</style>
</head>
<body>

<header>
  <a class="logo" onclick="goHome()">▶ YT Proxy</a>
  <div class="search-bar">
    <input id="q" type="text" placeholder="Search videos…" autocomplete="off"
      onkeydown="if(event.key==='Enter') doSearch()" />
    <button onclick="doSearch()">Search</button>
  </div>
  <span id="instance-badge" title="Current Invidious instance"></span>
</header>

<main>
  <!-- Player section -->
  <section id="player-section">
    <div class="player-grid">
      <div>
        <div class="video-wrap">
          <video id="video-player" controls playsinline preload="metadata"></video>
        </div>
        <div class="video-meta">
          <div class="video-title" id="vtitle"></div>
          <div class="video-sub">
            <span id="vauthor"></span>
            <span id="vviews"></span>
            <span id="vlen"></span>
          </div>
          <div class="quality-row" id="quality-row"></div>
          <div class="desc-box" id="vdesc"></div>
        </div>
      </div>
      <div>
        <div class="section-title">Related</div>
        <div id="related-grid" class="results-grid"></div>
      </div>
    </div>
  </section>

  <!-- Search / home results -->
  <section id="results-section">
    <div id="results-status" class="status">
      <div style="font-size:2.5rem; margin-bottom:12px">▶</div>
      Search for any video to get started.
    </div>
    <div id="results-grid" class="results-grid" style="display:none"></div>
  </section>
</main>

<script>
  const BASE = location.origin; // same origin — Worker handles everything

  // ─── Utilities ────────────────────────────────────────────────────────────

  function fmtNum(n) {
    if (!n) return "";
    const x = parseInt(n);
    if (x >= 1e9) return (x / 1e9).toFixed(1) + "B views";
    if (x >= 1e6) return (x / 1e6).toFixed(1) + "M views";
    if (x >= 1e3) return (x / 1e3).toFixed(0) + "K views";
    return x + " views";
  }

  function fmtDur(s) {
    if (!s) return "";
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h
      ? \`\${h}:\${String(m).padStart(2,"0")}:\${String(sec).padStart(2,"0")}\`
      : \`\${m}:\${String(sec).padStart(2,"0")}\`;
  }

  function setBadge(inst) {
    const b = document.getElementById("instance-badge");
    b.textContent = inst ? inst.replace("https://", "") : "";
    b.title = inst || "";
  }

  function setStatus(html, grid) {
    document.getElementById("results-status").innerHTML = html;
    document.getElementById("results-status").style.display = "";
    if (grid) { grid.innerHTML = ""; grid.style.display = "none"; }
  }

  function loading() {
    setStatus('<div class="spinner"></div>Loading…');
  }

  // ─── Home ─────────────────────────────────────────────────────────────────

  function goHome() {
    document.getElementById("player-section").classList.remove("visible");
    document.getElementById("results-section").style.display = "";
    document.getElementById("q").value = "";
    setStatus('<div style="font-size:2.5rem;margin-bottom:12px">▶</div>Search for any video to get started.');
    document.getElementById("results-grid").style.display = "none";
    history.pushState({}, "", "/");
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  async function doSearch() {
    const q = document.getElementById("q").value.trim();
    if (!q) return;

    // Hide player
    document.getElementById("player-section").classList.remove("visible");
    document.getElementById("results-section").style.display = "";

    loading();

    try {
      const res = await fetch(\`\${BASE}/api/v1/search?q=\${encodeURIComponent(q)}&type=video&fields=videoId,title,author,viewCount,lengthSeconds,videoThumbnails\`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);

      setBadge(json.instance);
      renderResults(json.data, document.getElementById("results-grid"));
    } catch (e) {
      setStatus(\`<div class="err">Search failed: \${e.message}</div>\`);
    }
  }

  function renderResults(items, grid) {
    const status = document.getElementById("results-status");
    if (!items || !items.length) {
      status.innerHTML = '<div class="err">No results found.</div>';
      grid.style.display = "none";
      return;
    }
    status.style.display = "none";
    grid.style.display = "grid";
    grid.innerHTML = items.filter(v => v.videoId).map(v => {
      const thumb = v.videoThumbnails?.find(t => t.quality === "medium")?.url
        || v.videoThumbnails?.[0]?.url || "";
      return \`<div class="card" onclick="playVideo('\${v.videoId}')">
        <img class="card-thumb" src="\${thumb}" alt="" loading="lazy" onerror="this.style.background='#333'">
        <div class="card-body">
          <div class="card-title">\${v.title || "Untitled"}</div>
          <div class="card-meta">\${v.author || ""} · \${fmtDur(v.lengthSeconds)}</div>
        </div>
      </div>\`;
    }).join("");
  }

  // ─── Play video ───────────────────────────────────────────────────────────

  let currentId = null;
  let currentFormats = [];

  async function playVideo(id) {
    currentId = id;
    document.getElementById("results-section").style.display = "none";
    const ps = document.getElementById("player-section");
    ps.classList.add("visible");
    document.getElementById("vtitle").textContent = "Loading…";
    document.getElementById("vauthor").textContent = "";
    document.getElementById("vviews").textContent = "";
    document.getElementById("vlen").textContent = "";
    document.getElementById("vdesc").textContent = "";
    document.getElementById("quality-row").innerHTML = "";
    document.getElementById("related-grid").innerHTML = '<div class="status"><div class="spinner"></div></div>';
    const player = document.getElementById("video-player");
    player.src = "";

    try {
      const res = await fetch(\`\${BASE}/formats?id=\${id}\`);
      const info = await res.json();
      if (info.error) throw new Error(info.error);

      setBadge(info.instance);

      document.getElementById("vtitle").textContent = info.title || "Unknown title";
      document.getElementById("vauthor").textContent = info.author || "";
      document.getElementById("vviews").textContent = fmtNum(info.viewCount);
      document.getElementById("vlen").textContent = fmtDur(info.lengthSeconds);
      document.getElementById("vdesc").textContent = info.description || "";

      currentFormats = info.formats || [];
      renderQuality(currentFormats);

      // Auto-play with best available format
      if (currentFormats.length) {
        selectFormat(currentFormats[0].itag);
      } else {
        document.getElementById("vtitle").textContent += " — No playable formats found";
      }

      // Load related videos
      fetchRelated(id);

    } catch (e) {
      document.getElementById("vtitle").textContent = "Error: " + e.message;
    }
  }

  function renderQuality(formats) {
    const row = document.getElementById("quality-row");
    row.innerHTML = formats.map(f =>
      \`<button class="quality-btn" onclick="selectFormat('\${f.itag}')" id="qbtn-\${f.itag}">\${f.label || f.itag}</button>\`
    ).join("");
  }

  function selectFormat(itag) {
    const player = document.getElementById("video-player");
    const t = player.currentTime;
    player.src = \`\${BASE}/stream?id=\${currentId}&itag=\${itag}\`;
    if (t > 0) player.currentTime = t;
    player.play().catch(() => {});
    // Highlight active
    document.querySelectorAll(".quality-btn").forEach(b => b.classList.remove("active"));
    const active = document.getElementById("qbtn-" + itag);
    if (active) active.classList.add("active");
  }

  async function fetchRelated(id) {
    try {
      const res = await fetch(\`\${BASE}/api/v1/videos/\${id}?fields=recommendedVideos\`);
      const json = await res.json();
      if (json.error || !json.data?.recommendedVideos) throw new Error("none");
      const grid = document.getElementById("related-grid");
      const items = json.data.recommendedVideos.slice(0, 12);
      if (!items.length) { grid.innerHTML = '<div class="status">No related videos.</div>'; return; }
      grid.innerHTML = items.map(v => {
        const thumb = v.videoThumbnails?.find(t => t.quality === "medium")?.url
          || v.videoThumbnails?.[0]?.url || "";
        return \`<div class="card" onclick="playVideo('\${v.videoId}')">
          <img class="card-thumb" src="\${thumb}" alt="" loading="lazy" onerror="this.style.background='#333'">
          <div class="card-body">
            <div class="card-title">\${v.title || "Untitled"}</div>
            <div class="card-meta">\${v.author || ""} · \${fmtDur(v.lengthSeconds)}</div>
          </div>
        </div>\`;
      }).join("");
    } catch {
      document.getElementById("related-grid").innerHTML = '<div class="status">Could not load related.</div>';
    }
  }

  // ─── Handle URL params (optional: ?v=videoId or ?q=query) ─────────────────
  (function init() {
    const p = new URLSearchParams(location.search);
    if (p.get("v")) playVideo(p.get("v"));
    else if (p.get("q")) {
      document.getElementById("q").value = p.get("q");
      doSearch();
    }
  })();
</script>
</body>
</html>
`;
