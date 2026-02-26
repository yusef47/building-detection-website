/* ==========================================
   BuildingAI — Frontend Application
   ========================================== */

// ==========================================
// === Configuration ===
// ==========================================

// ⚠️ HF Space URLs (HF username = yusef75)
const API_ENDPOINTS = [
    "https://yusef75-building-detection.hf.space",   // Space 1 ✅ موجود
    "https://yusef75-building-detection-2.hf.space", // Space 2
    "https://yusef75-building-detection-3.hf.space", // Space 3
    "https://yusef75-building-detection-4.hf.space", // Space 4
];

// Round-robin: كل chunk يروح لـ Space مختلف
function getEndpoint(index) {
    return API_ENDPOINTS[index % API_ENDPOINTS.length];
}

// للتوافق مع الكود القديم
const API_URL = API_ENDPOINTS[0];

// Map defaults
const DEFAULT_CENTER = [30.04, 31.24]; // Cairo
const DEFAULT_ZOOM = 13;

// ==========================================
// === Global State ===
// ==========================================
let map = null;
let drawnItems = null;
let drawnCoords = null;
let resultLayer = null;
let lastGeoJSON = null;


// ==========================================
// === Initialize Map ===
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
    initMap();
    initCounterAnimations();
});

function initMap() {
    // Create map
    map = L.map("map", {
        zoomControl: false,
    }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);

    // Zoom control on the right (better for RTL)
    L.control.zoom({ position: "topright" }).addTo(map);

    // Google Satellite tiles (no labels)
    const satellite = L.tileLayer("https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}", {
        maxZoom: 20,
        attribution: "Google Satellite",
    });

    // Google Hybrid tiles (satellite + labels/names)
    const hybrid = L.tileLayer("https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}", {
        maxZoom: 20,
        attribution: "Google Satellite",
    });

    // Esri World Imagery (works globally, very reliable)
    const esri = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19,
        attribution: "Esri World Imagery",
    });

    // OpenStreetMap (fallback with labels)
    const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "OpenStreetMap",
    });

    // Add Google Hybrid as default
    hybrid.addTo(map);

    // Layer control
    L.control.layers(
        {
            "🏷️ Google + أسماء": hybrid,
            "📡 Google قمر صناعي": satellite,
            "🌍 Esri عالمي": esri,
            "🗺️ خريطة عادية": osm,
        },
        null,
        { position: "topright" }
    ).addTo(map);

    // Draw layer
    drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    // Draw controls
    const drawControl = new L.Control.Draw({
        position: "topleft",
        draw: {
            polygon: {
                shapeOptions: {
                    color: "#FF6B35",
                    weight: 3,
                    fillOpacity: 0.1,
                    fillColor: "#FF6B35",
                },
                allowIntersection: false,
                showArea: true,
            },
            rectangle: {
                shapeOptions: {
                    color: "#FF6B35",
                    weight: 3,
                    fillOpacity: 0.1,
                    fillColor: "#FF6B35",
                },
            },
            circle: false,
            circlemarker: false,
            marker: false,
            polyline: false,
        },
        edit: {
            featureGroup: drawnItems,
            remove: true,
        },
    });
    map.addControl(drawControl);

    // ── Live tile counter WHILE drawing ──────────────────────────
    const MAX_TILES_V51 = 12;

    function countTilesFromLatLngs(latlngs) {
        const ZOOM = 18, TPI = 2;
        const toTX = lon => ((lon + 180) / 360) * Math.pow(2, ZOOM);
        const toTY = lat => {
            const r = lat * Math.PI / 180;
            return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, ZOOM);
        };
        const lngs = latlngs.map(ll => ll.lng);
        const lats = latlngs.map(ll => ll.lat);
        const tilesX = Math.abs(Math.floor(toTX(Math.max(...lngs)) / TPI) - Math.floor(toTX(Math.min(...lngs)) / TPI)) + 1;
        const tilesY = Math.abs(Math.floor(toTY(Math.min(...lats)) / TPI) - Math.floor(toTY(Math.max(...lats)) / TPI)) + 1;
        return tilesX * tilesY;
    }

    map.on("draw:drawvertex", (e) => {
        const layers = e.layers;
        layers.eachLayer(layer => {
            const lls = layer.getLatLngs ? layer.getLatLngs()[0] : null;
            if (!lls || lls.length < 2) return;
            const count = countTilesFromLatLngs(lls);
            const el = document.getElementById("tile-estimate");
            if (count > MAX_TILES_V51) {
                el.textContent = `🔴 ${count} tiles — الحد الأقصى ${MAX_TILES_V51}`;
                el.style.color = "#FF4444";
            } else if (count > MAX_TILES_V51 * 0.7) {
                el.textContent = `🟡 ${count} tiles (اقترب من الحد)`;
                el.style.color = "#FFB347";
            } else {
                el.textContent = `🟢 ${count} tiles`;
                el.style.color = "#00FF88";
            }
        });
    });

    // Handle drawing events
    map.on("draw:created", (e) => {
        drawnItems.clearLayers();
        drawnItems.addLayer(e.layer);

        // Extract coordinates as [lng, lat] (GeoJSON format)
        let coords;
        if (e.layerType === "rectangle") {
            const b = e.layer.getBounds();
            coords = [
                [b.getSouthWest().lng, b.getSouthWest().lat],
                [b.getNorthWest().lng, b.getNorthWest().lat],
                [b.getNorthEast().lng, b.getNorthEast().lat],
                [b.getSouthEast().lng, b.getSouthEast().lat],
            ];
        } else {
            coords = e.layer.getLatLngs()[0].map((ll) => [ll.lng, ll.lat]);
        }

        drawnCoords = coords;

        // ── Hard block if > 12 tiles ──────────────────────────────
        const chunks = splitPolygonIntoChunks(coords);
        const lngs = coords.map(c => c[0]), lats = coords.map(c => c[1]);
        const ZOOM = 18, TPI = 2;
        const toTX = lon => ((lon + 180) / 360) * Math.pow(2, ZOOM);
        const toTY = lat => {
            const r = lat * Math.PI / 180;
            return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, ZOOM);
        };
        const tilesX = Math.abs(Math.floor(toTX(Math.max(...lngs)) / TPI) - Math.floor(toTX(Math.min(...lngs)) / TPI)) + 1;
        const tilesY = Math.abs(Math.floor(toTY(Math.min(...lats)) / TPI) - Math.floor(toTY(Math.max(...lats)) / TPI)) + 1;
        const totalTiles = tilesX * tilesY;

        if (totalTiles > MAX_TILES_V51) {
            drawnItems.clearLayers();
            drawnCoords = null;
            document.getElementById("tile-estimate").textContent = "";
            setStatus("error", `❌ المنطقة كبيرة جداً! (${totalTiles} tiles) — ارسم منطقة أصغر (≤ ${MAX_TILES_V51} tiles)`);
            return;
        }

        document.getElementById("detect-btn").disabled = false;
        setStatus("ready", `✅ ${coords.length} نقاط — جاري الكشف تلقائياً...`);
        estimateTiles(coords);

        // ── Auto-detect on draw ──
        setTimeout(() => detectBuildings(), 300);
    });

    map.on("draw:deleted", () => {
        drawnCoords = null;
        document.getElementById("detect-btn").disabled = true;
        setStatus("idle", "ارسم منطقة على الخريطة...");
        document.getElementById("tile-estimate").textContent = "";
    });
}


