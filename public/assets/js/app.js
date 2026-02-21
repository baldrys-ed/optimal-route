/**
 * Оценка пешего маршрута — 2GIS MapGL JS + Routing API
 *
 * Формула оценки (RouteScoreService):
 *   SCORE = path_quality * 0.65 + turn_simplicity * 0.35
 *
 *   path_quality   — взвешенная доля по типам покрытия (park_path, living_zone, normal ...)
 *   turn_simplicity — прямолинейность (штраф за острые повороты)
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
    return new mapgl.CircleMarker(map, {
        coordinates: [coords.lon, coords.lat],
        radius: 10,
        color,
        strokeColor: '#ffffff',
        strokeWidth: 2,
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

// Цвета линий по типу покрытия (совпадают с route-score.html)
const STYLE_COLORS = {
    normal:         '#3b82f6',
    crosswalk:      '#f97316',
    park_path:      '#22c55e',
    living_zone:    '#a855f7',
    undergroundway: '#6b7280',
    archway:        '#b45309',
};

function drawRoute(routeData) {
    if (!mapGLReady) return;
    clearRoutePolylines();

    const route = routeData.result?.[0];
    if (!route) return;

    const allCoords = [];

    // Начальный пешеходный отрезок
    const beginSel = route.begin_pedestrian_path?.geometry?.selection;
    if (beginSel) {
        const c = parseLinestring(beginSel);
        allCoords.push(...c);
        if (c.length >= 2)
            routePolylines.push(new mapgl.Polyline(map, { coordinates: c, width: 5, color: '#a855f7', opacity: 0.7 }));
    }

    // Манёвры — каждый сегмент своим цветом по стилю
    (route.maneuvers || []).forEach((maneuver) => {
        (maneuver.outcoming_path?.geometry || []).forEach((seg) => {
            if (!seg.selection) return;
            const c = parseLinestring(seg.selection);
            if (c.length < 2) return;
            allCoords.push(...c);
            const color = STYLE_COLORS[seg.style] || STYLE_COLORS.normal;
            const width = seg.style === 'crosswalk' ? 7 : 5;
            routePolylines.push(new mapgl.Polyline(map, { coordinates: c, width, color, opacity: 0.9 }));
        });

        // Маркеры: старт, финиш и все пересечения дороги поверхностью
        const mType    = maneuver.type ?? '';
        const mAttr    = maneuver.attribute ?? '';
        const mStyles  = (maneuver.outcoming_path?.geometry || []).map(g => g.style);
        const isSurfaceCrossing =
            mType === 'pedestrian_road_crossing' ||
            (mType === 'pedestrian_crossroad'
                && ['onto_crosswalk', 'on_traffic_light'].includes(mAttr)
                && !mStyles.includes('undergroundway'));

        if (mType === 'pedestrian_begin' || mType === 'pedestrian_end' || isSurfaceCrossing) {
            const pt    = maneuverPoint(maneuver);
            const color = mType === 'pedestrian_begin'   ? '#22c55e'
                        : mType === 'pedestrian_end'     ? '#3b82f6'
                        : mAttr === 'on_traffic_light'   ? '#16a34a'
                        :                                  '#f97316';
            if (pt) crossingMarkers.push(new mapgl.CircleMarker(map, {
                coordinates: pt,
                radius: (mType === 'pedestrian_begin' || mType === 'pedestrian_end') ? 10 : 7,
                color,
                strokeColor: '#ffffff',
                strokeWidth: 2,
            }));
        }
    });

    // Конечный пешеходный отрезок
    const endSel = route.end_pedestrian_path?.geometry?.selection;
    if (endSel) {
        const c = parseLinestring(endSel);
        allCoords.push(...c);
        if (c.length >= 2)
            routePolylines.push(new mapgl.Polyline(map, { coordinates: c, width: 5, color: '#a855f7', opacity: 0.7 }));
    }

    if (!allCoords.length) return;

    // Fit map to route bounds
    const lons = allCoords.map((c) => c[0]);
    const lats = allCoords.map((c) => c[1]);
    map.setCenter([(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2]);
    const span = Math.max(Math.max(...lons) - Math.min(...lons), Math.max(...lats) - Math.min(...lats));
    map.setZoom(span > 0.5 ? 10 : span > 0.15 ? 12 : span > 0.05 ? 13 : span > 0.02 ? 15 : 16);
}

// ─────────────────────────────────────────
// Score via API
// ─────────────────────────────────────────

async function fetchScore(routeData) {
    const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route: routeData.result[0] }),
    });
    if (!res.ok) throw new Error(`/api/analyze error: ${res.status}`);
    return res.json();
}

// ─────────────────────────────────────────
// Display score UI
// ─────────────────────────────────────────

const STYLE_LABELS = {
    normal:         'Тротуар',
    crosswalk:      'Пешеходный переход',
    park_path:      'Парк / бульвар',
    living_zone:    'Жилая зона',
    undergroundway: 'Подземный переход',
    archway:        'Арка / проход',
    stairway:       'Лестница',
};

const CROSSING_COLORS = {
    on_traffic_light: '#22c55e',
    onto_crosswalk:   '#f59e0b',
    empty:            '#ef4444',
    none:             '#94a3b8',
};

function displayScore(data) {
    const { score, path_quality, crossing_safety, turn_simplicity, breakdown } = data;

    document.getElementById('score-card').classList.remove('d-none');

    // Кружок оценки
    const circle = document.getElementById('score-circle');
    document.getElementById('total-score').textContent = score;
    circle.className = 'score-circle mx-auto';
    if      (score >= 8)   circle.classList.add('score-excellent');
    else if (score >= 6.5) circle.classList.add('score-good');
    else if (score >= 5)   circle.classList.add('score-ok');
    else                   circle.classList.add('score-bad');

    const labelText = score >= 8   ? 'Отличный маршрут'
                    : score >= 6.5 ? 'Хороший маршрут'
                    : score >= 5   ? 'Умеренно комфортный'
                    : 'Неудобный маршрут';
    const labelCls = score >= 8 ? 'success' : score >= 6.5 ? 'warning' : score >= 5 ? 'secondary' : 'danger';
    document.getElementById('score-label').innerHTML =
        `<span class="badge bg-${labelCls}">${labelText}</span>`;

    // Время и расстояние
    const distM = breakdown.total_distance_m;
    document.getElementById('stat-duration').textContent = `${breakdown.total_duration_min} мин`;
    document.getElementById('stat-distance').textContent =
        distM >= 1000 ? `${(distM / 1000).toFixed(1)} км` : `${distM} м`;

    // ── Блок 1: Качество покрытия × 0.55 ──
    const pqContrib = (path_quality * 0.55).toFixed(3);
    const zonesRows = Object.entries(breakdown.zones).map(([style, z]) => `
        <tr>
            <td style="padding:3px 0">
                <span style="display:inline-block;width:10px;height:10px;border-radius:2px;
                      background:${STYLE_COLORS[style]||'#94a3b8'};margin-right:5px;vertical-align:middle"></span>
                ${z.label}
            </td>
            <td style="text-align:right;color:#64748b">${z.meters} м</td>
            <td style="text-align:center;color:#64748b">×</td>
            <td style="text-align:center;font-weight:600">${z.weight}</td>
            <td style="text-align:right;color:#64748b">=</td>
            <td style="text-align:right;font-weight:600;color:#334155">${z.contribution}</td>
        </tr>`).join('');

    // ── Блок 2: Безопасность переходов × 0.30 ──
    const csContrib = (crossing_safety * 0.30).toFixed(3);
    const crossingRows = breakdown.road_crossings === 0
        ? `<div style="font-size:.76rem;color:#22c55e">Переходов через дорогу нет → 1.0</div>`
        : (breakdown.crossing_detail || []).map(c => `
            <div style="display:flex;justify-content:space-between;align-items:center;
                        font-size:.76rem;padding:2px 0">
                <span>
                    <span style="display:inline-block;width:8px;height:8px;border-radius:50%;
                          background:${CROSSING_COLORS[Object.keys(CROSSING_COLORS).find(k => c.label.includes('светофор') ? k==='on_traffic_light' : c.label.includes('зебр') ? k==='onto_crosswalk' : k==='empty')||'none']};
                          margin-right:5px;vertical-align:middle"></span>
                    ${c.label}
                </span>
                <span style="color:#64748b">${c.count} шт × ${c.safety} = <strong>${(c.count * c.safety).toFixed(1)}</strong></span>
            </div>`).join('');

    const n = breakdown.road_crossings;
    const avgSafety = n > 0
        ? (breakdown.crossing_detail || []).reduce((s, c) => s + c.count * c.safety, 0) / n
        : 1.0;
    const penalty = n > 0 ? Math.exp(-0.05 * n) : 1.0;
    const csFormula = n === 0
        ? `Нет переходов → <strong>1.0</strong>`
        : `avg ${avgSafety.toFixed(3)} × exp(−0.05×${n}) = ${penalty.toFixed(3)} → <strong>${crossing_safety}</strong>`;

    // ── Блок 3: Прямолинейность × 0.15 ──
    const tsContrib = (turn_simplicity * 0.15).toFixed(3);
    const avgAngle  = breakdown.avg_turn_angle;
    const turnCount = breakdown.turn_count;
    const tsFormula = turnCount > 0
        ? `1 − ${avgAngle}° / 180° = <strong>${turn_simplicity}</strong>`
        : `Поворотов нет → <strong>1.0</strong>`;

    document.getElementById('score-breakdown').innerHTML = `

        <div style="font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:6px">
            1. Качество покрытия × 0.55
        </div>
        <table style="width:100%;font-size:.76rem;border-collapse:collapse;margin-bottom:4px">
            ${zonesRows}
            <tr style="border-top:1px solid #e2e8f0">
                <td colspan="5" style="padding-top:4px;color:#64748b">Σ = ${breakdown.weighted_sum} / ${breakdown.total_meters} м</td>
                <td style="padding-top:4px;text-align:right;font-weight:700;color:#0284c7">= ${path_quality}</td>
            </tr>
        </table>
        <div style="font-size:.75rem;color:#64748b;margin-bottom:12px;padding:5px 8px;background:#f0f9ff;border-radius:6px">
            ${path_quality} × 0.55 = <strong>${pqContrib}</strong>
        </div>

        <div style="font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:6px">
            2. Безопасность переходов × 0.30
        </div>
        <div style="margin-bottom:4px">${crossingRows}</div>
        <div style="font-size:.75rem;color:#64748b;margin-bottom:12px;padding:5px 8px;background:#fff7ed;border-radius:6px">
            ${csFormula} × 0.30 = <strong>${csContrib}</strong>
        </div>

        <div style="font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:6px">
            3. Прямолинейность × 0.15
        </div>
        <div style="font-size:.76rem;color:#334155;margin-bottom:4px">
            ${turnCount} поворотов, средний угол ${avgAngle}°
        </div>
        <div style="font-size:.75rem;color:#64748b;margin-bottom:12px;padding:5px 8px;background:#f0fdf4;border-radius:6px">
            ${tsFormula} × 0.15 = <strong>${tsContrib}</strong>
        </div>

        <div style="font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:6px">
            Итог
        </div>
        <div class="formula-box" style="font-size:.8rem">
            <code>${pqContrib} + ${csContrib} + ${tsContrib} = <strong>${score} / 10</strong></code>
        </div>`;

    // ── Статистика ──
    const turns      = breakdown.turns || {};
    const sharpCount = (turns['sharply_left'] || 0) + (turns['sharply_right'] || 0);
    document.getElementById('crossing-summary').innerHTML = `
        <div class="d-flex flex-wrap gap-2 mt-2">
            <span class="badge bg-danger bg-opacity-10 text-danger border border-danger-subtle px-2 py-1"
                  title="Манёвры типа pedestrian_road_crossing — пересечения проезжей части">
                Пересечений дороги: <strong>${breakdown.road_crossings}</strong>
            </span>
            <span class="badge bg-secondary bg-opacity-10 text-secondary border border-secondary-subtle px-2 py-1">
                Поворотов: <strong>${breakdown.turn_count}</strong>
            </span>
            ${sharpCount > 0 ? `<span class="badge bg-warning bg-opacity-10 text-warning border border-warning-subtle px-2 py-1">
                Резких: <strong>${sharpCount}</strong>
            </span>` : ''}
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

        const marker = new mapgl.CircleMarker(map, {
            coordinates: [item.point.lon, item.point.lat],
            radius: 8,
            color: '#f59e0b',
            strokeColor: '#ffffff',
            strokeWidth: 2,
            interactive: true,
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
        poiMarkers[i] = new mapgl.CircleMarker(map, {
            coordinates: [coords.lon, coords.lat],
            radius: 8,
            color: i === index ? '#3b82f6' : '#f59e0b',
            strokeColor: '#ffffff',
            strokeWidth: 2,
            interactive: true,
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

        // Сырые данные для анализа
        const rawEl = document.getElementById('raw-data-json');
        if (rawEl) {
            rawEl.textContent = JSON.stringify(routeData.result?.[0] ?? routeData, null, 2);
        }
        document.getElementById('raw-data-details')?.removeAttribute('open');

        const scoreData = await fetchScore(routeData);

        document.getElementById('selected-poi-name').textContent = `📍 ${poiName}`;
        document.getElementById('map-hint').textContent = '';

        // Скрываем список, показываем оценку
        document.getElementById('poi-card').classList.add('d-none');
        displayScore(scoreData);

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
