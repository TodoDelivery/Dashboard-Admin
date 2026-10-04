import { supabase } from './conexion_supabase.js';

// Canal oficial de presencia de cadetes en SistemaCadetes
const CADETES_PRESENCE_CHANNEL = 'cadetes-disponibles';

let channelPresence = null;
let channelDbCadetes = null;
let channelDbPedidos = null;

// Las tres tablas se indexan por String(id_cad): una sola entrada por cadete
let activeCadetesMap = new Map();       // conectados por Presence ('cadetes-disponibles')
let telemetriaViajeMap = new Map();     // último GPS recibido de un viaje ('pedido-en-curso-*')
let cadetesLastLocationMap = new Map(); // viaje en curso o última entrega según la tabla Pedidos
let activeOrderChannels = new Map();

let leafletMap = null;
let markersLayer = null;
let leafletLoaded = false;
let registeredCadetesCache = [];

// Coordenadas base por defecto: San Juan Centro (Plaza 25 de Mayo)
const DEFAULT_CENTER = [-31.5375, -68.5364];

export function initSidebarRadar() {
  injectLeafletAssets();
  injectModalHTML();
  fetchRegisteredCadetes();
  fetchCadetesLocationsFromDB();
  iniciarRealtime();

  // Polling periódico de seguridad para detectar viajes nuevos de cadetes
  setInterval(fetchCadetesLocationsFromDB, 8000);

  const countEl = document.getElementById('radar-cadetes-count');
  if (countEl && countEl.innerHTML.includes('...')) {
    countEl.innerHTML = `0 unidades <span class="text-emerald-400 font-semibold">activas</span>`;
  }
}

const ESTADOS_VIAJE = ['asignado', 'en_camino_entrega'];
const ESTADOS_OCUPADO = ['ocupado', 'en_curso', 'en_viaje'];

const claveCadete = (c) => String(c?.id_cad ?? c?.id ?? c);
const presenciaDe = (c) => activeCadetesMap.get(claveCadete(c)) || null;
const viajeDe = (c) => {
  const loc = cadetesLastLocationMap.get(claveCadete(c));
  return loc && loc.isEnCurso ? loc : null;
};

function estaConectado(presencia) {
  const st = String(presencia?.estado_cad || '').toLowerCase();
  return Boolean(presencia) && st !== 'offline' && st !== 'desconectado';
}

// Activo = con un viaje en curso, o conectado al canal de presencia con el turno abierto
function isCadeteActive(c) {
  if (!c) return false;
  return Boolean(viajeDe(c)) || estaConectado(presenciaDe(c));
}

function isCadeteBusy(c) {
  if (!c) return false;
  if (viajeDe(c)) return true;
  const p = presenciaDe(c);
  if (p) return ESTADOS_OCUPADO.includes(String(p.estado_cad || '').toLowerCase());
  return ESTADOS_OCUPADO.includes(String(c.estado_cad || '').trim().toLowerCase());
}

/**
 * Extrae [lat, lng] exactos del objeto transmitido por el cadete vía Realtime Presence
 * Estructura del cadete: { id_cad, nombre, coords: { lat, lng }, estado_cad }
 */
function extractCoordinates(data) {
  if (!data) return null;

  // 1. Objeto coords: { lat: -31.5375, lng: -68.5364 } (transmitido por el cadete)
  if (data.coords && typeof data.coords === 'object') {
    const lat = data.coords.lat ?? data.coords.latitude;
    const lng = data.coords.lng ?? data.coords.longitude;
    if (lat !== undefined && lng !== undefined && !isNaN(Number(lat)) && !isNaN(Number(lng))) {
      return [Number(lat), Number(lng)];
    }
  }

  // 2. Propiedades directas
  const lat = data.latitud ?? data.lat ?? data.latitude;
  const lng = data.longitud ?? data.lng ?? data.longitude;
  if (lat !== undefined && lng !== undefined && !isNaN(Number(lat)) && !isNaN(Number(lng))) {
    return [Number(lat), Number(lng)];
  }

  return null;
}

