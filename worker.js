const BASE = location.origin;

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
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
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

function goHome() {
  document.getElementById("player-section").classList.remove("visible");
  document.getElementById("results-section").style.display = "";
  document.getElementById("q").value = "";
  setStatus('<div style="font-size:2.5rem;margin-bottom:12px">▶</div>Search for any video to get started.');
  document.getElementById("results-grid").style.display = "none";
  history.pushState({}, "", "/");
}

async function doSearch() {
  const q = document.getElementById("q").value.trim();
  if (!q) return;

  document.getElementById("player-section").classList.remove("visible");
  document.getElementById("results-section").style.display = "";
  loading();

  try {
    const res = await fetch(`${BASE}/api/v1/search?q=${encodeURIComponent(q)}&type=video&fields=videoId,title,author,viewCount,lengthSeconds,videoThumbnails`);
    const json = await res.json();
    if (json.error) throw new Error(json.error);

    setBadge(json.instance);
    renderResults(json.data, document.getElementById("results-grid"));
  } catch (e) {
    setStatus(`<div class="err">Search failed: ${e.message}</div>`);
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
    return `<div class="card" onclick="playVideo('${v.videoId}')">
      <img class="card-thumb" src="${thumb}" alt="" loading="lazy" onerror="this.style.background='#333'">
      <div class="card-body">
        <div class="card-title">${v.title || "Untitled"}</div>
        <div class="card-meta">${v.author || ""} · ${fmtDur(v.lengthSeconds)}</div>
      </div>
    </div>`;
  }).join("");
}

let currentId = null;
let currentFormats = [];
let currentInstance = "";

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
    const res = await fetch(`${BASE}/formats?id=${id}`);
    const info = await res.json();
    if (info.error) throw new Error(info.error);

    setBadge(info.instance);
    currentInstance = info.instance;

    document.getElementById("vtitle").textContent = info.title || "Unknown title";
    document.getElementById("vauthor").textContent = info.author || "";
    document.getElementById("vviews").textContent = fmtNum(info.viewCount);
    document.getElementById("vlen").textContent = fmtDur(info.lengthSeconds);
    document.getElementById("vdesc").textContent = info.description || "";

    currentFormats = info.formats || [];
    renderQuality(currentFormats);

    if (currentFormats.length) {
      selectFormat(currentFormats[0].itag);
    } else {
      document.getElementById("vtitle").textContent += " — No playable formats found";
    }

    fetchRelated(id);

  } catch (e) {
    document.getElementById("vtitle").textContent = "Error: " + e.message;
  }
}

function renderQuality(formats) {
  const row = document.getElementById("quality-row");
  row.innerHTML = formats.map(f =>
    `<button class="quality-btn" onclick="selectFormat('${f.itag}')" id="qbtn-${f.itag}">${f.label || f.itag}</button>`
  ).join("");
}

function selectFormat(itag) {
  const player = document.getElementById("video-player");
  const t = player.currentTime;
  
  player.src = `${BASE}/stream?id=${currentId}&itag=${itag}&inst=${encodeURIComponent(currentInstance)}`;
  
  if (t > 0) player.currentTime = t;
  player.play().catch(() => {});
  
  document.querySelectorAll(".quality-btn").forEach(b => b.classList.remove("active"));
  const active = document.getElementById("qbtn-" + itag);
  if (active) active.classList.add("active");
}

async function fetchRelated(id) {
  try {
    const res = await fetch(`${BASE}/api/v1/videos/${id}?fields=recommendedVideos`);
    const json = await res.json();
    if (json.error || !json.data?.recommendedVideos) throw new Error("none");
    const grid = document.getElementById("related-grid");
    const items = json.data.recommendedVideos.slice(0, 12);
    if (!items.length) { grid.innerHTML = '<div class="status">No related videos.</div>'; return; }
    grid.innerHTML = items.map(v => {
      const thumb = v.videoThumbnails?.find(t => t.quality === "medium")?.url
        || v.videoThumbnails?.[0]?.url || "";
      return `<div class="card" onclick="playVideo('${v.videoId}')">
        <img class="card-thumb" src="${thumb}" alt="" loading="lazy" onerror="this.style.background='#333'">
        <div class="card-body">
          <div class="card-title">${v.title || "Untitled"}</div>
          <div class="card-meta">${v.author || ""} · ${fmtDur(v.lengthSeconds)}</div>
        </div>
      </div>`;
    }).join("");
  } catch {
    document.getElementById("related-grid").innerHTML = '<div class="status">Could not load related.</div>';
  }
}

(function init() {
  const p = new URLSearchParams(location.search);
  if (p.get("v")) playVideo(p.get("v"));
  else if (p.get("q")) {
    document.getElementById("q").value = p.get("q");
    doSearch();
  }
})();