// ==========================================
// === Status Updates ===
// ==========================================
function setStatus(type, message) {
    const dot = document.getElementById("status-dot");
    const text = document.getElementById("status-text");

    dot.className = "status-dot";
    dot.classList.add(`status-${type}`);
    text.textContent = message;
}


// ==========================================
// === Tile Estimation ===
// ==========================================
function estimateTiles(coords) {
    const ZOOM = 18;
    const TILES_PER_IMG = 2;

    const lngs = coords.map((c) => c[0]);
    const lats = coords.map((c) => c[1]);

    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);

    const lonToTileX = (lon) => ((lon + 180) / 360) * Math.pow(2, ZOOM);
    const latToTileY = (lat) => {
        const r = (lat * Math.PI) / 180;
        return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, ZOOM);
    };

    const minTX = Math.floor(lonToTileX(minLng) / TILES_PER_IMG);
    const maxTX = Math.floor(lonToTileX(maxLng) / TILES_PER_IMG);
    const minTY = Math.floor(latToTileY(maxLat) / TILES_PER_IMG);
    const maxTY = Math.floor(latToTileY(minLat) / TILES_PER_IMG);

    const tileCount = (maxTX - minTX + 1) * (maxTY - minTY + 1);

    const el = document.getElementById("tile-estimate");
    if (tileCount > 60) {
        el.textContent = `⚠️ ${tileCount} tiles (الحد الأقصى 60)`;
        el.style.color = "#FF4444";
    } else {
        el.textContent = `📐 ~${tileCount} tiles`;
        el.style.color = "";
    }
}


// ==========================================
// === Parallel Processing Helpers ===
// ==========================================