/**
 * Resuelve dónde dibujar a un cadete activo, en este orden:
 * 1. GPS del viaje en curso ('pedido-en-curso-*')
 * 2. GPS publicado por Presence ('cadetes-disponibles'), solo si ya tiene un fix real (coords_ts)
 * 3. Destino del pedido en curso según la tabla Pedidos
 * 4. Base central, mientras no haya señal de GPS
 */
function resolveCadetePosition(c) {
  // Los cadetes desconectados NUNCA se dibujan en el mapa de red local
  if (!isCadeteActive(c)) {
    return null;
  }

  const viaje = viajeDe(c);
  const telemetria = telemetriaViajeMap.get(claveCadete(c));
  if (viaje && telemetria && telemetria.idPedido === viaje.idPedido) {
    return { lat: telemetria.lat, lng: telemetria.lng, isLive: true, source: telemetria.source };
  }

  // Sin coords_ts el cadete todavía transmite la ubicación por defecto: no es su posición real
  const presencia = presenciaDe(c);
  if (estaConectado(presencia) && presencia.coords_ts) {
    const liveCoords = extractCoordinates(presencia);
    if (liveCoords) {
      return { lat: liveCoords[0], lng: liveCoords[1], isLive: true, source: 'GPS en vivo' };
    }
  }

  if (viaje && viaje.lat && viaje.lng) {
    return { lat: viaje.lat, lng: viaje.lng, isLive: false, source: viaje.source };
  }

  return {
    lat: DEFAULT_CENTER[0],
    lng: DEFAULT_CENTER[1],
    isLive: false,
    source: 'Base Central (Esperando señal GPS)'
  };
}

// De las conexiones de un mismo cadete (varias pestañas o una reconexión) vale la que tiene el turno
// abierto y, entre esas, la del GPS más reciente
function elegirPresencia(presencias) {
  return [...presencias].sort((a, b) =>
    (Number(estaConectado(b)) - Number(estaConectado(a))) || ((b.coords_ts || 0) - (a.coords_ts || 0)))[0];
}

// Cadetes activos: los registrados que están activos, más los conectados que todavía no están en la lista
function listarActivos() {
  const activos = registeredCadetesCache.filter(c => isCadeteActive(c));
  const registrados = new Set(registeredCadetesCache.map(claveCadete));
  activeCadetesMap.forEach((presencia, id) => {
    if (!registrados.has(id) && estaConectado(presencia)) {
      activos.push({
        id_cad: Number(id) || id,
        nombre_cad: presencia.nombre,
        vehiculo_cad: presencia.vehiculo_cad,
        patente: presencia.patente
      });
    }
  });
  return activos;
}

// Cualquier cambio de quién está activo se refleja en todos lados: radar, mapa, lista y tablero
function refrescarTodo() {
  updateRadarUI();
  syncDashboardKPIs();
}

function iniciarRealtime() {
  // 1. Conectar al canal oficial 'cadetes-disponibles' de Presence
  if (!channelPresence) {
    channelPresence = supabase.channel(CADETES_PRESENCE_CHANNEL, {
      config: {
        presence: {
          key: 'admin_dashboard_radar'
        }
      }
    });

    const handlePresenceUpdate = () => {
      const state = channelPresence.presenceState();
      activeCadetesMap.clear();

      for (const key in state) {
        if (key.startsWith('admin_')) continue;

        const presences = state[key];
        if (Array.isArray(presences) && presences.length > 0) {
          const cad = elegirPresencia(presences);
          if (cad) {
            activeCadetesMap.set(String(cad.id_cad ?? cad.id ?? key.replace(/^cad_/, '')), cad);
          }
        }
      }

      refrescarTodo();
    };

    channelPresence
      .on('presence', { event: 'sync' }, () => {
        handlePresenceUpdate();
      })
      .on('presence', { event: 'join' }, () => {
        handlePresenceUpdate();
      })
      .on('presence', { event: 'leave' }, () => {
        handlePresenceUpdate();
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          handlePresenceUpdate();
        }
      });
  }

  // 2. Escuchar cambios de estado en la tabla Cadetes
  if (!channelDbCadetes) {
    channelDbCadetes = supabase.channel('radar_cadetes_table_sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'Cadetes' }, () => {
        fetchRegisteredCadetes();
      })
      .subscribe();
  }

  // 3. Escuchar cambios en la tabla Pedidos para actualizar viajes y ubicaciones
  if (!channelDbPedidos) {
    channelDbPedidos = supabase.channel('radar_pedidos_table_sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'Pedidos' }, () => {
        fetchCadetesLocationsFromDB();
      })
      .subscribe();
  }
}

