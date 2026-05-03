// ── Distance helpers ──────────────────────────────────────────────────────────

/**
 * Haversine distance between two GPS points (fallback).
 * @returns distance in metres
 */
function haversineMetres(lat1, lon1, lat2, lon2) {
  const R = 6_371_000; // Earth radius in metres
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

// ── OSRM Road Distance API ───────────────────────────────────────────────────

const OSRM_BASE = "https://router.project-osrm.org";

/**
 * Fetch real road distances & durations from the user's location to
 * an array of places using the OSRM Table API (single HTTP request).
 * Mutates each place object in-place, adding distMetres, duration, dist fields.
 *
 * @param {number} userLat
 * @param {number} userLon
 * @param {Array} places — array of { name, lat, lon, ... }
 * @returns {Promise<Array>} the same array, enriched with road distances
 */
async function fetchRoadDistances(userLat, userLon, places) {
  if (!places.length) return places;

  // Build coordinate string: source first, then all destinations
  // OSRM uses lon,lat order (GeoJSON convention)
  const coords = [`${userLon},${userLat}`, ...places.map(p => `${p.lon},${p.lat}`)];
  const url =
    `${OSRM_BASE}/table/v1/driving/${coords.join(";")}` +
    `?sources=0&annotations=distance,duration`;

  console.log("🛣️  OSRM Table request:", url);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);

  const json = await res.json();
  if (json.code !== "Ok") throw new Error(`OSRM error: ${json.code}`);

  // distances[0] and durations[0] are arrays from source (index 0) to each dest
  const distances = json.distances[0]; // metres (float)
  const durations = json.durations[0]; // seconds (float)

  places.forEach((place, i) => {
    const d = distances[i + 1]; // +1 because index 0 is source→source
    const t = durations[i + 1];
    if (d != null && d > 0) {
      place.distMetres = d;
      place.duration   = t;
      place.dist       = `${formatDistance(d)}  •  🚗 ${formatDuration(t)}`;
    }
  });

  // Re-sort by road distance
  places.sort((a, b) => (a.distMetres ?? Infinity) - (b.distMetres ?? Infinity));
  return places;
}

// ── Overpass API ──────────────────────────────────────────────────────────────

const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/**
 * Build Overpass QL for the specified amenity types.
 * @param {number}   lat
 * @param {number}   lon
 * @param {number}   radius   — search radius in metres
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
  return `[out:json][timeout:30];(${stmts.join("")});out center;`;
}

/**
 * Extract { name, lat, lon } from a raw Overpass element.
 * Haversine distance is computed as a fast fallback; the caller
 * should later enrich with real road distances via OSRM.
 */
function parseElement(el, userLat, userLon) {
  const lat = el.lat  ?? el.center?.lat;
  const lon = el.lon  ?? el.center?.lon;
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
 * Tries each mirror in turn.
 * @returns {{ hospitals: Array, police: Array }}
 */
async function fetchOverpass(lat, lon, radius, amenities) {
  const query   = buildQuery(lat, lon, radius, amenities);
  let lastError;

  for (const baseUrl of OVERPASS_MIRRORS) {
    try {
      const fullUrl = baseUrl + "?data=" + encodeURIComponent(query);
      console.log("🔗 Overpass request:", fullUrl);

      const res = await fetch(fullUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

      const json      = await res.json();
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

      console.log(`✅ Overpass (${baseUrl}) — ${hospitals.length} hospitals, ${police.length} police`);
      return { hospitals, police };
    } catch (err) {
      console.warn(`⚠️ Mirror failed (${baseUrl}):`, err.message);
      lastError = err;
    }
  }
  throw lastError ?? new Error("All Overpass mirrors failed");
}

/** Radius steps to try (metres). */
const SEARCH_RADII = [3000, 5000, 10000, 20000];

/**
 * fetchNearbyPlaces(lat, lon, onStatus?)
 * Searches each category independently with progressive radius expansion.
 * Once a category is found it is locked in; only the missing category
 * continues expanding.
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
    // Determine which categories still need results
    const missing = [];
    if (!hospitals.length) missing.push("hospital");
    if (!police.length)    missing.push("police");

    // Both found → done
    if (!missing.length) break;

    const radiusKm = radius / 1000;
    const label = missing.map(a => a === "hospital" ? "hospitals" : "police stations").join(" & ");
    if (onStatus) onStatus(`Searching ${label} within ${radiusKm} km…`);
    console.log(`🔍 ${radiusKm} km — looking for: ${missing.join(", ")}`);

    try {
      const result = await fetchOverpass(lat, lon, radius, missing);

      // Merge results only for categories we were still missing
      if (!hospitals.length && result.hospitals.length) {
        hospitals = result.hospitals;
        console.log(`🏥 Hospitals locked in at ${radiusKm} km (${hospitals.length} found)`);
      }
      if (!police.length && result.police.length) {
        police = result.police;
        console.log(`👮 Police locked in at ${radiusKm} km (${police.length} found)`);
      }
    } catch (err) {
      console.warn(`⚠️ All mirrors failed at ${radius}m:`, err.message);
    }

    maxSearched = radius;
  }

  return { hospitals, police, searchedRadiusKm: maxSearched / 1000 };
}

// ── Geolocation ───────────────────────────────────────────────────────────────

/**
 * getUserLocation()
 * Uses watchPosition to collect fixes for up to WATCH_MS milliseconds,
 * then picks the one with the best (lowest) accuracy value.
 * Falls back to the first fix immediately if the device reports it is precise enough.
 *
 * @returns {Promise<{ lat: number, lon: number, accuracy: number }>}
 */
function getUserLocation(WATCH_MS = 6000, GOOD_ACCURACY_M = 50) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject("Geolocation is not supported by your browser.");
      return;
    }

    const fixes = [];
    let watchId;
    let settled = false;

    function finish() {
      if (settled) return;
      settled = true;
      navigator.geolocation.clearWatch(watchId);

      if (!fixes.length) {
        reject("No location fix received. Try again.");
        return;
      }

      // Pick the most accurate fix (lowest accuracy radius = best)
      fixes.sort((a, b) => a.accuracy - b.accuracy);
      const best = fixes[0];
      console.log(`📍 Best fix — lat: ${best.lat}, lon: ${best.lon}, accuracy: ±${Math.round(best.accuracy)}m`);
      resolve(best);
    }

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const fix = {
          lat:      pos.coords.latitude,
          lon:      pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };
        fixes.push(fix);
        console.log(`📡 Fix received — accuracy: ±${Math.round(fix.accuracy)}m`);

        // Resolve immediately if accuracy is already good enough
        if (fix.accuracy <= GOOD_ACCURACY_M) finish();
      },
      (error) => {
        const messages = {
          1: "Location permission denied. Please allow access and try again.",
          2: "Location unavailable. Check your device's GPS or network.",
          3: "Location request timed out. Please try again.",
        };
        if (!fixes.length) reject(messages[error.code] || "Unknown location error.");
        else finish();  // use what we have
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );

    // Collect fixes for WATCH_MS then take the best one
    setTimeout(finish, WATCH_MS);
  });
}