function splitPolygonIntoChunks(coords) {
    const lngs = coords.map(c => c[0]);
    const lats = coords.map(c => c[1]);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);

    const ZOOM = 18, TPI = 2;
    const toTX = lon => ((lon + 180) / 360) * Math.pow(2, ZOOM);
    const toTY = lat => {
        const r = lat * Math.PI / 180;
        return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, ZOOM);
    };
    const tilesX = Math.abs(Math.floor(toTX(maxLng) / TPI) - Math.floor(toTX(minLng) / TPI)) + 1;
    const tilesY = Math.abs(Math.floor(toTY(minLat) / TPI) - Math.floor(toTY(maxLat) / TPI)) + 1;
    const totalTiles = tilesX * tilesY;

    let cols = 1, rows = 1;
    if (totalTiles > 36) { cols = 3; rows = 2; }
    else if (totalTiles > 16) { cols = 2; rows = 2; }
    else if (totalTiles > 4) { cols = 2; rows = 1; }

    const chunks = [];
    const dLng = (maxLng - minLng) / cols;
    const dLat = (maxLat - minLat) / rows;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const sw_lng = minLng + c * dLng, ne_lng = minLng + (c + 1) * dLng;
            const sw_lat = minLat + r * dLat, ne_lat = minLat + (r + 1) * dLat;
            chunks.push([[sw_lng, sw_lat], [sw_lng, ne_lat], [ne_lng, ne_lat], [ne_lng, sw_lat]]);
        }
    }
    console.log(`📐 ${totalTiles} tiles → ${chunks.length} chunks (${cols}×${rows})`);
    return chunks;
}

function deduplicateFeatures(features, minDistDeg = 0.0001) {
    const kept = [], centroids = [];
    for (const feat of features) {
        const coords = feat.geometry.coordinates[0];
        const cx = coords.reduce((s, c) => s + c[0], 0) / coords.length;
        const cy = coords.reduce((s, c) => s + c[1], 0) / coords.length;
        const isDup = centroids.some(([px, py]) =>
            Math.abs(cx - px) < minDistDeg && Math.abs(cy - py) < minDistDeg);
        if (!isDup) { kept.push(feat); centroids.push([cx, cy]); }
    }
    return kept;
}


async function detectBuildings() {
    if (!drawnCoords) {
        alert("ارسم مضلع أو مستطيل أولاً!");
        return;
    }

    const threshold = parseFloat(document.getElementById("threshold").value) || 0.5;
    const useV51 = true; // V5.1 always enabled
    const btn = document.getElementById("detect-btn");
    const progressContainer = document.getElementById("progress-container");
    const progressFill = document.getElementById("progress-fill");
    const progressText = document.getElementById("progress-text");

    // UI: Processing state
    btn.disabled = true;
    btn.querySelector(".btn-text").textContent = "جاري التحليل...";
    btn.classList.add("btn-loading");
    setStatus("processing", "🔍 جاري إرسال البيانات للخادم...");
    progressContainer.style.display = "flex";
    progressFill.style.width = "10%";
    progressText.textContent = "جاري الاتصال...";

    // Remove old results
    if (resultLayer) {
        map.removeLayer(resultLayer);
        resultLayer = null;
    }
    document.getElementById("results-panel").style.display = "none";

    try {
        // Start progress animation
        let progress = 10;
        const progressInterval = setInterval(() => {
            if (progress < 85) {
                progress += Math.random() * 2;
                progressFill.style.width = `${progress}%`;
                progressText.textContent = `جاري التحليل... ${Math.round(progress)}%`;
            }
        }, 500);

        // ── Split polygon into chunks for parallel processing ──────────
        const chunks = splitPolygonIntoChunks(drawnCoords);
        const numChunks = chunks.length;
        setStatus("processing", `🚀 تحليل متوازي: ${numChunks} منطقة في نفس الوقت...`);

        // Wake-up message
        const wakeUpMsg = setTimeout(() => {
            setStatus("processing", `⏳ جاري تشغيل الخادم... (${numChunks} مناطق بالتوازي)`);
        }, 10000);

        // ── Fire all chunks simultaneously ─────────────────────────────
        const chunkPromises = chunks.map((chunkCoords, i) => {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 500000);
            return fetch(`${getEndpoint(i)}/detect`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    coordinates: chunkCoords,
                    threshold: threshold,
                    use_v51: useV51,
                }),
                signal: controller.signal,
            }).then(async r => {
                if (!r.ok) throw new Error(`Chunk ${i + 1} error: ${r.status}`);
                return r.json();
            }).catch(err => {
                console.warn(`⚠️ Chunk ${i + 1} فشل: ${err.message}`);
                return null; // متجاهلش الكنك الفاشل
            });
        });

        // Promise.allSettled → مش بيموت لو chunk واحد فشل
        const settled = await Promise.allSettled(chunkPromises);
        const results = settled
            .filter(s => s.status === "fulfilled" && s.value !== null)
            .map(s => s.value);
        clearTimeout(wakeUpMsg);
        clearInterval(progressInterval);

        if (results.length === 0) throw new Error("كل الـ chunks فشلت");

        // ── Merge all chunk results ────────────────────────────────────
        let allFeatures = [];
        let totalTiles = 0;
        let totalDuplicates = 0;
        let maxTime = 0;

        for (const data of results) {
            if (data.geojson && data.geojson.features) {
                allFeatures = allFeatures.concat(data.geojson.features);
            }
            if (data.stats) {
                totalTiles += data.stats.tiles_processed || 0;
                totalDuplicates += data.stats.duplicates_removed || 0;
                maxTime = Math.max(maxTime, data.stats.processing_time_seconds || 0);
            }
        }

        // ── Deduplicate across chunks (remove borders duplicates) ──────
        allFeatures = deduplicateFeatures(allFeatures);

        const mergedData = {
            geojson: { type: "FeatureCollection", features: allFeatures },
            stats: {
                buildings_detected: allFeatures.length,
                duplicates_removed: totalDuplicates,
                tiles_processed: totalTiles,
                processing_time_seconds: maxTime,
                threshold: threshold,
            },
        };

        progressFill.style.width = "100%";
        progressText.textContent = "✅ اكتمل!";
        displayResults(mergedData);
        setStatus("done", `✅ تم اكتشاف ${allFeatures.length} مبنى! (${numChunks} مناطق متوازية)`);

    } catch (error) {
        console.error("Detection error:", error);
        setStatus("error", `❌ خطأ: ${error.message}`);
        progressFill.style.width = "0%";
        progressText.textContent = `❌ ${error.message}`;
    } finally {
        btn.disabled = false;
        btn.querySelector(".btn-text").textContent = "كشف المباني";
        btn.classList.remove("btn-loading");
        setTimeout(() => {
            progressContainer.style.display = "none";
            progressFill.style.width = "0%";
        }, 3000);
    }
}