function syncDashboardKPIs() {
  const activeCount = listarActivos().length;
  const kpiEl = document.getElementById('kpi-cadetes-activos');
  if (kpiEl) kpiEl.innerText = `${activeCount}`;
  const flotaCountEl = document.getElementById('flota-count');
  if (flotaCountEl) flotaCountEl.innerText = `${activeCount}`;

  if (typeof window.cargarFlotaCadetes === 'function') {
    window.cargarFlotaCadetes();
  }
}

window.getActiveCadetesList = () => {
  return listarActivos().map(c => {
    const presence = presenciaDe(c);
    return {
      ...c,
      estado_cad: viajeDe(c) ? 'ocupado' : ((presence && presence.estado_cad) || c.estado_cad || 'disponible')
    };
  });
};

async function fetchRegisteredCadetes() {
  const { data, error } = await supabase.from('Cadetes').select('*').order('id_cad', { ascending: true });
  if (!error && data) {
    registeredCadetesCache = data;
    refrescarTodo();
  }
}

async function fetchCadetesLocationsFromDB() {
  try {
    const { data: pedidos, error } = await supabase
      .from('Pedidos')
      .select('id_pedido, id_cadete, estado_pedido, latitud_dest, longitud_dest, latitud_org, longitud_org, fecha_pedido')
      .not('id_cadete', 'is', null)
      .order('fecha_pedido', { ascending: false })
      .limit(100);

    if (!error && pedidos) {
      // Se arma de nuevo en cada consulta: un viaje que terminó deja de contar al cadete como "en viaje"
      const ubicaciones = new Map();

      pedidos.forEach(p => {
        const cadId = String(p.id_cadete);
        // Viaje en curso = el cadete aceptó y todavía no entregó (una oferta sin aceptar no es un viaje)
        const isActiveTrip = ESTADOS_VIAJE.includes(String(p.estado_pedido || '').toLowerCase());

        // 1. Si el viaje está activo, suscribirse de inmediato al canal de telemetría GPS del viaje
        if (isActiveTrip) {
          suscribirCanalPedidoEnCurso(p.id_pedido, cadId);
        } else if (activeOrderChannels.has(p.id_pedido)) {
          // Si el pedido ya finalizó, desuscribir el canal
          const oldChan = activeOrderChannels.get(p.id_pedido);
          supabase.removeChannel(oldChan);
          activeOrderChannels.delete(p.id_pedido);
        }

        // 2. Guardar ubicación de referencia. Vienen del más nuevo al más viejo: manda el viaje en curso
        const anterior = ubicaciones.get(cadId);
        if (!anterior || (isActiveTrip && !anterior.isEnCurso)) {
          const lat = Number(p.latitud_dest || p.latitud_org);
          const lng = Number(p.longitud_dest || p.longitud_org);
          const conCoords = Boolean(lat && lng) && !isNaN(lat) && !isNaN(lng);

          if (conCoords || isActiveTrip) {
            ubicaciones.set(cadId, {
              lat: conCoords ? lat : null,
              lng: conCoords ? lng : null,
              isEnCurso: isActiveTrip,
              idPedido: p.id_pedido,
              source: isActiveTrip ? `Destino Pedido #TD-${p.id_pedido} (En viaje)` : `Última entrega Pedido #TD-${p.id_pedido}`
            });
          }
        }
      });

      cadetesLastLocationMap = ubicaciones;
      // El GPS de un viaje que ya terminó no se sigue mostrando
      telemetriaViajeMap.forEach((t, cadId) => {
        const viaje = ubicaciones.get(cadId);
        if (!viaje || !viaje.isEnCurso || viaje.idPedido !== t.idPedido) telemetriaViajeMap.delete(cadId);
      });

      refrescarTodo();
    }
  } catch (e) {
    console.warn('[Radar] Error consultando ubicaciones de pedidos:', e);
  }
}