/** Reverse-geocode coordinates to a human-readable address via Nominatim. */
async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
  const res  = await fetch(url, { headers: { "Accept-Language": "en" } });
  const json = await res.json();
  return json.display_name || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

// ── Static fallback (ambulance — not in Overpass reliably) ───────────────────

const AMBULANCE_DATA = [
  { name: "National Ambulance 108", dist: "On-call", phone: "tel:108" },
  { name: "RedCross Emergency",     dist: "—",       phone: "tel:+1800004444" },
];

// ── UI ────────────────────────────────────────────────────────────────────────

/**
 * @param {string} listId   – DOM container id
 * @param {Array}  items    – place objects
 * @param {number} [userLat] – user GPS lat (enables Navigate button)
 * @param {number} [userLon] – user GPS lon
 */
function buildCards(listId, items, userLat, userLon) {
  const container = document.getElementById(listId);
  container.innerHTML = "";
  items.forEach(item => {
    const card = document.createElement("div");
    card.className = "card";

    // Build Google Maps directions URL from user location → destination
    // Uses the official Maps URLs API with the place name so Google snaps to the real location
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
        <div class="dist">📍 ${item.dist ?? "Nearby"}</div>
      </div>
      <div class="card-actions">
        ${mapsUrl
          ? `<a class="card-nav" href="${mapsUrl}" target="_blank" rel="noopener">🧭 Navigate</a>`
          : ""}
        <a class="card-call" href="${item.phone ?? "#"}">📞 Call</a>
      </div>
    `;
    container.appendChild(card);
  });
}

document.getElementById("find-btn").addEventListener("click", async () => {
  const btn    = document.getElementById("find-btn");
  const status = document.getElementById("status");

  btn.disabled       = true;
  status.style.color = "#aaa";
  status.textContent = "Acquiring GPS fix… (up to 6 s)";

  try {
    // 1. Get best available GPS fix
    const { lat, lon, accuracy } = await getUserLocation();
    status.textContent = `Locating… (±${Math.round(accuracy)}m accuracy)`;

    // 2. Reverse-geocode for a readable label
    const address = await reverseGeocode(lat, lon);
    console.log(`🗺️  Address: ${address}`);
    status.textContent = `📍 ${address} (±${Math.round(accuracy)}m)`;

    // 3. Fetch live data from Overpass (progressive per-category radius)
    status.textContent += " — searching nearby…";
    const { hospitals, police, searchedRadiusKm } = await fetchNearbyPlaces(
      lat, lon,
      (msg) => { status.textContent = `📍 ${address} — ${msg}`; }
    );

    // 4. Fetch real road distances from OSRM
    status.textContent = `📍 ${address} — calculating road distances…`;
    try {
      await Promise.all([
        hospitals.length ? fetchRoadDistances(lat, lon, hospitals) : Promise.resolve(),
        police.length    ? fetchRoadDistances(lat, lon, police)   : Promise.resolve(),
      ]);
      console.log("🛣️  Road distances fetched via OSRM");
    } catch (err) {
      console.warn("⚠️ OSRM failed, using straight-line distances:", err.message);
    }

    // 5. Render cards (pass user coords for Navigate links)
    buildCards("hospitals-list", hospitals.length
      ? hospitals
      : [{ name: `No hospitals found within ${searchedRadiusKm} km`, dist: "—" }], lat, lon);

    buildCards("police-list", police.length
      ? police
      : [{ name: `No police stations found within ${searchedRadiusKm} km`, dist: "—" }], lat, lon);

    buildCards("ambulance-list", AMBULANCE_DATA);

    document.getElementById("results").style.display = "flex";
    status.textContent = `📍 ${address} (±${Math.round(accuracy)}m)`;

  } catch (err) {
    console.error("Error:", err);
    status.textContent = `⚠️ ${err}`;
    status.style.color = "#ff6b6b";
  } finally {
    btn.disabled = false;
  }
});
