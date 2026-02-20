/**
 * Оценка пешего маршрута — 2GIS MapGL JS + Routing API
 *
 * Формула оценки (макс 10 баллов):
 *   A (время)      — макс 4 балла
 *   B (безопасность) — макс 3 балла
 *   C (качество)   — макс 3 балла
 *   D (штраф автодороги) — -0.5 за каждый переход через дорогу
 *   E (штраф переходы)   — -0.3 регулируемый, -0.5 нерегулируемый
 */

const API_KEY = 'bc9d537e-6e92-4751-9017-fe5c28958f30';

// Все запросы к 2GIS идут через Symfony-прокси (решает CORS)
const ROUTING_URL  = '/api/routing';
const SUGGEST_URL  = '/api/suggest';
const GEOCODE_URL  = '/api/geocode';

// State
let map;
let storeMarker    = null;
let homeMarker     = null;
let routePolylines = [];
let crossingMarkers = [];
let storeCoords = null;
let homeCoords  = null;
let currentRouteData = null;

// ─────────────────────────────────────────
// MapGL dynamic loader
// ─────────────────────────────────────────

let mapGLReady = false;

function loadMapGLScript() {
    return new Promise((resolve, reject) => {
        // Already loaded by a previous call
        if (window.mapgl && window.mapgl.Map) {
            resolve();
            return;
        }

        const script = document.createElement('script');
        script.src = `https://mapgl.2gis.com/api/js?key=${API_KEY}`;

        script.onload = () => {
            // Some builds of MapGL expose mapgl.load() for async module init
            if (typeof window.mapgl?.load === 'function') {
                window.mapgl.load().then(resolve).catch(reject);
            } else {
                resolve();
            }
        };

        script.onerror = () => {
            reject(new Error(
                'Не удалось загрузить MapGL 2GIS. Проверьте подключение к интернету ' +
                'или доступность домена mapgl.2gis.com.'
            ));
        };

        document.head.appendChild(script);
    });
}

function showMapError(message) {
    document.getElementById('map-loading').classList.add('d-none');
    const errEl = document.getElementById('map-error');
    document.getElementById('map-error-text').textContent = message;
    errEl.classList.remove('d-none');
}

function initMap() {
    document.getElementById('map-loading').classList.add('d-none');
    map = new mapgl.Map('map', {
        center: [37.6173, 55.7558],
        zoom: 11,
        key: API_KEY,
    });
    mapGLReady = true;
}

// ─────────────────────────────────────────
// Suggest / Geocode
// ─────────────────────────────────────────

async function fetchSuggestions(query) {
    if (!query || query.length < 2) return [];
    try {
        const params = new URLSearchParams({
            q:      query,
            fields: 'items.point,items.full_name,items.name',
            locale: 'ru_RU',
            type:   'building,street,adm_div.city,adm_div.settlement,adm_div.region',
        });
        const res  = await fetch(`${SUGGEST_URL}?${params}`);
        const data = await res.json();
        return data.result?.items || [];
    } catch {
        return [];
    }
}

async function geocodeAddress(query) {
    try {
        const params = new URLSearchParams({
            q:      query,
            fields: 'items.geometry.centroid,items.full_name',
            locale: 'ru_RU',
        });
        const res  = await fetch(`${GEOCODE_URL}?${params}`);
        const data = await res.json();
        const item = data.result?.items?.[0];
        if (!item) return null;

        // centroid comes as WKT: "POINT(lon lat)"
        const centroid = item.geometry?.centroid || '';
        const match = centroid.match(/POINT\(([0-9.]+)\s+([0-9.]+)\)/);
        if (!match) return null;

        return {
            lon:  parseFloat(match[1]),
            lat:  parseFloat(match[2]),
            name: item.full_name || query,
        };
    } catch {
        return null;
    }
}

// ─────────────────────────────────────────
// Suggest dropdown
// ─────────────────────────────────────────