function suscribirCanalPedidoEnCurso(idPedido, idCadete) {
  if (activeOrderChannels.has(idPedido)) return;

  const chan = supabase.channel(`pedido-en-curso-${idPedido}`);
  chan.on('broadcast', { event: 'ubicacion_cadete' }, ({ payload }) => {
    if (payload) {
      const lat = payload.coords?.lat ?? payload.coords?.latitude ?? payload.lat;
      const lng = payload.coords?.lng ?? payload.coords?.longitude ?? payload.lng;
      const cadId = String(payload.id_cadete || idCadete);

      if (lat !== undefined && lng !== undefined && !isNaN(Number(lat)) && !isNaN(Number(lng))) {
        const primera = !telemetriaViajeMap.has(cadId);

        // 1. Guardar el GPS del viaje (aparte de Presence: un sync de presencia no lo borra)
        telemetriaViajeMap.set(cadId, {
          lat: Number(lat),
          lng: Number(lng),
          idPedido,
          source: `GPS en viaje (Pedido #TD-${idPedido})`
        });

        // 2. Mover suavemente el marcador si ya existe en Leaflet
        let foundMarker = null;
        if (leafletMap && markersLayer) {
          markersLayer.eachLayer(layer => {
            if (layer.cadeteData && claveCadete(layer.cadeteData) === cadId) {
              foundMarker = layer;
            }
          });
        }

        if (foundMarker) {
          foundMarker.setLatLng([Number(lat), Number(lng)]);
        } else {
          updateMapMarkers();
        }
        if (primera) refrescarTodo();
      }
    }
  }).subscribe();

  activeOrderChannels.set(idPedido, chan);
}

function updateRadarUI() {
  const radar = document.querySelector('.radar');
  if (radar) {
    const oldBlips = radar.querySelectorAll('.radar-blip');
    oldBlips.forEach(b => b.remove());
  }

  let activeCount = 0;

  registeredCadetesCache.forEach(c => {
    if (isCadeteActive(c)) {
      activeCount++;
      if (radar) {
        const top = Math.floor(Math.random() * 60) + 20;
        const left = Math.floor(Math.random() * 60) + 20;
        const delay = (Math.random() * 2).toFixed(1);

        const blip = document.createElement('div');
        blip.className = 'radar-blip';
        blip.style.top = `${top}%`;
        blip.style.left = `${left}%`;
        blip.style.animationDelay = `${delay}s`;

        if (isCadeteBusy(c)) {
          blip.style.background = '#E63946';
          blip.style.boxShadow = '0 0 6px 1px rgba(230,57,70,.7)';
        }

        radar.appendChild(blip);
      }
    }
  });

  // Más los conectados que todavía no figuran en la lista de registrados
  activeCount = listarActivos().length;

  // Actualizar contador del radar en sidebar
  const countElUpdate = document.getElementById('radar-cadetes-count');
  if (countElUpdate) {
    countElUpdate.innerHTML = `${activeCount} unidades <span class="text-emerald-400 font-semibold">activas</span>`;
  }

  // Actualizar contador en el modal
  const modalCountEl = document.getElementById('modal-cadetes-count');
  if (modalCountEl) {
    modalCountEl.innerText = activeCount;
  }

  updateMapMarkers();
  updateModalList();
}