// ==========================================
// === Display Results ===
// ==========================================
function displayResults(data) {
    const { geojson, stats } = data;
    lastGeoJSON = geojson;

    // Draw buildings on map
    resultLayer = L.geoJSON(geojson, {
        style: () => ({
            fillColor: "#FF6B35",
            color: "#FFFFFF",
            weight: 1.5,
            fillOpacity: 0.5,
        }),
        onEachFeature: (feature, layer) => {
            if (feature.properties && feature.properties.confidence) {
                layer.bindTooltip(
                    `🏠 ثقة: ${(feature.properties.confidence * 100).toFixed(1)}%`,
                    { sticky: true }
                );
            }
        },
    }).addTo(map);

    // Fit map to results
    if (resultLayer.getBounds().isValid()) {
        map.fitBounds(resultLayer.getBounds(), { padding: [30, 30] });
    }

    // Update results panel
    document.getElementById("result-buildings").textContent = stats.buildings_detected.toLocaleString();
    document.getElementById("result-tiles").textContent = stats.tiles_processed;
    document.getElementById("result-time").textContent = `${stats.processing_time_seconds}s`;
    document.getElementById("result-duplicates").textContent = stats.duplicates_removed;

    // Show results panel with animation
    const panel = document.getElementById("results-panel");
    panel.style.display = "block";
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}


// ==========================================
// === Clear Drawing ===
// ==========================================
function clearDrawing() {
    drawnCoords = null;
    drawnItems.clearLayers();

    if (resultLayer) {
        map.removeLayer(resultLayer);
        resultLayer = null;
    }

    lastGeoJSON = null;
    document.getElementById("detect-btn").disabled = true;
    document.getElementById("results-panel").style.display = "none";
    document.getElementById("tile-estimate").textContent = "";
    document.getElementById("progress-container").style.display = "none";
    setStatus("idle", "ارسم منطقة على الخريطة...");
}


// ==========================================
// === Download GeoJSON ===
// ==========================================
function downloadGeoJSON() {
    if (!lastGeoJSON) return;

    const blob = new Blob([JSON.stringify(lastGeoJSON, null, 2)], {
        type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `buildings_${new Date().toISOString().slice(0, 10)}.geojson`;
    a.click();
    URL.revokeObjectURL(url);
}


// ==========================================
// === Counter Animations ===
// ==========================================
function initCounterAnimations() {
    const observer = new IntersectionObserver(
        (entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    animateCounters();
                    observer.unobserve(entry.target);
                }
            });
        },
        { threshold: 0.3 }
    );

    const heroStats = document.querySelector(".hero-stats");
    if (heroStats) observer.observe(heroStats);
}

function animateCounters() {
    document.querySelectorAll(".hero-stat-number").forEach((el) => {
        const target = parseInt(el.dataset.count);
        const duration = 2000;
        const start = Date.now();

        const animate = () => {
            const elapsed = Date.now() - start;
            const progress = Math.min(elapsed / duration, 1);
            // Ease out cubic
            const eased = 1 - Math.pow(1 - progress, 3);
            const current = Math.round(target * eased);

            el.textContent = current.toLocaleString();

            if (progress < 1) {
                requestAnimationFrame(animate);
            }
        };

        animate();
    });
}
