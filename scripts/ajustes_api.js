import { supabase } from './conexion_supabase.js';

// Variables globales de tarifas
let BASE_FEE = 1200;
let PRICE_PER_KM = 350;
let SURGE_PRICE_PERCENT = 20; // 20%
let cotizId = 1;

let zones = [];

export async function initAjustes() {
  await fetchCotiz();
  cargarZonas();
  renderZonesTable();
  populateZoneSelect();
  window.calculatePreview();
  iniciarSuscripciones();
}

function iniciarSuscripciones() {
  supabase.channel('cotiz-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'Datos_cotiz' }, () => {
      fetchCotiz();
    })
    .subscribe();
}

async function fetchCotiz() {
  const { data, error } = await supabase
    .from('Datos_cotiz')
    .select('*')
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    console.error("Error al consultar Datos_cotiz id=1:", error);
  } else if (data) {
    cotizId = 1;
    BASE_FEE = parseFloat(data.bajada_band) || 0;
    PRICE_PER_KM = parseFloat(data.tarifa_km) || 0;
    SURGE_PRICE_PERCENT = parseFloat(data.porc_tarif_dinamica) || 0;
  }

  // Actualizar UI
  const displayBase = document.getElementById("display-base-price");
  const displayKm = document.getElementById("display-km-price");
  const displaySurge = document.getElementById("display-surge-price");
  const labelNight = document.getElementById("label-night");

  if(displayBase) displayBase.innerText = `$${BASE_FEE.toLocaleString()}`;
  if(displayKm) displayKm.innerText = `$${PRICE_PER_KM.toLocaleString()}`;
  if(displaySurge) displaySurge.innerText = `+ ${SURGE_PRICE_PERCENT}%`;
  if(labelNight) labelNight.innerText = `Aplicar tarifa dinámica (+${SURGE_PRICE_PERCENT}%)`;
  
  if (window.calculatePreview) window.calculatePreview();
}

function cargarZonas() {
  const guardadas = localStorage.getItem('todo_delivery_zonas');
  if (guardadas) {
    zones = JSON.parse(guardadas);
  } else {
    // Por defecto si es la primera vez
    zones = [
      { id: 1, name: "Microcentro & Alrededores", radius: "Hasta 3 Km", extra: 0, time: "15 - 25 min", active: true },
      { id: 2, name: "Zona Urbana Intermedia", radius: "Hasta 6 Km", extra: 400, time: "25 - 35 min", active: true },
      { id: 3, name: "Periferia / Zona Sur", radius: "Hasta 10 Km", extra: 950, time: "35 - 45 min", active: true },
      { id: 4, name: "Barrios Privados & Country Club", radius: "Hasta 15 Km", extra: 1600, time: "45 - 60 min", active: true }
    ];
    guardarZonas();
  }
}

function guardarZonas() {
  localStorage.setItem('todo_delivery_zonas', JSON.stringify(zones));
}

