// ── Distance helpers ──────────────────────────────────────────────────────────

/**
 * Haversine distance between two GPS points (fallback).
 * @returns distance in metres
 */
function haversineMetres(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Human-readable distance string (e.g. "350 m" or "2.4 km"). */
function formatDistance(metres) {
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

/** Human-readable duration string (e.g. "3 min" or "1 hr 12 min"). */
function formatDuration(seconds) {
  if (seconds < 60) return `< 1 min`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs} hr ${rem} min` : `${hrs} hr`;
}

// ── OSRM Road Distance API ────────────────────────────────────────────────────

const OSRM_BASE = "https://router.project-osrm.org";
const API_TIMEOUT_MS = 12000;
// Overpass queries need a longer timeout — the server can be slow during peak hours
const OVERPASS_TIMEOUT_MS = 55000;
const MAX_RESULTS_PER_CATEGORY = 8;

async function fetchWithTimeout(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Retry a fetch-based function with exponential back-off.
 * @param {function} fn       — async function to retry
 * @param {number}   attempts — max attempts
 * @param {number}   delayMs  — base delay between retries (ms)
 */
async function withRetry(fn, attempts = 2, delayMs = 1500) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
      }
    }
  }
  throw lastErr;
}

/**
 * Fetch real road distances & durations from the user's location to
 * an array of places using the OSRM Table API (single HTTP request).
 * Mutates each place object in-place, adding distMetres, duration, dist fields.
 */
async function fetchRoadDistances(userLat, userLon, places) {
  if (!places.length) return places;

  const coords = [`${userLon},${userLat}`, ...places.map(p => `${p.lon},${p.lat}`)];
  const url =
    `${OSRM_BASE}/table/v1/driving/${coords.join(";")}` +
    `?sources=0&annotations=distance,duration`;

  const res = await fetchWithTimeout(url, {}, 1500);
  if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);

  const json = await res.json();
  if (json.code !== "Ok") throw new Error(`OSRM error: ${json.code}`);

  const distances = json.distances[0];
  const durations = json.durations[0];

  places.forEach((place, i) => {
    const d = distances[i + 1];
    const t = durations[i + 1];
    if (d != null && d > 0) {
      place.distMetres = d;
      place.duration   = t;
      place.dist       = `${formatDistance(d)} - ${formatDuration(t)} drive`;
    }
  });

  places.sort((a, b) => (a.distMetres ?? Infinity) - (b.distMetres ?? Infinity));
  return places;
}

// ── Overpass API ──────────────────────────────────────────────────────────────

// 4 mirrors so that if one is down or rate-limiting, the others are tried
const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

/**
 * Build Overpass QL for the specified amenity types.
 * @param {number}   lat
 * @param {number}   lon
 * @param {number}   radius    — search radius in metres
 * @param {string[]} amenities — e.g. ["hospital"], ["police"], or ["hospital","police"]
 */
function buildQuery(lat, lon, radius, amenities) {
  const stmts = amenities.flatMap(a => [
    `node["amenity"="${a}"](around:${radius},${lat},${lon});`,
    `way["amenity"="${a}"](around:${radius},${lat},${lon});`,
    ...(a === "hospital"
      ? [`relation["amenity"="${a}"](around:${radius},${lat},${lon});`]
      : []),
  ]);
  // timeout:55 tells the Overpass server to spend up to 55 s on the query
  return `[out:json][timeout:55];(${stmts.join("")});out center;`;
}

/**
 * Extract { name, lat, lon } from a raw Overpass element.
 * Haversine distance is computed as a fast fallback; the caller
 * should later enrich with real road distances via OSRM.
 */
function parseElement(el, userLat, userLon) {
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  const distMetres =
    lat != null && lon != null && userLat != null
      ? haversineMetres(userLat, userLon, lat, lon)
      : null;
  return {
    name: el.tags?.name || "Unnamed",
    lat,
    lon,
    distMetres,
    dist: distMetres != null ? `~${formatDistance(distMetres)}` : "Nearby",
  };
}

/**
 * Query Overpass for specific amenity types at a given radius.
 * Tries each mirror in turn, with 2 retry attempts per mirror.
 * @returns {{ hospitals: Array, police: Array }}
 */
async function fetchOverpass(lat, lon, radius, amenities) {
  const query = buildQuery(lat, lon, radius, amenities);
  let lastError;

  for (const baseUrl of OVERPASS_MIRRORS) {
    try {
      // Each mirror gets up to 2 attempts before we fall through to the next one
      const json = await withRetry(async () => {
        const fullUrl = baseUrl + "?data=" + encodeURIComponent(query);
        console.log("Overpass request:", fullUrl);
        const res = await fetchWithTimeout(fullUrl, {}, OVERPASS_TIMEOUT_MS);
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        return res.json();
      }, 2, 1500);

      const hospitals = [];
      const police    = [];

      for (const el of json.elements) {
        const place = parseElement(el, lat, lon);
        if (!place.lat || !place.lon) continue;
        if (el.tags?.amenity === "hospital") hospitals.push(place);
        if (el.tags?.amenity === "police")   police.push(place);
      }

      hospitals.sort((a, b) => (a.distMetres ?? Infinity) - (b.distMetres ?? Infinity));
      police.sort((a, b) => (a.distMetres ?? Infinity) - (b.distMetres ?? Infinity));

      console.log(`Overpass (${baseUrl}) — ${hospitals.length} hospitals, ${police.length} police`);
      return {
        hospitals: hospitals.slice(0, MAX_RESULTS_PER_CATEGORY),
        police: police.slice(0, MAX_RESULTS_PER_CATEGORY),
      };
    } catch (err) {
      console.warn(`Mirror failed (${baseUrl}):`, err.message);
      lastError = err;
    }
  }

  throw lastError ?? new Error("All Overpass mirrors failed — check your internet connection and try again.");
}

/** Radius steps to try (metres). */
const SEARCH_RADII = [3000, 5000, 10000, 20000];

/**
 * fetchNearbyPlaces(lat, lon, onStatus?)
 * Searches each category independently with progressive radius expansion.
 * Once a category is found it is locked in; only the missing category continues expanding.
 *
 * @param {number}   lat
 * @param {number}   lon
 * @param {function} [onStatus] — callback(message) for live UI updates
 * @returns {Promise<{ hospitals: Array, police: Array, searchedRadiusKm: number }>}
 */
async function fetchNearbyPlaces(lat, lon, onStatus) {
  let hospitals = [];
  let police    = [];
  let maxSearched = SEARCH_RADII[0];

  for (const radius of SEARCH_RADII) {
    const missing = [];
    if (!hospitals.length) missing.push("hospital");
    if (!police.length)    missing.push("police");

    if (!missing.length) break;

    const radiusKm = radius / 1000;
    const label = missing.map(a => a === "hospital" ? "hospitals" : "police stations").join(" & ");
    if (onStatus) onStatus(`Searching ${label} within ${radiusKm} km...`);
    console.log(`${radiusKm} km — looking for: ${missing.join(", ")}`);

    try {
      const result = await fetchOverpass(lat, lon, radius, missing);

      if (!hospitals.length && result.hospitals.length) {
        hospitals = result.hospitals;
        console.log(`Hospitals locked in at ${radiusKm} km (${hospitals.length} found)`);
      }
      if (!police.length && result.police.length) {
        police = result.police;
        console.log(`Police locked in at ${radiusKm} km (${police.length} found)`);
      }
    } catch (err) {
      console.warn(`All mirrors failed at ${radius}m:`, err.message);
    }

    maxSearched = radius;
  }

  return { hospitals, police, searchedRadiusKm: maxSearched / 1000 };
}

// ── Geolocation ───────────────────────────────────────────────────────────────

const LOCATION_KEY = "roadsos-last-location";

function readCachedLocation(maxAgeMs, maxAccuracy = Infinity) {
  try {
    const cached = JSON.parse(localStorage.getItem(LOCATION_KEY) || "null");
    if (!cached || Date.now() - cached.savedAt > maxAgeMs) return null;
    if ((cached.accuracy ?? Infinity) > maxAccuracy) return null;
    return cached;
  } catch {
    return null;
  }
}

function saveLocation(location) {
  localStorage.setItem(LOCATION_KEY, JSON.stringify({
    ...location,
    savedAt: Date.now(),
  }));
}

function getUserLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject("Geolocation is not supported by your browser.");
      return;
    }

    // Note: file:// pages are treated as secure contexts in modern browsers,
    // so we do NOT block them here.

    const freshCache = readCachedLocation(30 * 1000, 500);
    if (freshCache) {
      resolve(freshCache);
      return;
    }

    const LOCATION_WAIT_MS = 8000;
    let settled = false;
    let watchId = null;
    let bestFix = null;
    const options = {
      enableHighAccuracy: false,
      timeout: LOCATION_WAIT_MS,
      maximumAge: 0,
    };

    function cleanup() {
      if (watchId != null) {
        navigator.geolocation.clearWatch(watchId);
      }
    }

    function toLocation(pos) {
      return {
        lat:      pos.coords.latitude,
        lon:      pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      };
    }

    function finishWithLocation(location) {
      if (settled) return;
      settled = true;
      cleanup();
      saveLocation(location);
      resolve(location);
    }

    function finishWithError(error) {
      if (settled) return;
      settled = true;
      cleanup();
      const messages = {
        1: "Location permission denied. Please allow location access and try again.",
        2: "Location unavailable. Turn on device location/GPS and try again.",
        3: "Location is taking too long. Please turn on location services and try again.",
      };
      reject(messages[error.code] || "Could not detect your location. Please try again.");
    }

    function rememberPosition(pos) {
      const location = toLocation(pos);
      if (!bestFix || location.accuracy < bestFix.accuracy) {
        bestFix = location;
      }
      finishWithLocation(location);
    }

    watchId = navigator.geolocation.watchPosition(
      rememberPosition,
      (error) => {
        if (error.code === 1) {
          finishWithError(error);
          return;
        }
        if (bestFix) {
          finishWithLocation(bestFix);
        }
      },
      options
    );

    navigator.geolocation.getCurrentPosition(
      rememberPosition,
      (error) => {
        if (error.code === 1) {
          finishWithError(error);
          return;
        }
        if (bestFix) {
          finishWithLocation(bestFix);
        }
      },
      options
    );

    setTimeout(() => {
      if (bestFix) {
        finishWithLocation(bestFix);
        return;
      }
      finishWithError({ code: 3 });
    }, LOCATION_WAIT_MS);
  });
}

/** Reverse-geocode coordinates to a human-readable address via Nominatim. */
async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
  const res  = await fetch(url, { headers: { "Accept-Language": "en" } });
  const json = await res.json();
  return json.display_name || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

// ── Static fallback (ambulance — not in Overpass reliably) ────────────────────

const AMBULANCE_DATA = [
  { name: "National Ambulance 108", dist: "On-call", phone: "tel:108" },
  { name: "RedCross Emergency",     dist: "On-call",  phone: "tel:+1800004444" },
];

// ── UI ────────────────────────────────────────────────────────────────────────

const THEME_KEY = "roadsos-theme";
let activeSearchId = 0;

function applyTheme(theme) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  const toggle = document.getElementById("theme-toggle");

  document.documentElement.dataset.theme = nextTheme;
  localStorage.setItem(THEME_KEY, nextTheme);

  if (toggle) {
    const nextLabel = nextTheme === "dark" ? "Light" : "Dark";
    toggle.textContent = nextLabel;
    toggle.setAttribute("aria-label", `Switch to ${nextLabel.toLowerCase()} theme`);
  }
}

function resetHome() {
  activeSearchId += 1;
  document.getElementById("loader").classList.remove("is-active");
  document.getElementById("status").textContent = "";
  document.getElementById("status").style.color = "";
  document.getElementById("results").style.display = "none";
  document.getElementById("hospitals-list").innerHTML = "";
  document.getElementById("police-list").innerHTML = "";
  document.getElementById("ambulance-list").innerHTML = "";
  document.getElementById("find-btn").disabled = false;
  // Remove any leftover retry button
  const old = document.getElementById("retry-inline-btn");
  if (old) old.remove();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

applyTheme(localStorage.getItem(THEME_KEY) || "dark");

document.getElementById("theme-toggle").addEventListener("click", () => {
  const currentTheme = document.documentElement.dataset.theme;
  applyTheme(currentTheme === "dark" ? "light" : "dark");
});

document.getElementById("home-btn").addEventListener("click", resetHome);

function buildCards(listId, items, userLat, userLon) {
  const container = document.getElementById(listId);
  container.innerHTML = "";
  items.forEach(item => {
    const card = document.createElement("div");
    card.className = "card";

    const hasCoords = item.lat != null && item.lon != null && userLat != null;
    const mapsUrl = hasCoords
      ? `https://www.google.com/maps/dir/?api=1`
        + `&origin=${userLat},${userLon}`
        + `&destination=${encodeURIComponent(item.name)}+@${item.lat},${item.lon}`
        + `&travelmode=driving`
      : null;

    card.innerHTML = `
      <div class="card-info">
        <div class="name">${item.name}</div>
        <div class="dist">Location: ${item.dist ?? "Nearby"}</div>
      </div>
      <div class="card-actions">
        ${mapsUrl
          ? `<a class="card-nav" href="${mapsUrl}" target="_blank" rel="noopener">Navigate</a>`
          : ""}
        <a class="card-call" href="${item.phone ?? "#"}">Call</a>
      </div>
    `;
    container.appendChild(card);
  });
}

