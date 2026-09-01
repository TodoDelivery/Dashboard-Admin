import { supabase } from './conexion_supabase.js';

const PRESENCE_CHANNEL_NAME = 'cadetes_presence';
const channelPresence = supabase.channel(PRESENCE_CHANNEL_NAME);

let activeCadetesMap = new Map();
let leafletMap = null;
let markersLayer = null;
let leafletLoaded = false;
let registeredCadetesCache = [];

// Coordenadas base por defecto (Centro de Operaciones)
const DEFAULT_CENTER = [-24.7859, -65.4117]; // Salta Centro

export function initSidebarRadar() {
  injectLeafletAssets();
  injectModalHTML();
  fetchRegisteredCadetes();

  const countEl = document.getElementById('radar-cadetes-count');
  if (countEl && countEl.innerHTML.includes('...')) {
    countEl.innerHTML = `0 unidades <span class="text-emerald-400 font-semibold">activas</span>`;
  }

  // Escuchar Presence Realtime (Cadetes Activos / Conectados)
  channelPresence
    .on('presence', { event: 'sync' }, () => {
      const state = channelPresence.presenceState();
      activeCadetesMap.clear();
      let count = 0;
      
      const radar = document.querySelector('.radar');
      if (radar) {
        const oldBlips = radar.querySelectorAll('.radar-blip');
        oldBlips.forEach(b => b.remove());
      }
      
      for (const id in state) {
        const cadete = state[id][state[id].length - 1];
        if (cadete && cadete.estado_cad && cadete.estado_cad !== 'offline') {
          count++;
          activeCadetesMap.set(cadete.id_cad || id, cadete);
          
          if (radar) {
            const top = Math.floor(Math.random() * 60) + 20;
            const left = Math.floor(Math.random() * 60) + 20;
            const delay = (Math.random() * 2).toFixed(1);
            
            const blip = document.createElement('div');
            blip.className = 'radar-blip';
            blip.style.top = `${top}%`;
            blip.style.left = `${left}%`;
            blip.style.animationDelay = `${delay}s`;
            
            if (cadete.estado_cad === 'ocupado') {
              blip.style.background = '#E63946';
              blip.style.boxShadow = '0 0 6px 1px rgba(230,57,70,.7)';
            }
            
            radar.appendChild(blip);
          }
        }
      }
      
      // Actualizar contador del radar en sidebar (Cadetes Activos)
      const countElUpdate = document.getElementById('radar-cadetes-count');
      if (countElUpdate) {
        countElUpdate.innerHTML = `${count} unidades <span class="text-emerald-400 font-semibold">activas</span>`;
      }

      // Si el modal está abierto, refrescar marcadores y lista
      updateMapMarkers();
      updateModalList();
    })
    .subscribe();
}

async function fetchRegisteredCadetes() {
  const { data } = await supabase.from('Cadetes').select('*').order('id_cad', { ascending: true });
  if (data) {
    registeredCadetesCache = data;
    updateModalList();
    updateMapMarkers();
  }
}

