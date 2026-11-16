import { supabase } from './conexion_supabase.js';
import { cargarEstiloMapa } from './mapa_td.js';

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

// Mapa (MapLibre, con el mismo estilo, 3D/2D y controles que la app de cadetes)
let mapa = null;
let creandoMapa = false;
let sinMapa = false;                    // sin WebGL o sin MapLibre: queda solo la lista
const marcadores = new Map();           // id del cadete → { marker, el, popup, firma }
let puckAdmin = null;                   // "Vos": la ubicación de quien mira el panel
let registeredCadetesCache = [];

// Coordenadas base por defecto: San Juan Centro (Plaza 25 de Mayo)
const DEFAULT_CENTER = [-31.5375, -68.5364];
const CENTRO_MAPA = [DEFAULT_CENTER[1], DEFAULT_CENTER[0]]; // MapLibre usa [lng, lat]

// Vista 3D (inclinada) o 2D; se recuerda entre visitas como en la app de cadetes
const PREFS_MAPA = 'td_admin_mapa_prefs';
const prefsMapa = (() => { try { return JSON.parse(localStorage.getItem(PREFS_MAPA)) || {}; } catch { return {}; } })();
const camara = { inclinado: prefsMapa.inclinado !== false };
const PITCH_3D = 50;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export function initSidebarRadar() {
  injectMapAssets();
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

        // 2. Mover el marcador si ya está en el mapa
        const existente = marcadores.get(cadId);
        if (existente) {
          existente.marker.setLngLat([Number(lng), Number(lat)]);
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

function injectMapAssets() {
  if (!document.getElementById('maplibre-css')) {
    const link = document.createElement('link');
    link.id = 'maplibre-css';
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css';
    document.head.appendChild(link);
  }

  // Mapa, marcadores y controles con el mismo diseño que la app de cadetes
  if (!document.getElementById('radar-mapa-estilo')) {
    const style = document.createElement('style');
    style.id = 'radar-mapa-estilo';
    style.textContent = `
      #radar-mapa-zona { position: relative; flex: 1 1 0%; min-height: 200px; }
      @media (min-width: 768px) { #radar-mapa-zona { min-height: 300px; } }
      #radar-mapa { position: absolute; inset: 0; background: #0B0E14; }
      #radar-mapa-fallback {
        position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
        padding: 24px; text-align: center; color: #A1A1AA; font-size: 12px; background: #0B0E14;
      }
      #radar-mapa.sin-mapa ~ #radar-mapa-fallback { display: flex; }
      #radar-mapa.sin-mapa ~ .radar-controles { display: none; }

      #radar-mapa .maplibregl-ctrl-attrib { background: rgba(0, 0, 0, .55) !important; font-size: 8px !important; line-height: 1.4; }
      #radar-mapa .maplibregl-ctrl-attrib a { color: #8E9AA8 !important; }
      #radar-mapa .maplibregl-ctrl-attrib-button { filter: invert(1); opacity: .5; }

      /* Controles flotantes: brújula, 3D / 2D y mi ubicación */
      .radar-controles { position: absolute; right: 12px; bottom: 28px; z-index: 2; display: flex; flex-direction: column; gap: 10px; }
      .radar-btn {
        width: 44px; height: 44px; border-radius: 9999px; cursor: pointer;
        background: rgba(17, 19, 24, .96); border: 1px solid rgba(255, 255, 255, .09);
        box-shadow: 0 8px 22px rgba(0, 0, 0, .5);
        display: flex; align-items: center; justify-content: center; color: #fff;
        transition: transform .15s, border-color .25s, color .25s;
      }
      .radar-btn:hover { border-color: rgba(255, 255, 255, .25); }
      .radar-btn:active { transform: scale(.9); }
      .radar-btn.activo { border-color: rgba(230, 57, 70, .6); color: #E63946; }
      .radar-btn svg { width: 22px; height: 22px; }
      #radar-aguja { transition: transform .12s linear; width: 26px; height: 26px; }
      .radar-tilt {
        position: relative; width: 44px; height: 78px; padding: 4px; border-radius: 9999px; cursor: pointer;
        background: rgba(17, 19, 24, .96); border: 1px solid rgba(255, 255, 255, .09);
        box-shadow: 0 8px 22px rgba(0, 0, 0, .5);
        display: flex; flex-direction: column; transition: transform .15s;
      }
      .radar-tilt:active { transform: scale(.94); }
      .radar-tilt__marca {
        position: absolute; left: 4px; right: 4px; top: 4px; height: 34px; border-radius: 9999px;
        background: #E63946; transition: transform .3s cubic-bezier(.34, 1.4, .64, 1);
      }
      .radar-tilt.plano .radar-tilt__marca { transform: translateY(34px); }
      .radar-tilt__op {
        position: relative; flex: 1; display: flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 900; color: #8E9AA8; transition: color .25s;
      }
      .radar-tilt:not(.plano) [data-op="3d"], .radar-tilt.plano [data-op="2d"] { color: #fff; }

      #radar-mapa-aviso {
        position: absolute; left: 50%; top: 14px; z-index: 3; transform: translateX(-50%);
        background: rgba(17, 19, 24, .96); border: 1px solid rgba(255, 255, 255, .1); color: #fff;
        font-size: 12px; font-weight: 700; padding: 8px 14px; border-radius: 9999px;
        box-shadow: 0 8px 22px rgba(0, 0, 0, .5); transition: opacity .25s, transform .25s; white-space: nowrap;
      }
      #radar-mapa-aviso.oculto { opacity: 0; transform: translate(-50%, -6px); pointer-events: none; }

      /* Cadetes: círculo con iniciales, borde del color del estado y pulso si está activo */
      .radar-cad {
        position: relative; width: 40px; height: 40px; border-radius: 50%; cursor: pointer;
        background: #18181F; border: 2px solid var(--color);
        display: flex; align-items: center; justify-content: center;
        font-family: 'Plus Jakarta Sans', sans-serif; font-weight: 800; font-size: 11px; color: #fff;
        box-shadow: 0 4px 14px rgba(0, 0, 0, .6);
      }
      .radar-cad__pulso {
        position: absolute; inset: -5px; border-radius: 50%; border: 2px solid var(--color); background: var(--pulso);
        animation: radar-ring-pulse 2s cubic-bezier(0, 0, .2, 1) infinite; pointer-events: none;
      }
      @keyframes radar-ring-pulse {
        0% { transform: scale(1); opacity: .8; }
        50% { transform: scale(1.4); opacity: .3; }
        100% { transform: scale(1.8); opacity: 0; }
      }

      /* "Vos": punto azul con halo, como el GPS de la app de cadetes */
      .radar-yo { position: relative; width: 44px; height: 44px; pointer-events: none; }
      .radar-yo__halo { position: absolute; inset: 8px; border-radius: 9999px; background: rgba(59, 130, 246, .35); animation: radar-yo-pulso 2.2s ease-out infinite; }
      .radar-yo__punto { position: absolute; inset: 13px; border-radius: 9999px; background: #3B82F6; border: 3px solid #fff; box-shadow: 0 4px 14px rgba(0, 0, 0, .55); }
      @keyframes radar-yo-pulso { 0% { transform: scale(.8); opacity: .9; } 100% { transform: scale(2.2); opacity: 0; } }

      @media (prefers-reduced-motion: reduce) {
        .radar-cad__pulso, .radar-yo__halo { animation: none; }
      }

      /* Ventana del cadete al tocarlo */
      .radar-popup .maplibregl-popup-content {
        background: #18181F; color: #F4F4F5; border: 1px solid #27272A; border-radius: 16px;
        padding: 10px 12px; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, .7);
      }
      .radar-popup.maplibregl-popup-anchor-bottom .maplibregl-popup-tip { border-top-color: #18181F; }
      .radar-popup.maplibregl-popup-anchor-top .maplibregl-popup-tip { border-bottom-color: #18181F; }
      .radar-popup.maplibregl-popup-anchor-left .maplibregl-popup-tip { border-right-color: #18181F; }
      .radar-popup.maplibregl-popup-anchor-right .maplibregl-popup-tip { border-left-color: #18181F; }
      .radar-popup a { color: #E63946; text-decoration: none; }
    `;
    document.head.appendChild(style);
  }

  if (!window.maplibregl && !document.getElementById('maplibre-js')) {
    const script = document.createElement('script');
    script.id = 'maplibre-js';
    script.src = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js';
    script.onerror = () => {
      sinMapa = true;
      document.getElementById('radar-mapa')?.classList.add('sin-mapa');
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
        <!-- Mapa con sus controles flotantes -->
        <div id="radar-mapa-zona">
          <div id="radar-mapa"></div>
          <div id="radar-mapa-fallback">No se pudo cargar el mapa en este navegador. La lista de cadetes sigue funcionando.</div>
          <div id="radar-mapa-aviso" class="oculto" role="status" aria-live="polite"></div>
          <div class="radar-controles">
            <button type="button" id="radar-btn-brujula" class="radar-btn" title="Apuntar al norte" aria-label="Apuntar al norte" onclick="window.radarMapaNorte()">
              <svg id="radar-aguja" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 2.5 15.2 12H8.8z" fill="#FF3B30"></path>
                <path d="M12 21.5 8.8 12h6.4z" fill="currentColor" opacity=".75"></path>
                <circle cx="12" cy="12" r="1.6" fill="#111318"></circle>
              </svg>
            </button>
            <button type="button" id="radar-btn-tilt" class="radar-tilt" title="Vista del mapa: 2D o 3D" aria-label="Vista del mapa en 3D" aria-pressed="true" onclick="window.radarMapaTilt()">
              <i class="radar-tilt__marca" aria-hidden="true"></i>
              <span class="radar-tilt__op" data-op="3d">3D</span>
              <span class="radar-tilt__op" data-op="2d">2D</span>
            </button>
            <button type="button" id="radar-btn-gps" class="radar-btn" title="Ir a mi ubicación" aria-label="Ir a mi ubicación" onclick="window.radarMapaMiUbicacion()">
              <svg fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true">
                <polygon points="3 11 22 2 13 21 11 13 3 11"></polygon>
              </svg>
            </button>
          </div>
        </div>

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
  actualizarBotonesMapa();
}

function mapaNoDisponible() {
  sinMapa = true;
  document.getElementById('radar-mapa')?.classList.add('sin-mapa');
}

async function initMapInstance() {
  if (mapa || creandoMapa || sinMapa || !window.maplibregl) return;
  const contenedor = document.getElementById('radar-mapa');
  if (!contenedor) return;
  creandoMapa = true;

  try {
    const estilo = await cargarEstiloMapa();
    mapa = new window.maplibregl.Map({
      container: contenedor,
      style: estilo,
      center: CENTRO_MAPA,
      zoom: 14,
      pitch: camara.inclinado ? PITCH_3D : 0,   // arranca con la vista elegida la última vez
      maxPitch: 65,
      attributionControl: false,
      fadeDuration: 150
    });
  } catch (e) {
    console.warn('[Radar] No se pudo crear el mapa (¿sin WebGL?):', e);
    creandoMapa = false;
    return mapaNoDisponible();
  }

  mapa.addControl(new window.maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  // Si la ventana cambia de tamaño (o se creó mientras se abría), el lienzo acompaña
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => mapa?.resize()).observe(document.getElementById('radar-mapa-zona'));
  }
  mapa.on('rotate', actualizarAgujaBrujula);
  // Si inclina el mapa con el mouse (clic derecho o Ctrl + arrastrar), el selector 2D/3D acompaña lo que se ve
  mapa.on('pitchend', (e) => {
    if (!e.originalEvent) return;
    const inclinado = mapa.getPitch() > 15;
    if (inclinado === camara.inclinado) return;
    camara.inclinado = inclinado;
    guardarPrefsMapa();
    actualizarBotonesMapa();
  });

  creandoMapa = false;
  updateMapMarkers();
  actualizarBotonesMapa();
}

function guardarPrefsMapa() {
  localStorage.setItem(PREFS_MAPA, JSON.stringify({ inclinado: camara.inclinado }));
}

function actualizarBotonesMapa() {
  const tilt = document.getElementById('radar-btn-tilt');
  if (tilt) {
    tilt.classList.toggle('plano', !camara.inclinado);
    tilt.setAttribute('aria-pressed', String(camara.inclinado));
  }
  document.getElementById('radar-btn-gps')?.classList.toggle('activo', Boolean(puckAdmin));
  actualizarAgujaBrujula();
}

function actualizarAgujaBrujula() {
  const aguja = document.getElementById('radar-aguja');
  if (aguja) aguja.style.transform = `rotate(${-(mapa ? mapa.getBearing() : 0)}deg)`;
}

let avisoMapaTimer = null;
function mostrarAvisoMapa(texto) {
  const aviso = document.getElementById('radar-mapa-aviso');
  if (!aviso) return;
  aviso.textContent = texto;
  aviso.classList.remove('oculto');
  clearTimeout(avisoMapaTimer);
  avisoMapaTimer = setTimeout(() => aviso.classList.add('oculto'), 2600);
}

// Encuadra a todos los cadetes del mapa (y a "Vos", si se mostró la ubicación propia)
function fitMapToMarkers() {
  if (!mapa) return;
  const pitch = camara.inclinado ? PITCH_3D : 0;
  const puntos = [...marcadores.values()].map(m => m.marker.getLngLat());
  if (puckAdmin) puntos.push(puckAdmin.getLngLat());

  if (puntos.length === 0) {
    mapa.easeTo({ center: CENTRO_MAPA, zoom: 14, pitch, bearing: 0, duration: 900 });
    return;
  }
  const caja = new window.maplibregl.LngLatBounds();
  puntos.forEach(p => caja.extend(p));
  // El encuadre se calcula plano; inclinado, el fondo se aleja, así que se abre un poco más
  const cam = mapa.cameraForBounds(caja, { padding: 70, bearing: 0, maxZoom: 16 });
  if (!cam) return mapa.easeTo({ pitch, bearing: 0, duration: 700 });
  mapa.easeTo({
    center: cam.center,
    zoom: Math.min(16, cam.zoom - (camara.inclinado ? 0.6 : 0)),
    pitch, bearing: 0, duration: 900, essential: true
  });
}

function datosMarcador(cadeteObj, isActive, isBusy) {
  const name = cadeteObj.nombre_cad || cadeteObj.nombre || `Cadete #${cadeteObj.id_cad || '---'}`;
  const initials = name.split(' ').filter(Boolean).map(n => n[0]).join('').substring(0, 2).toUpperCase();
  let statusText = 'Desconectado';
  let color = '#71717A';
  let pulso = 'transparent';
  if (isActive) {
    if (isBusy) {
      statusText = 'En viaje';
      color = '#E63946';
      pulso = 'rgba(230, 57, 70, 0.4)';
    } else {
      statusText = 'Libre / Activo';
      color = '#10B981';
      pulso = 'rgba(16, 185, 129, 0.4)';
    }
  }
  return { name, initials, statusText, color, pulso };
}

function contenidoPopup(cadeteObj, pos, isActive, isBusy, d) {
  const vehicle = cadeteObj.vehiculo_cad || cadeteObj.vehiculo || 'Moto';
  const colorTexto = isActive ? (isBusy ? '#F87171' : '#34D399') : '#A1A1AA';
  const telefono = cadeteObj.telef_cad ? String(cadeteObj.telef_cad) : '';
  return `
    <div style="font-family: 'Plus Jakarta Sans', sans-serif; min-width: 180px; padding: 2px;">
      <div style="font-weight: 800; font-size: 13px; color: #FFFFFF; margin-bottom: 2px;">${esc(d.name)}</div>
      <div style="font-size: 11px; color: #A1A1AA; margin-bottom: 6px;">ID: #${esc(cadeteObj.id_cad || '---')} • ${esc(vehicle)}</div>
      <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; margin-bottom: 4px;">
        <span style="width: 8px; height: 8px; border-radius: 50%; background: ${d.color}; display: inline-block;"></span>
        <strong style="color: ${colorTexto};">${d.statusText}</strong>
      </div>
      <div style="font-size: 10px; color: #71717A; margin-bottom: 4px;">📍 ${esc(pos.source)}</div>
      <div style="font-size: 9px; font-family: monospace; color: #52525B;">${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}</div>
      ${telefono ? `<div style="font-size: 10px; color: #71717A; border-top: 1px solid #27272A; padding-top: 4px; margin-top: 4px;"><a href="tel:${esc(telefono.replace(/[^\d+]/g, ''))}">📞 ${esc(telefono)}</a></div>` : ''}
    </div>
  `;
}

// Crea o actualiza el marcador de un cadete (sin rehacerlo: así no parpadea ni se cierra su ventana)
function renderMarkerItem(cadeteObj, pos, isActive, isBusy) {
  const id = claveCadete(cadeteObj);
  const d = datosMarcador(cadeteObj, isActive, isBusy);
  const firma = `${d.initials}|${d.color}`;
  let item = marcadores.get(id);

  if (!item) {
    const el = document.createElement('div');
    const popup = new window.maplibregl.Popup({ offset: 24, closeButton: false, className: 'radar-popup', maxWidth: '260px' });
    const marker = new window.maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat([pos.lng, pos.lat])
      .setPopup(popup)
      .addTo(mapa);
    item = { marker, el, popup, firma: '' };
    marcadores.set(id, item);
  } else {
    item.marker.setLngLat([pos.lng, pos.lat]);
  }

  if (item.firma !== firma) {
    item.el.innerHTML = `
      <div class="radar-cad" style="--color: ${d.color}; --pulso: ${d.pulso};">
        ${isActive ? '<span class="radar-cad__pulso"></span>' : ''}
        <span></span>
      </div>`;
    item.el.querySelector('.radar-cad > span:last-child').textContent = d.initials;
    item.firma = firma;
  }
  item.el.title = `${d.name} • ${d.statusText}`;
  item.popup.setHTML(contenidoPopup(cadeteObj, pos, isActive, isBusy, d));
  item.cadete = cadeteObj;
}

function updateMapMarkers() {
  if (!mapa) return;

  const dibujados = new Set();
  const dibujar = (c, isBusy) => {
    const pos = resolveCadetePosition(c);
    if (!pos) return;
    renderMarkerItem(c, pos, true, isBusy);
    dibujados.add(claveCadete(c));
  };

  // 1. Graficar ÚNICAMENTE cadetes que se encuentren ACTIVOS o en viaje (los desconectados no se dibujan)
  registeredCadetesCache.forEach((c) => {
    if (isCadeteActive(c)) dibujar(c, isCadeteBusy(c));
  });

  // 2. Graficar cadetes conectados por presencia que no figuren aún en cache de registrados
  listarActivos().forEach((c) => {
    if (!dibujados.has(claveCadete(c))) dibujar(c, isCadeteBusy(c));
  });

  // 3. Sacar a los que ya no están activos
  marcadores.forEach((item, id) => {
    if (!dibujados.has(id)) {
      item.marker.remove();
      marcadores.delete(id);
    }
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

  updateModalList();

  let intentos = 0;
  const checkAndInitMap = async () => {
    if (sinMapa) return mapaNoDisponible();
    if (!window.maplibregl) {
      // Si MapLibre no llega en ~10 s, se avisa y queda la lista
      if (++intentos > 100) return mapaNoDisponible();
      return setTimeout(checkAndInitMap, 100);
    }
    const nuevo = !mapa;
    await initMapInstance();
    if (!mapa) return;
    updateMapMarkers();
    setTimeout(() => {
      if (!mapa) return;
      mapa.resize();
      // La primera vez (o al reabrir) encuadra a los cadetes activos
      if (nuevo && !mapa.loaded()) mapa.once('load', fitMapToMarkers);
      else fitMapToMarkers();
    }, 300);
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

// Brújula: vuelve el mapa al norte
window.radarMapaNorte = () => {
  if (!mapa) return;
  mapa.easeTo({ bearing: 0, duration: 600 });
};

// Selector 3D / 2D: cambia la inclinación sin mover el centro ni el zoom
window.radarMapaTilt = () => {
  if (!mapa) return;
  camara.inclinado = !camara.inclinado;
  guardarPrefsMapa();
  mapa.easeTo({ pitch: camara.inclinado ? PITCH_3D : 0, duration: 700 });
  actualizarBotonesMapa();
};

// Mi ubicación: muestra a quien mira el panel en el mapa y va hasta ahí
window.radarMapaMiUbicacion = () => {
  if (!mapa) return;
  if (!('geolocation' in navigator)) return mostrarAvisoMapa('Este navegador no comparte la ubicación');
  mostrarAvisoMapa('Buscando tu ubicación…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const punto = [pos.coords.longitude, pos.coords.latitude];
      if (!puckAdmin) {
        const raiz = document.createElement('div');
        raiz.innerHTML = '<div class="radar-yo" title="Vos"><div class="radar-yo__halo"></div><div class="radar-yo__punto"></div></div>';
        puckAdmin = new window.maplibregl.Marker({ element: raiz, anchor: 'center' }).setLngLat(punto).addTo(mapa);
      } else {
        puckAdmin.setLngLat(punto);
      }
      document.getElementById('radar-mapa-aviso')?.classList.add('oculto');
      mapa.easeTo({ center: punto, zoom: 16, pitch: camara.inclinado ? PITCH_3D : 0, duration: 1100, essential: true });
      actualizarBotonesMapa();
    },
    (err) => {
      console.warn('[Radar] Sin ubicación:', err.message);
      mostrarAvisoMapa(err.code === 1 ? 'Permiso de ubicación denegado' : 'No se pudo obtener tu ubicación');
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
  );
};

window.focusCadeteOnMap = (cadeteId) => {
  if (!mapa) return;
  const item = marcadores.get(String(cadeteId));

  if (item) {
    mapa.flyTo({ center: item.marker.getLngLat(), zoom: 16, pitch: camara.inclinado ? PITCH_3D : 0, duration: 800 });
    mapa.once('moveend', () => {
      if (!item.popup.isOpen()) item.marker.togglePopup();
    });
  } else {
    const cad = registeredCadetesCache.find(c => String(c.id_cad) === String(cadeteId));
    const name = cad ? (cad.nombre_cad || cad.nombre) : 'El cadete';
    mostrarAvisoMapa(`${name} está desconectado y no aparece en el mapa`);
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