function setupSuggest(inputId, dropdownId, onSelect) {
    const input    = document.getElementById(inputId);
    const dropdown = document.getElementById(dropdownId);
    let debounceTimer;

    input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
            const items = await fetchSuggestions(input.value.trim());
            renderDropdown(items, dropdown, (item) => {
                const label = item.full_name || item.name || '';
                input.value = label;
                dropdown.innerHTML = '';
                onSelect(item);
            });
        }, 280);
    });

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.innerHTML = '';
        }
    });

    // Keyboard navigation
    input.addEventListener('keydown', (e) => {
        const items = dropdown.querySelectorAll('.suggestion-item');
        if (!items.length) return;
        const active = dropdown.querySelector('.suggestion-item.active');
        let idx = [...items].indexOf(active);

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (active) active.classList.remove('active');
            items[Math.min(idx + 1, items.length - 1)].classList.add('active');
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (active) active.classList.remove('active');
            items[Math.max(idx - 1, 0)].classList.add('active');
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const focused = dropdown.querySelector('.suggestion-item.active') || items[0];
            focused?.click();
        } else if (e.key === 'Escape') {
            dropdown.innerHTML = '';
        }
    });
}

function renderDropdown(items, dropdown, onSelect) {
    dropdown.innerHTML = '';
    if (!items.length) return;

    items.slice(0, 6).forEach((item) => {
        const el  = document.createElement('div');
        el.className = 'suggestion-item';

        const name = item.name || '';
        const sub  = item.full_name && item.full_name !== name
            ? `<div class="suggest-sub">${item.full_name}</div>`
            : '';
        el.innerHTML = `${name}${sub}`;

        el.addEventListener('click', () => onSelect(item));
        dropdown.appendChild(el);
    });
}

// ─────────────────────────────────────────
// Markers
// ─────────────────────────────────────────

function placeMarker(coords, color, existing) {
    if (existing) existing.destroy();
    return new mapgl.Marker(map, {
        coordinates: [coords.lon, coords.lat],
        color,
    });
}

// ─────────────────────────────────────────
// Routing API
// ─────────────────────────────────────────

