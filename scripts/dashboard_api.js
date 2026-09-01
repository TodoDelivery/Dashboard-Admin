import { supabase } from './conexion_supabase.js';

// Estado Local
let cadetesActivos = new Map();
let pedidosActivos = [];
let totalRecaudacion = 0;

// Canal para recibir posiciones y conexiones en tiempo real
const PRESENCE_CHANNEL_NAME = 'cadetes_presence';
const channelPresence = supabase.channel(PRESENCE_CHANNEL_NAME);

export async function initDashboard() {
  actualizarKPICadetes(0);
  await cargarKPIsBase();
  await cargarUltimosPedidos();
  iniciarSuscripciones();
  iniciarRadarPresence();
  
  // Renderizar listas iniciales
  renderizarTablaPedidos();
  renderizarFlota();
}

async function cargarKPIsBase() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  // 1. Pedidos Hoy
  const { count, error: errCount } = await supabase
    .from('Pedidos')
    .select('*', { count: 'exact', head: true })
    .gte('fecha_pedido', startOfDay.toISOString());

  const pedidosHoyEl = document.getElementById('kpi-pedidos-hoy');
  if (pedidosHoyEl) {
    pedidosHoyEl.innerText = !errCount && count !== null ? count : 0;
  }

  // 2. Recaudación Diaria y Pedidos en curso
  const { data: pedidosHoy, error: errCaja } = await supabase
    .from('Pedidos')
    .select('coste_pedido, estado_pedido')
    .gte('fecha_pedido', startOfDay.toISOString());
    
  if (!errCaja && pedidosHoy) {
    totalRecaudacion = pedidosHoy.reduce((acc, p) => acc + (parseFloat(p.coste_pedido) || 0), 0);
    const recEl = document.getElementById('kpi-recaudacion');
    if (recEl) recEl.innerText = `$${totalRecaudacion.toLocaleString()}`;
    
    const enCurso = pedidosHoy.filter(p => p.estado_pedido !== 'delivered' && p.estado_pedido !== 'entregado' && p.estado_pedido !== 'cancelled').length;
    const enCursoEl = document.getElementById('kpi-pedidos-curso-text');
    if (enCursoEl) enCursoEl.innerText = `${enCurso} en curso en este momento`;
  } else {
    const recEl = document.getElementById('kpi-recaudacion');
    if (recEl) recEl.innerText = '$0';
  }

  // 3. Tiempo Promedio Calculado por Pedido (tomando tiempo_pedido de la base de datos)
  const { data: pedidosTiempo, error: errTiempo } = await supabase
    .from('Pedidos')
    .select('tiempo_pedido')
    .not('tiempo_pedido', 'is', null);

  const tiempoPromedioEl = document.getElementById('kpi-tiempo-promedio');
  const tiempoDiffEl = document.getElementById('kpi-tiempo-diff');
  const tiempoSubtextEl = document.getElementById('kpi-tiempo-subtext');

  if (!errTiempo && pedidosTiempo && pedidosTiempo.length > 0) {
    const tiemposValidos = pedidosTiempo
      .map(p => Number(p.tiempo_pedido))
      .filter(t => !isNaN(t) && t > 0);

    if (tiemposValidos.length > 0) {
      const avg = Math.round(tiemposValidos.reduce((acc, cur) => acc + cur, 0) / tiemposValidos.length);
      if (tiempoPromedioEl) tiempoPromedioEl.innerText = `${avg} min`;
      if (tiempoDiffEl) tiempoDiffEl.innerText = avg <= 35 ? 'Óptimo' : 'Demorado';
      if (tiempoSubtextEl) tiempoSubtextEl.innerText = `Calculado sobre ${tiemposValidos.length} pedidos`;
    } else {
      if (tiempoPromedioEl) tiempoPromedioEl.innerText = `0 min`;
      if (tiempoDiffEl) tiempoDiffEl.innerText = '';
    }
  } else {
    if (tiempoPromedioEl) tiempoPromedioEl.innerText = `0 min`;
    if (tiempoDiffEl) tiempoDiffEl.innerText = '';
  }
}

async function cargarUltimosPedidos() {
  const { data, error } = await supabase
    .from('Pedidos')
    .select(`
      id_pedido, 
      coste_pedido, 
      estado_pedido, 
      tiempo_pedido,
      Cadetes ( id_cad, nombre_cad ),
      Clientes ( id_cliente, nombre_cliente )
    `)
    .order('fecha_pedido', { ascending: false })
    .limit(5);

  if (!error && data) {
    pedidosActivos = data;
  }
}

function iniciarSuscripciones() {
  supabase.channel('dashboard-pedidos')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'Pedidos' }, () => {
      // Recargar KPIs y Tabla al haber cambios en Pedidos
      cargarKPIsBase();
      cargarUltimosPedidos().then(() => renderizarTablaPedidos());
    })
    .subscribe();
}