function injectLeafletAssets() {
  if (!document.getElementById('leaflet-css')) {
    const link = document.createElement('link');
    link.id = 'leaflet-css';
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(link);
  }

  // Estilo Dark Mode para OpenStreetMap y limpieza de marcadores
  if (!document.getElementById('leaflet-dark-style')) {
    const style = document.createElement('style');
    style.id = 'leaflet-dark-style';
    style.innerHTML = `
      #radar-leaflet-map .leaflet-tile {
        filter: brightness(0.65) invert(1) contrast(2.8) hue-rotate(200deg) saturate(0.3) brightness(0.7);
      }
      #radar-leaflet-map {
        background: #121217 !important;
      }
      .leaflet-div-icon, .custom-radar-marker {
        background: transparent !important;
        border: none !important;
      }
      .leaflet-popup-content-wrapper {
        background: #18181F !important;
        color: #F4F4F5 !important;
        border: 1px solid #27272A;
        border-radius: 16px !important;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.7) !important;
      }
      .leaflet-popup-tip {
        background: #18181F !important;
      }
      .leaflet-container a {
        color: #E63946 !important;
      }
      .radar-tooltip {
        background: #18181F !important;
        color: #F4F4F5 !important;
        border: 1px solid #27272A !important;
        border-radius: 8px !important;
        font-family: 'Plus Jakarta Sans', sans-serif !important;
        font-size: 11px !important;
        font-weight: 600 !important;
        padding: 4px 8px !important;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5) !important;
      }
      .radar-tooltip::before {
        border-top-color: #18181F !important;
      }
      @keyframes radar-ring-pulse {
        0% { transform: scale(1); opacity: 0.8; }
        50% { transform: scale(1.4); opacity: 0.3; }
        100% { transform: scale(1.8); opacity: 0; }
      }
      .marker-pulse-ring {
        position: absolute;
        inset: -5px;
        border-radius: 50%;
        animation: radar-ring-pulse 2s cubic-bezier(0, 0, 0.2, 1) infinite;
      }
    `;
    document.head.appendChild(style);
  }

  if (window.L) {
    leafletLoaded = true;
  } else if (!document.getElementById('leaflet-js')) {
    const script = document.createElement('script');
    script.id = 'leaflet-js';
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => {
      leafletLoaded = true;
    };
    document.head.appendChild(script);
  }
}