document.getElementById("find-btn").addEventListener("click", async () => {
  const searchId = activeSearchId + 1;
  activeSearchId = searchId;
  const btn    = document.getElementById("find-btn");
  const status = document.getElementById("status");
  const loader = document.getElementById("loader");

  // Remove any previous retry button
  const oldRetry = document.getElementById("retry-inline-btn");
  if (oldRetry) oldRetry.remove();

  btn.disabled       = true;
  loader.classList.add("is-active");
  status.style.color = "";
  status.textContent = "Detecting your location... please allow location access.";

  try {
    // 1. Get best available GPS fix
    const { lat, lon, accuracy } = await getUserLocation();
    if (searchId !== activeSearchId) return;
    status.textContent = `Location found (+/-${Math.round(accuracy)}m). Searching nearby...`;

    const addressPromise = reverseGeocode(lat, lon).catch(() => `${lat.toFixed(5)}, ${lon.toFixed(5)}`);

    // 2. Fetch nearby places (hospitals & police)
    const { hospitals, police, searchedRadiusKm } = await fetchNearbyPlaces(
      lat, lon,
      (msg) => {
        if (searchId === activeSearchId) {
          status.textContent = msg;
        }
      }
    );

    if (searchId !== activeSearchId) return;

    // 3. Render immediately using fast straight-line distances
    buildCards("hospitals-list", hospitals.length
      ? hospitals
      : [{ name: `No hospitals found within ${searchedRadiusKm} km`, dist: "Nearby" }], lat, lon);

    buildCards("police-list", police.length
      ? police
      : [{ name: `No police stations found within ${searchedRadiusKm} km`, dist: "Nearby" }], lat, lon);

    buildCards("ambulance-list", AMBULANCE_DATA);

    document.getElementById("results").style.display = "flex";
    loader.classList.remove("is-active");
    status.textContent = `Showing nearest results (+/-${Math.round(accuracy)}m accuracy).`;

    addressPromise.then((address) => {
      if (searchId === activeSearchId) {
        status.textContent = `${address} (+/-${Math.round(accuracy)}m)`;
      }
    });

    // 4. Improve displayed distances in the background via OSRM
    Promise.all([
      hospitals.length ? fetchRoadDistances(lat, lon, hospitals) : Promise.resolve(),
      police.length    ? fetchRoadDistances(lat, lon, police)   : Promise.resolve(),
    ]).then(() => {
      if (searchId !== activeSearchId) return;
      buildCards("hospitals-list", hospitals.length
        ? hospitals
        : [{ name: `No hospitals found within ${searchedRadiusKm} km`, dist: "Nearby" }], lat, lon);
      buildCards("police-list", police.length
        ? police
        : [{ name: `No police stations found within ${searchedRadiusKm} km`, dist: "Nearby" }], lat, lon);
    }).catch((err) => {
      console.warn("OSRM failed, keeping straight-line distances:", err.message);
    });

  } catch (err) {
    console.error("Error:", err);

    // Show a friendly message based on the error type
    const msg = String(err.message || err);
    let userMsg = `Error: ${msg}`;
    if (msg.includes("denied") || msg.includes("permission")) {
      userMsg = "Location access denied. Enable it in your browser, then try again.";
    } else if (msg.includes("mirrors failed") || msg.includes("HTTP")) {
      userMsg = "Map data servers are busy. Wait a moment and try again.";
    } else if (msg.includes("timeout") || msg.includes("abort") || msg.includes("timed out")) {
      userMsg = "Connection timed out. Check your internet and try again.";
    } else if (msg.includes("unavailable")) {
      userMsg = "Location unavailable. Turn on GPS and try again.";
    }

    status.textContent = userMsg;
    status.style.color = "var(--danger)";

    // Show an inline retry button so the user doesn't have to refresh
    if (!document.getElementById("retry-inline-btn")) {
      const retryBtn = document.createElement("button");
      retryBtn.id = "retry-inline-btn";
      retryBtn.textContent = "Try again";
      retryBtn.style.cssText =
        "margin-top:14px;padding:10px 28px;border:none;border-radius:8px;" +
        "background:var(--danger);color:#fff;font-size:0.95rem;font-weight:600;cursor:pointer;";
      retryBtn.addEventListener("click", () => {
        retryBtn.remove();
        document.getElementById("find-btn").click();
      });
      status.insertAdjacentElement("afterend", retryBtn);
    }
  } finally {
    if (searchId === activeSearchId) {
      loader.classList.remove("is-active");
      btn.disabled = false;
    }
  }
});