function iniciarRadarPresence() {
  channelPresence
    .on('presence', { event: 'sync' }, () => {
      const state = channelPresence.presenceState();
      cadetesActivos.clear();
      
      for (const id in state) {
        // Obtenemos el registro más reciente del estado del cadete
        const cadete = state[id][state[id].length - 1];
        if (cadete && cadete.estado_cad && cadete.estado_cad !== 'offline') {
          cadetesActivos.set(cadete.id_cad, cadete);
        }
      }
      
      actualizarKPICadetes(cadetesActivos.size);
      renderizarFlota();
    })
    .subscribe();
}

function actualizarKPICadetes(count = 0) {
  const kpiEl = document.getElementById('kpi-cadetes-activos');
  if (kpiEl) kpiEl.innerText = `${count}`;

  const flotaCountEl = document.getElementById('flota-count');
  if (flotaCountEl) flotaCountEl.innerText = `${count}`;
}

function renderizarTablaPedidos() {
  const tbody = document.getElementById('dashboard-pedidos-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  
  if (pedidosActivos.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="py-6 text-center text-xs text-zinc-500 italic">
          No hay pedidos registrados el día de hoy.
        </td>
      </tr>
    `;
    return;
  }

  pedidosActivos.forEach(p => {
    let statusClass = 'bg-blue-500/10 text-blue-400 border-blue-500/20';
    let statusIconClass = 'bg-blue-400 animate-pulse';
    let statusText = 'Por Asignar';
    
    const st = (p.estado_pedido || '').toLowerCase();
    if (st === 'in_transit' || st === 'en_curso' || st === 'en_camino') {
      statusClass = 'bg-amber-500/10 text-amber-400 border-amber-500/20';
      statusIconClass = 'bg-amber-400 animate-pulse';
      statusText = 'En camino';
    } else if (st === 'delivered' || st === 'entregado' || st === 'finalizado') {
      statusClass = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
      statusIconClass = 'bg-emerald-400';
      statusText = 'Entregado';
    }

    const cadeteNombre = p.Cadetes ? p.Cadetes.nombre_cad : '<span class="text-zinc-500 italic">Sin asignar</span>';
    const clienteNombre = p.Clientes ? p.Clientes.nombre_cliente : 'Consumidor Final';
    
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-brand-dark/50 transition-colors';
    tr.innerHTML = `
      <td class="py-3.5 px-3 font-semibold text-white font-mono text-xs">#TD-${p.id_pedido}</td>
      <td class="py-3.5 px-3">
        <span class="block text-zinc-200 text-xs font-medium">${clienteNombre}</span>
      </td>
      <td class="py-3.5 px-3 text-zinc-300 text-xs">${cadeteNombre}</td>
      <td class="py-3.5 px-3">
        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium ${statusClass} border">
          <span class="w-1.5 h-1.5 rounded-full ${statusIconClass}"></span> ${statusText}
        </span>
      </td>
      <td class="py-3.5 px-3 text-right font-semibold text-emerald-400 text-xs font-mono">$${parseFloat(p.coste_pedido || 0).toLocaleString()}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderizarFlota() {
  const container = document.getElementById('dashboard-flota-container');
  if (!container) return;
  container.innerHTML = '';
  
  if (cadetesActivos.size === 0) {
    container.innerHTML = '<p class="text-xs text-zinc-500 italic p-3 text-center">Ningún cadete conectado al radar.</p>';
    return;
  }
  
  cadetesActivos.forEach((c) => {
    const isBusy = c.estado_cad === 'ocupado';
    const statusText = isBusy ? 'En viaje' : 'Libre';
    const statusColor = isBusy ? 'text-emerald-400 bg-emerald-500/10' : 'text-zinc-400 bg-zinc-800';
    const dotColor = isBusy ? 'bg-emerald-500' : 'bg-amber-400';
    const initials = (c.nombre || c.nombre_cad || 'C').split(' ').map(n=>n[0]).join('').substring(0,2);
    
    const div = document.createElement('div');
    div.className = 'flex items-center justify-between p-3 rounded-xl bg-brand-dark/60 border border-brand-border/60';
    div.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="relative">
          <div class="w-9 h-9 rounded-full bg-zinc-800 flex items-center justify-center font-bold text-xs text-white">
            ${initials}
          </div>
          <span class="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full ${dotColor} border-2 border-brand-dark"></span>
        </div>
        <div>
          <h5 class="text-xs font-bold text-white">${c.nombre || c.nombre_cad || 'Cadete'}</h5>
          <p class="text-[10px] text-zinc-400">ID: #${c.id_cad}</p>
        </div>
      </div>
      <span class="text-[11px] font-medium px-2 py-0.5 rounded ${statusColor}">${statusText}</span>
    `;
    container.appendChild(div);
  });
}

window.addEventListener('DOMContentLoaded', () => {
  initDashboard();
});