function injectModalHTML() {
  if (document.getElementById('radar-map-modal')) return;

  const modal = document.createElement('div');
  modal.id = 'radar-map-modal';
  modal.className = 'fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-6 hidden opacity-0 transition-opacity duration-300';
  modal.onclick = (e) => {
    if (e.target === modal) window.closeRadarMapModal();
  };
  modal.innerHTML = `
    <div id="radar-map-card" class="modal-alto-movil w-full max-w-5xl h-[90vh] sm:h-[85vh] bg-brand-card border border-brand-border rounded-3xl flex flex-col shadow-2xl scale-95 transition-transform duration-300 overflow-hidden">
      <!-- Modal Header -->
      <div class="h-16 px-3 sm:px-6 bg-brand-dark/95 border-b border-brand-border flex items-center justify-between gap-2 shrink-0">
        <div class="flex items-center gap-3 min-w-0">
          <div class="hidden sm:block p-2.5 rounded-xl bg-brand-accent/10 text-brand-accent border border-brand-accent/20 shrink-0">
            <i data-lucide="map-pin" class="w-5 h-5"></i>
          </div>
          <div class="min-w-0">
            <h3 class="text-sm sm:text-base font-bold text-white flex items-center gap-2 min-w-0">
              <span class="truncate"><span class="hidden sm:inline">Red Local en Vivo · </span>Mapa de Cadetes</span>
              <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap shrink-0 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span> <span id="modal-cadetes-count">0</span> Activos
              </span>
            </h3>
            <p class="text-[11px] text-zinc-400 hidden sm:block">Monitoreo geolocalizado en tiempo real vía socket y base de datos</p>
          </div>
        </div>
        
        <div class="flex items-center gap-2 shrink-0">
          <button onclick="window.recenterRadarMap()" title="Centrar mapa en cadetes" class="p-2 rounded-xl bg-brand-dark border border-brand-border text-zinc-400 hover:text-white hover:border-zinc-500 transition-all text-xs flex items-center gap-1.5">
            <i data-lucide="crosshair" class="w-4 h-4"></i> <span class="hidden sm:inline">Centrar</span>
          </button>
          <button onclick="window.closeRadarMapModal()" class="p-2 rounded-xl bg-brand-dark border border-brand-border text-zinc-400 hover:text-white hover:border-zinc-500 transition-all">
            <i data-lucide="x" class="w-5 h-5"></i>
          </button>
        </div>
      </div>

      <!-- Map Container + Sidebar List -->
      <div class="flex-1 flex flex-col md:flex-row relative overflow-hidden">
        <!-- Map Container -->
        <div id="radar-leaflet-map" class="flex-1 w-full h-full bg-zinc-950 min-h-[200px] md:min-h-[300px]"></div>

        <!-- Cadetes sidebar list inside modal -->
        <div class="w-full md:w-80 bg-brand-dark/95 border-t md:border-t-0 md:border-l border-brand-border p-3 sm:p-4 flex flex-col h-[32%] min-h-[9rem] md:h-full shrink-0">
          <h4 class="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-3 flex items-center justify-between">
            <span>Cadetes Registrados</span>
            <span id="modal-list-count" class="text-[10px] text-zinc-400 font-mono">0 registrados</span>
          </h4>
          <div id="modal-cadetes-list" class="flex-1 overflow-y-auto space-y-2 pr-1">
            <!-- Dynamic list items -->
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

function initMapInstance() {
  if (leafletMap) return;
  if (!window.L) return;

  const mapContainer = document.getElementById('radar-leaflet-map');
  if (!mapContainer) return;

  leafletMap = window.L.map('radar-leaflet-map', {
    center: DEFAULT_CENTER,
    zoom: 14,
    zoomControl: true
  });

  window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(leafletMap);

  markersLayer = window.L.layerGroup().addTo(leafletMap);
}

function fitMapToMarkers() {
  if (!leafletMap || !markersLayer || !window.L) return;
  const layers = markersLayer.getLayers();
  if (layers.length > 0) {
    const group = window.L.featureGroup(layers);
    leafletMap.fitBounds(group.getBounds().pad(0.25), { maxZoom: 16 });
  } else {
    leafletMap.setView(DEFAULT_CENTER, 14);
  }
}

function renderMarkerItem(cadeteObj, pos, isActive, isBusy) {
  const lat = pos.lat;
  const lng = pos.lng;

  const name = cadeteObj.nombre_cad || cadeteObj.nombre || `Cadete #${cadeteObj.id_cad || '---'}`;
  const initials = name.split(' ').map(n=>n[0]).join('').substring(0, 2).toUpperCase();
  const vehicle = cadeteObj.vehiculo_cad || cadeteObj.vehiculo || 'Moto';
  
  let statusText = 'Desconectado';
  let colorClass = '#71717A';
  let bgPulse = '';

  if (isActive) {
    if (isBusy) {
      statusText = 'En viaje';
      colorClass = '#E63946';
      bgPulse = 'rgba(230, 57, 70, 0.4)';
    } else {
      statusText = 'Libre / Activo';
      colorClass = '#10B981';
      bgPulse = 'rgba(16, 185, 129, 0.4)';
    }
  }

  const customIcon = window.L.divIcon({
    className: 'custom-radar-marker',
    html: `
      <div style="
        position: relative;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: #18181F;
        border: 2px solid ${colorClass};
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 800;
        font-size: 11px;
        color: #FFFFFF;
        box-shadow: 0 4px 14px rgba(0,0,0,0.6);
        cursor: pointer;
      ">
        ${isActive ? `
          <span class="marker-pulse-ring" style="border: 2px solid ${colorClass}; background: ${bgPulse};"></span>
        ` : ''}
        ${initials}
      </div>
    `,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    popupAnchor: [0, -22]
  });

  const marker = window.L.marker([lat, lng], { icon: customIcon });

  marker.bindTooltip(`<strong>${name}</strong> • ${statusText}`, {
    direction: 'top',
    offset: [0, -20],
    className: 'radar-tooltip'
  });

  const popupContent = `
    <div style="font-family: 'Plus Jakarta Sans', sans-serif; min-width: 180px; padding: 2px;">
      <div style="font-weight: 800; font-size: 13px; color: #FFFFFF; margin-bottom: 2px;">${name}</div>
      <div style="font-size: 11px; color: #A1A1AA; margin-bottom: 6px;">ID: #${cadeteObj.id_cad || '---'} • ${vehicle}</div>
      <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; margin-bottom: 4px;">
        <span style="width: 8px; height: 8px; border-radius: 50%; background: ${colorClass}; display: inline-block;"></span>
        <strong style="color: ${isActive ? (isBusy ? '#F87171' : '#34D399') : '#A1A1AA'};">${statusText}</strong>
      </div>
      <div style="font-size: 10px; color: #71717A; margin-bottom: 4px;">📍 ${pos.source}</div>
      <div style="font-size: 9px; font-family: monospace; color: #52525B;">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
      ${cadeteObj.telef_cad ? `<div style="font-size: 10px; color: #71717A; border-top: 1px solid #27272A; padding-top: 4px; margin-top: 4px;"><a href="tel:${cadeteObj.telef_cad}" style="color: #E63946; text-decoration: none;">📞 ${cadeteObj.telef_cad}</a></div>` : ''}
    </div>
  `;

  marker.bindPopup(popupContent);
  marker.cadeteData = cadeteObj;
  marker.addTo(markersLayer);
}

