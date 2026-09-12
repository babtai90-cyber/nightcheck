const DEFAULT_OBSERVER = { lat: 54.9, lon: 23.9 };
const map = L.map('map', { worldCopyJump: true, zoomControl: true }).setView([DEFAULT_OBSERVER.lat, DEFAULT_OBSERVER.lon], 5);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);

const planeLayer = L.layerGroup().addTo(map);
const satelliteLayer = L.layerGroup().addTo(map);
const statusEl = document.getElementById('status');
const skyInfo = document.getElementById('skyInfo');
const aircraftCountEl = document.getElementById('aircraftCount');
const satelliteCountEl = document.getElementById('satelliteCount');
const starCountEl = document.getElementById('starCount');
const coordsEl = document.getElementById('coords');
const canvas = document.getElementById('sky');
const ctx = canvas.getContext('2d');

let observer = { ...DEFAULT_OBSERVER };
let stars = [];
let satelliteRecords = [];

const STAR_URL = 'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hyg_v41.csv';
const SATELLITE_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=ACTIVE&FORMAT=TLE';
const AIRCRAFT_URL = 'https://opensky-network.org/api/states/all';

function setStatus(text) { statusEl.textContent = text; }
function setCoords() { coordsEl.textContent = `${observer.lat.toFixed(2)}°, ${observer.lon.toFixed(2)}°`; }

function csvLine(line) {
  const out = []; let value = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) { out.push(value); value = ''; }
    else value += c;
  }
  out.push(value); return out;
}

async function loadStars() {
  try {
    const response = await fetch(STAR_URL);
    if (!response.ok) throw new Error(`Stars HTTP ${response.status}`);
    const text = await response.text();
    const lines = text.split(/\r?\n/);
    const header = csvLine(lines.shift());
    const idx = Object.fromEntries(header.map((h, i) => [h, i]));
    stars = lines.map(csvLine).map(row => ({
      name: row[idx.proper] || row[idx.bf] || `HIP ${row[idx.hip]}`,
      ra: Number(row[idx.ra]), dec: Number(row[idx.dec]), mag: Number(row[idx.mag]), con: row[idx.con]
    })).filter(s => Number.isFinite(s.ra) && Number.isFinite(s.dec) && Number.isFinite(s.mag) && s.mag <= 6.5);
    starCountEl.textContent = stars.length.toLocaleString();
    drawSky();
  } catch (error) {
    console.error(error); skyInfo.textContent = 'Star catalog unavailable'; starCountEl.textContent = '—';
  }
}

async function loadSatellites() {
  try {
    const response = await fetch(SATELLITE_URL);
    if (!response.ok) throw new Error(`Satellite HTTP ${response.status}`);
    const text = await response.text();
    const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    satelliteRecords = [];
    for (let i = 0; i + 2 < lines.length; i += 3) {
      if (lines[i + 1].startsWith('1 ') && lines[i + 2].startsWith('2 ')) {
        satelliteRecords.push({ name: lines[i], line1: lines[i + 1], line2: lines[i + 2] });
      }
    }
    satelliteCountEl.textContent = satelliteRecords.length.toLocaleString();
    updateSatellites();
  } catch (error) {
    console.error(error); satelliteCountEl.textContent = '—'; setStatus('Satellite data unavailable');
  }
}