window.renderZonesTable = () => {
  const tbody = document.getElementById("zones-table-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  zones.forEach(z => {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-brand-dark/40 transition-colors";

    tr.innerHTML = `
      <td class="py-4 px-4">
        <div class="flex items-center gap-3">
          <div class="p-2 rounded-xl bg-zinc-800 border border-brand-border text-brand-accent">
            <i data-lucide="map-pin" class="w-4 h-4"></i>
          </div>
          <div>
            <span class="block font-semibold text-white">${z.name}</span>
            <span class="text-[11px] text-zinc-500 font-mono">${z.radius}</span>
          </div>
        </div>
      </td>
      <td class="py-4 px-4 font-mono font-semibold ${z.extra > 0 ? 'text-brand-gold' : 'text-zinc-400'}">
        ${z.extra > 0 ? '+ $' + z.extra.toLocaleString() : 'Sin recargo'}
      </td>
      <td class="py-4 px-4 text-xs text-zinc-300 font-medium">${z.time}</td>
      <td class="py-4 px-4">
        <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${z.active ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-zinc-800 text-zinc-500'}">
          <span class="w-1.5 h-1.5 rounded-full ${z.active ? 'bg-emerald-400' : 'bg-zinc-500'}"></span> ${z.active ? 'Habilitada' : 'Inactiva'}
        </span>
      </td>
      <td class="py-4 px-4 text-right">
        <div class="flex items-center justify-end gap-2">
          <button onclick="toggleZoneStatus(${z.id})" title="${z.active ? 'Desactivar Zona' : 'Activar Zona'}" class="p-2 rounded-xl border border-brand-border text-zinc-400 hover:text-white hover:bg-zinc-800 transition-all">
            <i data-lucide="${z.active ? 'eye-off' : 'eye'}" class="w-4 h-4"></i>
          </button>
          <button onclick="deleteZone(${z.id})" title="Eliminar Zona" class="p-2 rounded-xl border border-brand-border text-red-400 hover:bg-red-500/10 transition-all">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  const badge = document.getElementById("zones-count-badge");
  if(badge) badge.innerText = `${zones.filter(z => z.active).length} Zonas Activas`;
  
  if (window.lucide) window.lucide.createIcons();
};

window.populateZoneSelect = () => {
  const select = document.getElementById("calc-zone");
  if (!select) return;
  select.innerHTML = "";
  
  // Agregar opción default
  const defaultOpt = document.createElement("option");
  defaultOpt.value = 0;
  defaultOpt.innerText = "Ninguna / Calculado";
  select.appendChild(defaultOpt);

  zones.filter(z => z.active).forEach(z => {
    const opt = document.createElement("option");
    opt.value = z.extra;
    opt.innerText = `${z.name} (${z.extra > 0 ? '+$' + z.extra : 'Sin plus'})`;
    select.appendChild(opt);
  });
};

window.calculatePreview = () => {
  const kmEl = document.getElementById("calc-km");
  const zoneEl = document.getElementById("calc-zone");
  const nightEl = document.getElementById("calc-night");
  
  if(!kmEl || !zoneEl || !nightEl) return;

  const km = parseFloat(kmEl.value) || 0;
  const zoneExtra = parseFloat(zoneEl.value) || 0;
  const isNight = nightEl.checked;

  const subtotal = BASE_FEE + (km * PRICE_PER_KM);
  let total = subtotal + zoneExtra;

  if (isNight) {
    total = total * (1 + (SURGE_PRICE_PERCENT / 100));
  }

  document.getElementById("preview-subtotal").innerText = `$${Math.round(subtotal).toLocaleString()}`;
  document.getElementById("preview-zone-extra").innerText = `+$${zoneExtra.toLocaleString()}`;
  document.getElementById("preview-total").innerText = `$${Math.round(total).toLocaleString()}`;
};

window.toggleZoneStatus = (id) => {
  zones = zones.map(z => z.id === id ? { ...z, active: !z.active } : z);
  guardarZonas();
  window.renderZonesTable();
  window.populateZoneSelect();
  window.calculatePreview();
};

window.deleteZone = (id) => {
  if (confirm("¿Estás seguro de eliminar esta zona de cobertura?")) {
    zones = zones.filter(z => z.id !== id);
    guardarZonas();
    window.renderZonesTable();
    window.populateZoneSelect();
    window.calculatePreview();
  }
};

window.openZoneModal = () => {
  const m = document.getElementById('zone-modal-backdrop');
  const c = document.getElementById('zone-modal-container');
  m.classList.remove('hidden');
  setTimeout(() => {
    m.classList.add('opacity-100');
    c.classList.remove('scale-95');
  }, 10);
};

window.closeZoneModal = () => {
  const m = document.getElementById('zone-modal-backdrop');
  const c = document.getElementById('zone-modal-container');
  m.classList.remove('opacity-100');
  c.classList.add('scale-95');
  setTimeout(() => m.classList.add('hidden'), 300);
};

window.handleCreateZone = (e) => {
  e.preventDefault();
  const name = document.getElementById("modal-zone-name").value;
  const radius = document.getElementById("modal-zone-radius").value;
  const extra = parseFloat(document.getElementById("modal-zone-extra").value) || 0;
  const time = document.getElementById("modal-zone-time").value;

  zones.push({
    id: Date.now(),
    name,
    radius,
    extra,
    time,
    active: true
  });

  guardarZonas();
  window.closeZoneModal();
  window.renderZonesTable();
  window.populateZoneSelect();
  window.calculatePreview();
};

window.openCotizModal = () => {
  const m = document.getElementById('cotiz-modal-backdrop');
  const c = document.getElementById('cotiz-modal-container');
  
  // Set current values
  document.getElementById('input-bajada').value = BASE_FEE;
  document.getElementById('input-km').value = PRICE_PER_KM;
  document.getElementById('input-dinamica').value = SURGE_PRICE_PERCENT;

  m.classList.remove('hidden');
  setTimeout(() => {
    m.classList.add('opacity-100');
    c.classList.remove('scale-95');
  }, 10);
};

window.closeCotizModal = () => {
  const m = document.getElementById('cotiz-modal-backdrop');
  const c = document.getElementById('cotiz-modal-container');
  m.classList.remove('opacity-100');
  c.classList.add('scale-95');
  setTimeout(() => m.classList.add('hidden'), 300);
};

window.handleSaveCotiz = async (e) => {
  e.preventDefault();
  
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const originalText = submitBtn ? submitBtn.innerText : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = "Guardando...";
  }

  const newBajada = parseFloat(document.getElementById('input-bajada').value) || 0;
  const newKm = parseFloat(document.getElementById('input-km').value) || 0;
  const newDinamica = parseFloat(document.getElementById('input-dinamica').value) || 0;

  const { error } = await supabase
    .from('Datos_cotiz')
    .upsert({
      id: 1,
      bajada_band: newBajada,
      tarifa_km: newKm,
      porc_tarif_dinamica: newDinamica
    });

  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.innerText = originalText;
  }

  if (error) {
    alert("Error al actualizar tarifas en base de datos: " + error.message);
  } else {
    // Actualizamos variables locales
    BASE_FEE = newBajada;
    PRICE_PER_KM = newKm;
    SURGE_PRICE_PERCENT = newDinamica;

    // Actualizamos UI
    const displayBase = document.getElementById("display-base-price");
    const displayKm = document.getElementById("display-km-price");
    const displaySurge = document.getElementById("display-surge-price");
    const labelNight = document.getElementById("label-night");

    if(displayBase) displayBase.innerText = `$${BASE_FEE.toLocaleString()}`;
    if(displayKm) displayKm.innerText = `$${PRICE_PER_KM.toLocaleString()}`;
    if(displaySurge) displaySurge.innerText = `+ ${SURGE_PRICE_PERCENT}%`;
    if(labelNight) labelNight.innerText = `Aplicar tarifa dinámica (+${SURGE_PRICE_PERCENT}%)`;

    window.closeCotizModal();
    window.calculatePreview();
  }
};

window.addEventListener('DOMContentLoaded', () => {
  initAjustes();
});