async function fetchRoute(from, to) {
    const body = {
        points: [
            { lon: from.lon, lat: from.lat, type: 'stop' },
            { lon: to.lon,   lat: to.lat,   type: 'stop' },
        ],
        transport: 'walking',
        locale: 'ru',
        params: {
            pedestrian: { use_instructions: true },
        },
    };

    const res = await fetch(ROUTING_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Routing API error: ${res.status}`);
    return res.json();
}

// ─────────────────────────────────────────
// Draw route on map
// ─────────────────────────────────────────

function clearRoutePolylines() {
    routePolylines.forEach((p) => p.destroy());
    routePolylines = [];
    crossingMarkers.forEach((m) => m.destroy());
    crossingMarkers = [];
}

// Извлечь первую точку из WKT LINESTRING — это позиция манёвра
function maneuverPoint(maneuver) {
    const sel = maneuver.outcoming_path?.geometry?.[0]?.selection;
    if (!sel) return null;
    const m = sel.match(/LINESTRING\(([0-9.]+)\s+([0-9.]+)/);
    return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
}

// Parse WKT LINESTRING into array of [lon, lat] pairs
function parseLinestring(wkt) {
    const match = wkt.match(/LINESTRING\((.+)\)/);
    if (!match) return [];
    return match[1].split(',').map((pair) => {
        const [lon, lat] = pair.trim().split(' ').map(Number);
        return [lon, lat];
    }).filter(([lon, lat]) => !isNaN(lon) && !isNaN(lat));
}

function drawRoute(routeData) {
    if (!mapGLReady) return;
    clearRoutePolylines();

    const route = routeData.result?.[0];
    if (!route) return;

    const coords = [];

    // Начальный пешеходный отрезок (от точки A до дороги)
    const beginSel = route.begin_pedestrian_path?.geometry?.selection;
    if (beginSel) coords.push(...parseLinestring(beginSel));

    // Все маневры маршрута
    (route.maneuvers || []).forEach((maneuver) => {
        (maneuver.outcoming_path?.geometry || []).forEach((geoItem) => {
            if (geoItem.selection) {
                coords.push(...parseLinestring(geoItem.selection));
            }
        });
    });

    // Конечный пешеходный отрезок (от дороги до точки B)
    const endSel = route.end_pedestrian_path?.geometry?.selection;
    if (endSel) coords.push(...parseLinestring(endSel));

    if (coords.length < 2) return;

    const polyline = new mapgl.Polyline(map, {
        coordinates: coords,
        width: 6,
        color: '#3b82f6',
        opacity: 0.85,
    });
    routePolylines.push(polyline);

    // Маркеры манёвров
    // pedestrian_road_crossing — большой маркер с меткой «!»
    // pedestrian_crossroad    — маленький маркер без метки
    (route.maneuvers || []).forEach((maneuver) => {
        const pt = maneuverPoint(maneuver);
        if (!pt) return;

        let options;
        if (maneuver.type === 'pedestrian_road_crossing') {
            options = {
                coordinates: pt,
                scale: 1.2,
                label: { text: '!', fontSize: 14, color: '#ffffff', haloColor: '#ef4444', haloWidth: 3 },
            };
        } else if (maneuver.type === 'pedestrian_crossroad') {
            options = { coordinates: pt, scale: 0.45 };
        } else {
            return;
        }

        crossingMarkers.push(new mapgl.Marker(map, options));
    });

    // Fit map to route bounds
    const lons = coords.map((c) => c[0]);
    const lats = coords.map((c) => c[1]);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);

    map.setCenter([(minLon + maxLon) / 2, (minLat + maxLat) / 2]);

    const span = Math.max(maxLon - minLon, maxLat - minLat);
    let zoom = 16;
    if (span > 0.02) zoom = 15;
    if (span > 0.05) zoom = 13;
    if (span > 0.15) zoom = 12;
    if (span > 0.5)  zoom = 10;
    map.setZoom(zoom);
}

// ─────────────────────────────────────────
// Route analysis — extract crossing data
// ─────────────────────────────────────────

// geometry.style значения для безопасных (внеуличных) переходов
const SAFE_CROSSING_STYLES = new Set(['pedestrian_bridge', 'overgroundway', 'undergroundway']);

function analyzeRoute(routeData) {
    const route = routeData.result?.[0];
    if (!route) return null;

    const duration = route.total_duration || 0; // seconds
    const distance = route.total_distance || 0; // meters

    let unsafeCrossings  = 0;
    let safeCrossings    = 0;
    let crosswalkCount   = 0; // наземный (зебра)
    let bridgeCount      = 0; // надземный (мост)
    let undergroundCount = 0; // подземный
    let turnCount        = 0; // pedestrian_crossroad — повороты по тротуару

    (route.maneuvers || []).forEach((maneuver) => {
        if (maneuver.type === 'pedestrian_crossroad') {
            turnCount++;
            return;
        }
        if (maneuver.type !== 'pedestrian_road_crossing') return;

        const styles = (maneuver.outcoming_path?.geometry || []).map(g => g.style || '');

        if (styles.some(s => s === 'pedestrian_bridge' || s === 'overgroundway')) {
            bridgeCount++;
            safeCrossings++;
        } else if (styles.some(s => s === 'undergroundway' || s === 'tunnel')) {
            undergroundCount++;
            safeCrossings++;
        } else {
            crosswalkCount++;
            unsafeCrossings++;
        }
    });

    return {
        duration,
        distance,
        unsafeCrossings,
        safeCrossings,
        crosswalkCount,
        bridgeCount,
        undergroundCount,
        turnCount,
        totalCrossings: unsafeCrossings + safeCrossings,
        durationMin: Math.round(duration / 60),
    };
}

// ─────────────────────────────────────────
// Scoring formula
// ─────────────────────────────────────────

function calculateScore(analysis) {
    const { duration, distance, unsafeCrossings, safeCrossings, totalCrossings } = analysis;
    const durationMin = duration / 60;
    const distKm      = distance / 1000;

    // A — Время (макс 4)
    let A, aThr;
    if      (durationMin <= 5)  { A = 4; aThr = '≤ 5 мин'; }
    else if (durationMin <= 10) { A = 3; aThr = '≤ 10 мин'; }
    else if (durationMin <= 20) { A = 2; aThr = '≤ 20 мин'; }
    else                        { A = 1; aThr = '> 20 мин'; }

    // B — Расстояние (макс 3)
    let B, bThr;
    if      (distKm <= 0.5) { B = 3; bThr = '≤ 0.5 км'; }
    else if (distKm <= 1.5) { B = 2; bThr = '≤ 1.5 км'; }
    else                    { B = 1; bThr = '> 1.5 км'; }

    // C — только небезопасные переходы (мосты/тоннели НЕ штрафуются)
    let C, cThr;
    if      (unsafeCrossings === 0) { C = 3; cThr = '0 открытых переходов'; }
    else if (unsafeCrossings <= 3)  { C = 2; cThr = '≤ 3 открытых'; }
    else                            { C = 1; cThr = '> 3 открытых'; }

    // D — штраф только за открытые переходы через дорогу (−0.4 каждый)
    const D = Math.round(unsafeCrossings * 0.4 * 10) / 10;

    const raw   = A + B + C - D;
    const total = Math.max(0, Math.min(10, Math.round(raw * 10) / 10));

    return {
        total, A, B, C, D,
        aThr, bThr, cThr,
        durationMin: Math.round(durationMin),
        distKm:      Math.round(distKm * 10) / 10,
        distance,
        unsafeCrossings,
        safeCrossings,
        totalCrossings,
        crosswalkCount:   analysis.crosswalkCount,
        bridgeCount:      analysis.bridgeCount,
        undergroundCount: analysis.undergroundCount,
        turnCount:        analysis.turnCount,
    };
}

// ─────────────────────────────────────────
// Display score UI
// ─────────────────────────────────────────

function displayScore(score) {
    document.getElementById('score-card').classList.remove('d-none');

    const circle = document.getElementById('score-circle');
    document.getElementById('total-score').textContent = score.total;

    circle.className = 'score-circle mx-auto';
    if (score.total >= 8)      circle.classList.add('score-excellent');
    else if (score.total >= 6) circle.classList.add('score-good');
    else if (score.total >= 4) circle.classList.add('score-ok');
    else                       circle.classList.add('score-bad');

    const [, text, cls] = score.total >= 8 ? ['', 'Отличный маршрут', 'success']
        : score.total >= 6 ? ['', 'Хороший маршрут', 'warning']
        : score.total >= 4 ? ['', 'Удовлетворительно', 'secondary']
        : ['', 'Неудобный маршрут', 'danger'];
    document.getElementById('score-label').innerHTML = `<span class="badge bg-${cls}">${text}</span>`;

    const distStr = score.distance >= 1000
        ? `${(score.distance / 1000).toFixed(1)} км`
        : `${Math.round(score.distance)} м`;
    document.getElementById('stat-duration').textContent = `${score.durationMin} мин`;
    document.getElementById('stat-distance').textContent = distStr;

    // Formula breakdown
    const safeNote = score.safeCrossings > 0
        ? ` <span class="text-success">(+${score.safeCrossings} безопасных)</span>` : '';

    const penaltyRow = score.D > 0
        ? `<tr>
            <td class="text-muted ps-2">D</td>
            <td class="text-danger">Штраф</td>
            <td class="text-muted">${score.unsafeCrossings} откр. × 0.4</td>
            <td class="text-end text-danger fw-semibold">−${score.D}</td>
           </tr>`
        : '';

    document.getElementById('score-breakdown').innerHTML = `
        <div class="formula-box mb-2">
            <code class="small">A + B + C − D = итог</code>
        </div>
        <table class="w-100 small" style="border-collapse:separate; border-spacing:0 3px;">
          <thead>
            <tr class="text-muted" style="font-size:0.7rem; text-transform:uppercase; letter-spacing:.05em;">
              <th class="ps-2" style="width:18px"></th>
              <th>Параметр</th>
              <th>Условие</th>
              <th class="text-end">Балл</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="ps-2 text-muted">A</td>
              <td>Время</td>
              <td class="text-muted">${score.aThr} → макс 4</td>
              <td class="text-end text-success fw-semibold">+${score.A}</td>
            </tr>
            <tr>
              <td class="ps-2 text-muted">B</td>
              <td>Расстояние</td>
              <td class="text-muted">${score.bThr} → макс 3</td>
              <td class="text-end text-success fw-semibold">+${score.B}</td>
            </tr>
            <tr>
              <td class="ps-2 text-muted">C</td>
              <td>Пересечения${safeNote}</td>
              <td class="text-muted">${score.cThr} → макс 3</td>
              <td class="text-end text-success fw-semibold">+${score.C}</td>
            </tr>
            ${penaltyRow}
          </tbody>
          <tfoot>
            <tr style="border-top:2px solid #e5e7eb;">
              <td colspan="3" class="pt-2 ps-2 fw-semibold">
                ${score.A} + ${score.B} + ${score.C}${score.D > 0 ? ` − ${score.D}` : ''}
              </td>
              <td class="pt-2 text-end fw-bold fs-6">${score.total} / 10</td>
            </tr>
          </tfoot>
        </table>`;

    const totalRoadCrossings = score.crosswalkCount + score.bridgeCount + score.undergroundCount;
    document.getElementById('crossing-summary').innerHTML = `
        <div class="d-flex gap-2 mt-1">
            <span class="badge bg-danger bg-opacity-10 text-danger border border-danger-subtle px-2 py-1">
                🚶 Переходов через дорогу: <strong>${totalRoadCrossings}</strong>
            </span>
            <span class="badge bg-secondary bg-opacity-10 text-secondary border border-secondary-subtle px-2 py-1">
                ↩ Поворотов: <strong>${score.turnCount}</strong>
            </span>
        </div>`;
}

// ─────────────────────────────────────────
// POI Search (Catalog API)
// ─────────────────────────────────────────

let poiMarkers    = [];   // маркеры найденных объектов на карте
let selectedPOI   = null; // выбранный POI { name, lon, lat }

const CATALOG_URL = '/api/catalog';

async function searchPOIs() {
    const q      = document.getElementById('poi-type').value;
    const radius = document.getElementById('search-radius').value;

    const params = new URLSearchParams({
        q,
        point:     `${storeCoords.lon},${storeCoords.lat}`,
        radius,
        sort:      'distance',
        type:      'branch,adm_div.place',
        fields:    'items.point,items.name,items.full_name,items.rubrics,items.address',
        page_size: 10,
    });

    const res  = await fetch(`${CATALOG_URL}?${params}`);
    const data = await res.json();
    return data.result?.items || [];
}

function clearPOIMarkers() {
    poiMarkers.forEach(m => m.destroy());
    poiMarkers = [];
}

function renderPOIList(items) {
    const card      = document.getElementById('poi-card');
    const list      = document.getElementById('poi-list');
    const countEl   = document.getElementById('poi-count');
    const titleEl   = document.getElementById('poi-card-title');
    const q         = document.getElementById('poi-type').value;

    clearPOIMarkers();
    clearRoutePolylines();
    document.getElementById('score-card').classList.add('d-none');

    if (!items.length) {
        list.innerHTML = '<p class="text-muted small mb-0">Ничего не найдено. Попробуйте увеличить радиус.</p>';
        card.classList.remove('d-none');
        countEl.textContent = '0';
        return;
    }

    titleEl.textContent = q.charAt(0).toUpperCase() + q.slice(1) + ' рядом';
    countEl.textContent = items.length;
    card.classList.remove('d-none');

    list.innerHTML = items.map((item, i) => {
        const name    = item.name || item.full_name || '—';
        const address = item.address?.name || '';
        const rubric  = item.rubrics?.[0]?.name || '';
        return `
        <div class="poi-item" data-index="${i}">
            <div class="poi-item-name">${name}</div>
            ${address ? `<div class="poi-item-sub">${address}</div>` : ''}
            ${rubric  ? `<div class="poi-item-rubric">${rubric}</div>` : ''}
        </div>`;
    }).join('');

    // Маркеры на карте и клики
    items.forEach((item, i) => {
        if (!item.point || !mapGLReady) return;

        const marker = new mapgl.Marker(map, {
            coordinates: [item.point.lon, item.point.lat],
            color: '#f59e0b',
        });
        poiMarkers.push(marker);

        const el = list.children[i];
        const onClick = () => selectPOI(item, i, items);
        el.addEventListener('click', onClick);
        marker.on('click', onClick);
    });

    // Центрируем карту на первом объекте
    if (items[0]?.point && mapGLReady) {
        map.setCenter([items[0].point.lon, items[0].point.lat]);
        map.setZoom(14);
    }
}

async function selectPOI(item, index, allItems) {
    if (!item.point) { alert('У объекта нет координат'); return; }

    selectedPOI = { name: item.name || item.full_name, lon: item.point.lon, lat: item.point.lat };

    // Подсвечиваем выбранный элемент в списке
    document.querySelectorAll('.poi-item').forEach((el, i) => {
        el.classList.toggle('poi-item-active', i === index);
    });

    // Перекрашиваем маркеры: выбранный — синий, остальные — жёлтые
    poiMarkers.forEach((m, i) => {
        m.destroy();
        const coords = allItems[i]?.point;
        if (!coords) return;
        poiMarkers[i] = new mapgl.Marker(map, {
            coordinates: [coords.lon, coords.lat],
            color: i === index ? '#3b82f6' : '#f59e0b',
        });
        const onClick = () => selectPOI(allItems[i], i, allItems);
        poiMarkers[i].on('click', onClick);
    });

    // Маркер конечной точки (поверх маркера POI)
    homeMarker = placeMarker(selectedPOI, '#3b82f6', homeMarker);

    // Строим маршрут
    await buildRouteToPOI(selectedPOI, item.name || item.full_name);
}

async function buildRouteToPOI(dest, poiName) {
    document.getElementById('map-hint').textContent = 'Строим маршрут…';

    try {
        const routeData = await fetchRoute(storeCoords, dest);

        if (!routeData.result?.length) {
            document.getElementById('map-hint').textContent = 'Не удалось построить маршрут до этого объекта';
            return;
        }

        currentRouteData = routeData;
        drawRoute(routeData);

        const analysis = analyzeRoute(routeData);
        const score    = calculateScore(analysis);

        document.getElementById('selected-poi-name').textContent = `📍 ${poiName}`;
        document.getElementById('map-hint').textContent = '';

        // Скрываем список, показываем оценку
        document.getElementById('poi-card').classList.add('d-none');
        displayScore(score);

        // Кнопка «← Список»
        document.getElementById('back-btn').onclick = () => {
            document.getElementById('score-card').classList.add('d-none');
            document.getElementById('poi-card').classList.remove('d-none');
            clearRoutePolylines();
        };

    } catch (err) {
        console.error(err);
        document.getElementById('map-hint').textContent = 'Ошибка при построении маршрута';
    }
}

// ─────────────────────────────────────────
// Init
// ─────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await loadMapGLScript();
        initMap();
    } catch (err) {
        console.error('[MapGL]', err);
        showMapError(err.message);
    }

    // Suggest для адреса пользователя
    setupSuggest('home-input', 'home-suggestions', async (item) => {
        if (item.point) {
            storeCoords = { lon: item.point.lon, lat: item.point.lat };
        } else {
            storeCoords = await geocodeAddress(item.full_name || item.name || '');
        }
        if (storeCoords && mapGLReady) {
            storeMarker = placeMarker(storeCoords, '#ef4444', storeMarker);
            map.setCenter([storeCoords.lon, storeCoords.lat]);
            map.setZoom(14);
        }
        document.getElementById('search-btn').disabled = !storeCoords;
    });

    // Кнопка поиска объектов
    document.getElementById('search-btn').addEventListener('click', async () => {
        const btn = document.getElementById('search-btn');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Ищем…';
        try {
            const items = await searchPOIs();
            renderPOIList(items);
            if (items.length) await selectPOI(items[0], 0, items);
        } catch (e) {
            alert('Ошибка поиска: ' + e.message);
        } finally {
            btn.disabled = !storeCoords;
            btn.textContent = 'Найти объекты';
        }
    });

    // Смена типа или радиуса сбрасывает результаты
    ['poi-type', 'search-radius'].forEach(id => {
        document.getElementById(id).addEventListener('change', () => {
            document.getElementById('poi-card').classList.add('d-none');
            document.getElementById('score-card').classList.add('d-none');
            clearPOIMarkers();
            clearRoutePolylines();
        });
    });

});