function updateSatellites() {
  satelliteLayer.clearLayers();
  const now = new Date(); let shown = 0;
  for (const sat of satelliteRecords) {
    if (shown >= 1200) break;
    try {
      const satrec = satellite.twoline2satrec(sat.line1, sat.line2);
      const pos = satellite.propagate(satrec, now);
      if (!pos.position) continue;
      const geo = satellite.eciToGeodetic(pos.position, satellite.gstime(now));
      const lat = satellite.degreesLat(geo.latitude), lon = satellite.degreesLong(geo.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      L.circleMarker([lat, lon], { radius: 3.5, weight: 1, color: '#c084fc', fillColor: '#c084fc', fillOpacity: .8, className: 'sat-marker' })
        .bindTooltip(`🛰️ ${sat.name}`)
        .addTo(satelliteLayer);
      shown++;
    } catch (_) {}
  }
}

async function updateAircraft() {
  try {
    const response = await fetch(AIRCRAFT_URL);
    if (!response.ok) throw new Error(`Aircraft HTTP ${response.status}`);
    const data = await response.json();
    planeLayer.clearLayers(); let shown = 0;
    for (const state of data.states || []) {
      const [icao, callsign, country, , , lon, lat, , , velocity, heading, , , geoAlt] = state;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || shown >= 1200) continue;
      const label = (callsign || icao || 'Aircraft').trim();
      const marker = L.circleMarker([lat, lon], { radius: 4, weight: 1, color: '#60a5fa', fillColor: '#60a5fa', fillOpacity: .95, className: 'plane-marker' });
      const altitude = Number.isFinite(geoAlt) ? `${Math.round(geoAlt).toLocaleString()} m` : '—';
      const speed = Number.isFinite(velocity) ? `${Math.round(velocity * 3.6)} km/h` : '—';
      const direction = Number.isFinite(heading) ? `${Math.round(heading)}°` : '—';
      marker.bindTooltip(`✈️ <b>${label}</b><br>${country || 'Unknown'}<br>Altitude: ${altitude}<br>Speed: ${speed} · Heading: ${direction}`);
      marker.addTo(planeLayer); shown++;
    }
    aircraftCountEl.textContent = shown.toLocaleString();
    setStatus(`${shown.toLocaleString()} aircraft · live`);
  } catch (error) {
    console.error(error); aircraftCountEl.textContent = '—'; setStatus('Aircraft data unavailable · retrying');
  }
}

function julianDate(date) { return date.getTime() / 86400000 + 2440587.5; }
function lstDegrees(date, lon) { let gmst = 280.46061837 + 360.98564736629 * (julianDate(date) - 2451545); gmst = ((gmst % 360) + 360) % 360; return (gmst + lon) % 360; }
function projectStar(star, date) {
  const ha = (((lstDegrees(date, observer.lon) - star.ra * 15 + 540) % 360) - 180) * Math.PI / 180;
  const dec = star.dec * Math.PI / 180, lat = observer.lat * Math.PI / 180;
  const alt = Math.asin(Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(ha));
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)) + Math.PI;
  return { alt, az, visible: alt > 0 };
}

function drawSky() {
  const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = w * dpr; canvas.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const gradient = ctx.createRadialGradient(w * .5, h * .42, 0, w * .5, h * .55, Math.max(w, h) * .7);
  gradient.addColorStop(0, '#111b3a'); gradient.addColorStop(.5, '#070d20'); gradient.addColorStop(1, '#02040b');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
  const date = new Date(), cx = w / 2, cy = h * .55, radius = Math.min(w, h) * .44;
  ctx.strokeStyle = 'rgba(148,163,184,.16)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
  for (const star of stars) {
    const p = projectStar(star, date); if (!p.visible) continue;
    const r = radius * (Math.PI / 2 - p.alt) / (Math.PI / 2), x = cx + Math.sin(p.az) * r, y = cy - Math.cos(p.az) * r;
    if (x < 0 || x > w || y < 0 || y > h) continue;
    const size = Math.max(.55, Math.min(4.8, 4.9 - star.mag * .58));
    ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.globalAlpha = Math.max(.25, 1 - star.mag / 8); ctx.fill();
  }
  ctx.globalAlpha = 1;
  skyInfo.textContent = `${stars.length.toLocaleString()} stars · ${observer.lat.toFixed(2)}°, ${observer.lon.toFixed(2)}° · ${date.toLocaleTimeString()}`;
}

document.getElementById('locateBtn').addEventListener('click', () => {
  if (!navigator.geolocation) return;
  setStatus('Requesting location…');
  navigator.geolocation.getCurrentPosition(pos => {
    observer = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    setCoords(); map.setView([observer.lat, observer.lon], 6); drawSky(); setStatus('Location set · live');
  }, () => setStatus('Location permission denied'));
});

setCoords(); loadStars(); loadSatellites(); updateAircraft(); drawSky();
setInterval(updateAircraft, 30000);
setInterval(updateSatellites, 120000);
setInterval(drawSky, 1000);
window.addEventListener('resize', drawSky);
