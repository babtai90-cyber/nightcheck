const map = L.map('map', { worldCopyJump: true }).setView([54.9, 23.9], 5);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const planeLayer = L.layerGroup().addTo(map);
const satelliteLayer = L.layerGroup().addTo(map);
const statusEl = document.getElementById('status');
const skyInfo = document.getElementById('skyInfo');
const canvas = document.getElementById('sky');
const ctx = canvas.getContext('2d');

let observer = { lat: 54.9, lon: 23.9 };
let stars = [];
let satelliteRecords = [];

const STAR_URL = 'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hyg_v41.csv';
const SATELLITE_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=STATIONS&FORMAT=TLE';

function setStatus(text) { statusEl.textContent = text; }

function csvLine(line) {
  const out = [];
  let value = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) { out.push(value); value = ''; }
    else value += c;
  }
  out.push(value);
  return out;
}

async function loadStars() {
  try {
    // HYG is a large catalog, so only keep naked-eye / named stars in memory.
    const response = await fetch(STAR_URL);
    if (!response.ok) throw new Error(`Star catalog HTTP ${response.status}`);
    const text = await response.text();
    const lines = text.split(/\r?\n/);
    const header = csvLine(lines.shift());
    const idx = Object.fromEntries(header.map((h, i) => [h, i]));
    stars = lines.map(csvLine).map(row => ({
      name: row[idx.proper] || row[idx.bf] || `HIP ${row[idx.hip]}`,
      ra: Number(row[idx.ra]),
      dec: Number(row[idx.dec]),
      mag: Number(row[idx.mag]),
      con: row[idx.con]
    })).filter(s => Number.isFinite(s.ra) && Number.isFinite(s.dec) && Number.isFinite(s.mag) && s.mag <= 6.5);
    skyInfo.textContent = `${stars.length.toLocaleString()} visible stars loaded from HYG`;
  } catch (error) {
    console.error(error);
    skyInfo.textContent = 'Star catalog could not be loaded';
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
      if (!lines[i + 1].startsWith('1 ') || !lines[i + 2].startsWith('2 ')) continue;
      satelliteRecords.push({ name: lines[i], line1: lines[i + 1], line2: lines[i + 2] });
    }
    updateSatellites();
  } catch (error) {
    console.error(error);
    setStatus('Satellite data unavailable');
  }
}

function updateSatellites() {
  satelliteLayer.clearLayers();
  const now = new Date();
  let shown = 0;
  for (const sat of satelliteRecords) {
    if (shown >= 500) break;
    try {
      const satrec = satellite.twoline2satrec(sat.line1, sat.line2);
      const pos = satellite.propagate(satrec, now);
      if (!pos.position) continue;
      const gmst = satellite.gstime(now);
      const geo = satellite.eciToGeodetic(pos.position, gmst);
      const lat = satellite.degreesLat(geo.latitude);
      const lon = satellite.degreesLong(geo.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      L.circleMarker([lat, lon], { radius: 4, className: 'sat-marker' })
        .bindTooltip(`🛰️ ${sat.name}`)
        .addTo(satelliteLayer);
      shown++;
    } catch (_) {}
  }
}

async function updateAircraft() {
  try {
    const response = await fetch('https://opensky-network.org/api/states/all');
    if (!response.ok) throw new Error(`Aircraft HTTP ${response.status}`);
    const data = await response.json();
    planeLayer.clearLayers();
    let shown = 0;
    for (const state of data.states || []) {
      const [icao, callsign, country, , , lon, lat, , , velocity, heading, , , geoAlt] = state;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (shown >= 1200) break;
      const label = (callsign || icao || 'Aircraft').trim();
      const marker = L.circleMarker([lat, lon], { radius: 4, className: 'plane-marker' });
      marker.bindTooltip(`✈️ ${label}<br>${country || 'Unknown'}<br>Altitude: ${geoAlt ? Math.round(geoAlt) + ' m' : '—'}`);
      marker.addTo(planeLayer);
      shown++;
    }
    setStatus(`${shown.toLocaleString()} aircraft · ${satelliteRecords.length.toLocaleString()} satellites`);
  } catch (error) {
    console.error(error);
    setStatus('Aircraft data unavailable — retrying');
  }
}

function julianDate(date) { return date.getTime() / 86400000 + 2440587.5; }
function lstDegrees(date, lon) {
  const jd = julianDate(date);
  const d = jd - 2451545.0;
  let gmst = 280.46061837 + 360.98564736629 * d;
  gmst = ((gmst % 360) + 360) % 360;
  return (gmst + lon) % 360;
}
function projectStar(star, date) {
  const raDeg = star.ra * 15;
  const hourAngle = ((lstDegrees(date, observer.lon) - raDeg + 540) % 360) - 180;
  const ha = hourAngle * Math.PI / 180;
  const dec = star.dec * Math.PI / 180;
  const lat = observer.lat * Math.PI / 180;
  const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(ha);
  const alt = Math.asin(sinAlt);
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat));
  return { alt, az: az + Math.PI, visible: alt > 0 };
}
function drawSky() {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#02040b'; ctx.fillRect(0, 0, w, h);
  const date = new Date();
  const cx = w / 2, cy = h * 0.55, radius = Math.min(w, h) * 0.44;
  ctx.strokeStyle = 'rgba(120,150,190,.18)';
  ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
  for (const star of stars) {
    const p = projectStar(star, date);
    if (!p.visible) continue;
    const r = radius * (Math.PI / 2 - p.alt) / (Math.PI / 2);
    const x = cx + Math.sin(p.az) * r;
    const y = cy - Math.cos(p.az) * r;
    if (x < 0 || x > w || y < 0 || y > h) continue;
    const size = Math.max(0.6, Math.min(4.5, 4.7 - star.mag * 0.55));
    ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fillStyle = 'white'; ctx.globalAlpha = Math.max(.35, 1 - star.mag / 8); ctx.fill();
  }
  ctx.globalAlpha = 1;
  skyInfo.textContent = `${stars.length.toLocaleString()} stars · ${observer.lat.toFixed(2)}°, ${observer.lon.toFixed(2)}° · ${date.toLocaleTimeString()}`;
}

document.getElementById('locateBtn').addEventListener('click', () => {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(pos => {
    observer = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    map.setView([observer.lat, observer.lon], 6);
    drawSky();
  });
});

loadStars();
loadSatellites();
updateAircraft();
drawSky();
setInterval(updateAircraft, 30000);
setInterval(updateSatellites, 60000);
setInterval(drawSky, 1000);
window.addEventListener('resize', drawSky);