function injectLeafletAssets() {
  if (!document.getElementById('leaflet-css')) {
    const link = document.createElement('link');
    link.id = 'leaflet-css';
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(link);
  }

  // Estilo Dark Mode para OpenStreetMap 100% gratuito (sin API key)
  if (!document.getElementById('leaflet-dark-style')) {
    const style = document.createElement('style');
    style.id = 'leaflet-dark-style';
    style.innerHTML = `
      #radar-leaflet-map .leaflet-tile {
        filter: brightness(0.6) invert(1) contrast(3) hue-rotate(200deg) saturate(0.3) brightness(0.7);
      }
      #radar-leaflet-map {
        background: #121217 !important;
      }
      .leaflet-popup-content-wrapper {
        background: #18181F !important;
        color: #F4F4F5 !important;
        border: 1px solid #27272A;
        border-radius: 16px !important;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.6) !important;
      }
      .leaflet-popup-tip {
        background: #18181F !important;
      }
      .leaflet-container a {
        color: #E63946 !important;
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
  modal.innerHTML = `
    <div id="radar-map-card" class="w-full max-w-5xl h-[85vh] bg-brand-card border border-brand-border rounded-3xl flex flex-col shadow-2xl scale-95 transition-transform duration-300 overflow-hidden">
      <!-- Modal Header -->
      <div class="h-16 px-6 bg-brand-dark/95 border-b border-brand-border flex items-center justify-between shrink-0">
        <div class="flex items-center gap-3">
          <div class="p-2.5 rounded-xl bg-brand-accent/10 text-brand-accent border border-brand-accent/20">
            <i data-lucide="map-pin" class="w-5 h-5"></i>
          </div>
          <div>
            <h3 class="text-sm sm:text-base font-bold text-white flex items-center gap-2">
              Red Local en Vivo · Mapa de Cadetes
              <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span> <span id="modal-cadetes-count">0</span> Activos
              </span>
            </h3>
            <p class="text-[11px] text-zinc-400 hidden sm:block">Monitoreo geolocalizado en tiempo real vía socket de presencia</p>
          </div>
        </div>
        
        <div class="flex items-center gap-2">
          <button onclick="window.recenterRadarMap()" title="Centrar mapa" class="p-2 rounded-xl bg-brand-dark border border-brand-border text-zinc-400 hover:text-white hover:border-zinc-500 transition-all text-xs flex items-center gap-1.5">
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
        <div id="radar-leaflet-map" class="flex-1 w-full h-full bg-zinc-950 min-h-[300px]"></div>

        <!-- Cadetes sidebar list inside modal -->
        <div class="w-full md:w-80 bg-brand-dark/95 border-t md:border-t-0 md:border-l border-brand-border p-4 flex flex-col h-48 md:h-full shrink-0">
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

  // Capa 100% Libre y Gratuita de OpenStreetMap (Sin ninguna API key requerida)
  window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(leafletMap);

  markersLayer = window.L.layerGroup().addTo(leafletMap);
}

function updateMapMarkers() {
  if (!leafletMap || !markersLayer || !window.L) return;

  markersLayer.clearLayers();
  const markers = [];

  const cadetesToShow = registeredCadetesCache.length > 0 
    ? registeredCadetesCache 
    : Array.from(activeCadetesMap.values());

  cadetesToShow.forEach((c, index) => {
    const isActive = activeCadetesMap.has(c.id_cad) || activeCadetesMap.has(String(c.id_cad));
    const activeData = activeCadetesMap.get(c.id_cad) || activeCadetesMap.get(String(c.id_cad)) || c;

    let lat = activeData.latitud || activeData.lat || activeData.latitude;
    let lng = activeData.longitud || activeData.lng || activeData.longitude;

    if (!lat || !lng) {
      const angle = (index * (360 / Math.max(cadetesToShow.length, 1))) * (Math.PI / 180);
      const radius = 0.008 + ((index % 3) * 0.004);
      lat = DEFAULT_CENTER[0] + radius * Math.cos(angle);
      lng = DEFAULT_CENTER[1] + radius * Math.sin(angle);
    }

    const isBusy = activeData.estado_cad === 'ocupado';
    const name = c.nombre_cad || c.nombre || `Cadete #${c.id_cad || index + 1}`;
    const initials = name.split(' ').map(n=>n[0]).join('').substring(0, 2);
    const vehicle = c.vehiculo_cad || c.vehiculo || 'Moto';
    
    let statusText = 'Desconectado';
    let colorClass = '#71717A';

    if (isActive) {
      if (isBusy) {
        statusText = 'En viaje';
        colorClass = '#E63946';
      } else {
        statusText = 'Activo';
        colorClass = '#10B981';
      }
    }

    const customIcon = window.L.divIcon({
      className: 'custom-cadete-marker',
      html: `
        <div style="
          position: relative;
          width: 38px;
          height: 38px;
          background: #18181F;
          border: 2px solid ${colorClass};
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: bold;
          font-size: 11px;
          color: white;
          box-shadow: 0 0 12px ${colorClass}66;
          cursor: pointer;
        ">
          ${isActive ? `
            <span style="
              position: absolute;
              inset: -4px;
              border-radius: 50%;
              border: 1.5px solid ${colorClass};
              opacity: 0.6;
              animation: ping 2s cubic-bezier(0, 0, 0.2, 1) infinite;
            "></span>
          ` : ''}
          ${initials}
        </div>
      `,
      iconSize: [38, 38],
      iconAnchor: [19, 19],
      popupAnchor: [0, -22]
    });

    const marker = window.L.marker([lat, lng], { icon: customIcon });

    const popupContent = `
      <div style="font-family: 'Plus Jakarta Sans', sans-serif; min-width: 170px; padding: 2px;">
        <div style="font-weight: 800; font-size: 13px; color: #FFFFFF; margin-bottom: 2px;">${name}</div>
        <div style="font-size: 11px; color: #A1A1AA; margin-bottom: 6px;">ID: #${c.id_cad || '---'} • ${vehicle}</div>
        <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; margin-bottom: 4px;">
          <span style="width: 8px; height: 8px; border-radius: 50%; background: ${colorClass}; display: inline-block;"></span>
          <strong style="color: ${isActive ? (isBusy ? '#F87171' : '#34D399') : '#A1A1AA'};">${statusText}</strong>
        </div>
        ${c.telef_cad ? `<div style="font-size: 10px; color: #71717A; border-top: 1px solid #27272A; padding-top: 4px; margin-top: 4px;">📞 ${c.telef_cad}</div>` : ''}
      </div>
    `;

    marker.bindPopup(popupContent);
    marker.cadeteData = c;
    marker.addTo(markersLayer);
    markers.push(marker);
  });
}

function updateModalList() {
  const listEl = document.getElementById('modal-cadetes-list');
  const countEl = document.getElementById('modal-cadetes-count');
  const listCountEl = document.getElementById('modal-list-count');
  if (!listEl) return;

  listEl.innerHTML = '';

  const totalRegistrados = registeredCadetesCache.length;
  const totalActivos = activeCadetesMap.size;

  if (countEl) countEl.innerText = totalActivos;
  if (listCountEl) listCountEl.innerText = `${totalRegistrados} registrados`;

  if (registeredCadetesCache.length === 0) {
    listEl.innerHTML = '<p class="text-xs text-zinc-500 italic p-3 text-center">No hay cadetes registrados en la base de datos.</p>';
    return;
  }

  registeredCadetesCache.forEach((c, index) => {
    const isActive = activeCadetesMap.has(c.id_cad) || activeCadetesMap.has(String(c.id_cad));
    const activeData = activeCadetesMap.get(c.id_cad) || activeCadetesMap.get(String(c.id_cad));
    const isBusy = activeData && activeData.estado_cad === 'ocupado';
    
    const name = c.nombre_cad || c.nombre || `Cadete #${c.id_cad || index + 1}`;
    const initials = name.split(' ').map(n=>n[0]).join('').substring(0, 2);
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
          <p class="text-[10px] text-zinc-400">${vehicle}</p>
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
  
  const m = document.getElementById('radar-map-modal');
  const c = document.getElementById('radar-map-card');
  if (m && c) {
    m.classList.remove('hidden');
    setTimeout(() => {
      m.classList.add('opacity-100');
      c.classList.remove('scale-95');
    }, 10);
  }

  // Inicializar Leaflet con capa OpenStreetMap libre
  if (!leafletMap) {
    if (window.L) {
      initMapInstance();
      updateMapMarkers();
      updateModalList();
    } else {
      setTimeout(() => {
        initMapInstance();
        updateMapMarkers();
        updateModalList();
      }, 400);
    }
  } else {
    updateMapMarkers();
    updateModalList();
  }

  setTimeout(() => {
    if (leafletMap) {
      leafletMap.invalidateSize();
    }
  }, 250);

  if (window.lucide) window.lucide.createIcons();
};

window.closeRadarMapModal = () => {
  const m = document.getElementById('radar-map-modal');
  const c = document.getElementById('radar-map-card');
  if (m && c) {
    m.classList.remove('opacity-100');
    c.classList.add('scale-95');
    setTimeout(() => m.classList.add('hidden'), 300);
  }
};

window.recenterRadarMap = () => {
  if (leafletMap) {
    leafletMap.flyTo(DEFAULT_CENTER, 14, { duration: 1.2 });
  }
};

window.focusCadeteOnMap = (cadeteId) => {
  if (!markersLayer || !leafletMap) return;
  markersLayer.eachLayer(layer => {
    if (layer.cadeteData && (layer.cadeteData.id_cad === cadeteId || layer.cadeteData.id === cadeteId)) {
      leafletMap.flyTo(layer.getLatLng(), 16, { duration: 1 });
      layer.openPopup();
    }
  });
};

// Iniciar radar al cargar el script
window.addEventListener('DOMContentLoaded', () => {
  initSidebarRadar();
});