function updateMapMarkers() {
  if (!leafletMap || !markersLayer || !window.L) return;

  markersLayer.clearLayers();

  const renderedCadeteIds = new Set();

  // 1. Graficar ÚNICAMENTE cadetes que se encuentren ACTIVOS o en viaje
  registeredCadetesCache.forEach((c) => {
    const isActive = isCadeteActive(c);
    if (!isActive) {
      // Cadete desconectado: NO se dibuja en el mapa
      return;
    }

    const isBusy = isCadeteBusy(c);
    const pos = resolveCadetePosition(c);
    if (!pos) return;

    renderMarkerItem(c, pos, isActive, isBusy);
    if (c.id_cad) renderedCadeteIds.add(String(c.id_cad));
  });

  // 2. Graficar cadetes conectados por presencia que no figuren aún en cache de registrados
  listarActivos().forEach((c) => {
    if (renderedCadeteIds.has(claveCadete(c))) return;
    const pos = resolveCadetePosition(c);
    if (pos) renderMarkerItem(c, pos, true, isCadeteBusy(c));
  });
}

function updateModalList() {
  const listEl = document.getElementById('modal-cadetes-list');
  const countEl = document.getElementById('modal-cadetes-count');
  const listCountEl = document.getElementById('modal-list-count');
  if (!listEl) return;

  listEl.innerHTML = '';

  const totalRegistrados = registeredCadetesCache.length;
  const totalActivos = listarActivos().length;

  if (countEl) countEl.innerText = totalActivos;
  if (listCountEl) listCountEl.innerText = `${totalRegistrados} registrados`;

  if (registeredCadetesCache.length === 0) {
    listEl.innerHTML = '<p class="text-xs text-zinc-500 italic p-3 text-center">No hay cadetes registrados en la base de datos.</p>';
    return;
  }

  registeredCadetesCache.forEach((c, index) => {
    const isActive = isCadeteActive(c);
    const isBusy = isCadeteBusy(c);
    const pos = resolveCadetePosition(c);
    
    const name = c.nombre_cad || c.nombre || `Cadete #${c.id_cad || index + 1}`;
    const initials = name.split(' ').map(n=>n[0]).join('').substring(0, 2).toUpperCase();
    const vehicle = c.vehiculo_cad || c.vehiculo || 'Moto';

    let badgeClass = 'text-zinc-400 bg-zinc-800 border border-zinc-700';
    let badgeText = 'Desconectado';

    if (isActive) {
      if (isBusy) {
        badgeClass = 'text-brand-accent bg-brand-accent/10 border border-brand-accent/20';
        badgeText = 'En viaje';
      } else {
        badgeClass = 'text-emerald-400 bg-emerald-500/10 border border-emerald-500/20';
        badgeText = 'Activo';
      }
    }

    const subText = isActive ? (isBusy ? 'En viaje' : `${vehicle} • Disponible`) : 'Desconectado';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.onclick = () => window.focusCadeteOnMap(c.id_cad || index);
    btn.className = 'w-full flex items-center justify-between p-2.5 rounded-xl bg-brand-card border border-brand-border hover:border-brand-accent/50 text-left transition-all group';
    btn.innerHTML = `
      <div class="flex items-center gap-2.5">
        <div class="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center font-bold text-xs text-white border border-brand-border">
          ${initials}
        </div>
        <div>
          <h5 class="text-xs font-bold text-white group-hover:text-brand-accent transition-colors truncate max-w-[120px]">${name}</h5>
          <p class="text-[10px] text-zinc-400">${subText}</p>
        </div>
      </div>
      <span class="text-[10px] font-semibold px-2 py-0.5 rounded ${badgeClass}">
        ${badgeText}
      </span>
    `;
    listEl.appendChild(btn);
  });
}

// Expuestas al window
window.openRadarMapModal = () => {
  injectModalHTML();
  fetchRegisteredCadetes();
  fetchCadetesLocationsFromDB();
  
  const m = document.getElementById('radar-map-modal');
  const c = document.getElementById('radar-map-card');
  if (m && c) {
    m.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
    setTimeout(() => {
      m.classList.add('opacity-100');
      c.classList.remove('scale-95');
    }, 10);
  }

  const checkAndInitMap = () => {
    if (window.L) {
      initMapInstance();
      updateMapMarkers();
      updateModalList();
      setTimeout(() => {
        if (leafletMap) {
          leafletMap.invalidateSize();
          fitMapToMarkers();
        }
      }, 300);
    } else {
      setTimeout(checkAndInitMap, 100);
    }
  };

  checkAndInitMap();

  if (window.lucide) window.lucide.createIcons();
};

window.closeRadarMapModal = () => {
  const m = document.getElementById('radar-map-modal');
  const c = document.getElementById('radar-map-card');
  if (m && c) {
    m.classList.remove('opacity-100');
    c.classList.add('scale-95');
    document.body.classList.remove('overflow-hidden');
    setTimeout(() => m.classList.add('hidden'), 300);
  }
};

window.recenterRadarMap = () => {
  fitMapToMarkers();
};

window.focusCadeteOnMap = (cadeteId) => {
  if (!markersLayer || !leafletMap) return;
  let targetLayer = null;
  markersLayer.eachLayer(layer => {
    if (layer.cadeteData && (String(layer.cadeteData.id_cad) === String(cadeteId) || String(layer.cadeteData.id) === String(cadeteId))) {
      targetLayer = layer;
    }
  });

  if (targetLayer) {
    leafletMap.flyTo(targetLayer.getLatLng(), 16, { duration: 0.8 });
    setTimeout(() => {
      targetLayer.openPopup();
    }, 850);
  } else {
    const cad = registeredCadetesCache.find(c => String(c.id_cad) === String(cadeteId));
    const name = cad ? (cad.nombre_cad || cad.nombre) : 'El cadete';
    alert(`${name} se encuentra actualmente desconectado y no aparece en el mapa.`);
  }
};

// Iniciar radar inmediatamente o al cargar el DOM
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => {
    initSidebarRadar();
  });
} else {
  initSidebarRadar();
}

window.initSidebarRadar = initSidebarRadar;
