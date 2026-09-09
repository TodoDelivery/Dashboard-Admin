import { supabase } from './conexion_supabase.js';

// =========================================================================
// ESTADO LOCAL DEL DASHBOARD GENERAL
// =========================================================================
let cadetesActivos = new Map();
let pedidosActivos = [];
let totalRecaudacion = 0;
let statsTiempo = {
  total: 0,
  promedio: 0,
  varianza: 0,
  desviacion: 0,
  min: 0,
  max: 0,
  rapidos: 0,
  normales: 0,
  demorados: 0
};

const PRESENCE_CHANNEL_NAME = 'cadetes-disponibles';
let channelPresence = null;
let channelDbPedidos = null;
let channelDbCadetes = null;

// =========================================================================
// INICIALIZACIÓN
// =========================================================================
export async function initDashboard() {
  actualizarKPICadetes(0);
  await Promise.all([
    cargarKPIsBase(),
    cargarUltimosPedidos(),
    cargarFlotaCadetes()
  ]);

  renderizarTablaPedidos();
  renderizarFlota();

  iniciarSuscripciones();
  iniciarRadarPresence();
}

// =========================================================================
// 1. CARGA DE KPIS DEL DÍA
// =========================================================================
async function cargarKPIsBase() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  try {
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
      if (recEl) recEl.innerText = `$${totalRecaudacion.toLocaleString('es-AR')}`;
      
      const enCurso = pedidosHoy.filter(p => {
        const st = String(p.estado_pedido || '').toLowerCase();
        return st === 'asignado' || st === 'en_camino_entrega' || st === 'en_curso' || st === 'en_camino' || st === 'en_confirmacion';
      }).length;

      const enCursoEl = document.getElementById('kpi-pedidos-curso-text');
      if (enCursoEl) enCursoEl.innerText = `${enCurso} en curso en este momento`;
    } else {
      const recEl = document.getElementById('kpi-recaudacion');
      if (recEl) recEl.innerText = '$0';
    }

    // 3. Tiempo Promedio Calculado por Pedido
    const { data: pedidosTiempo, error: errTiempo } = await supabase
      .from('Pedidos')
      .select('tiempo_pedido')
      .not('tiempo_pedido', 'is', null);

    const tiempoPromedioEl = document.getElementById('kpi-tiempo-promedio');
    const tiempoDiffEl = document.getElementById('kpi-tiempo-diff');
    const tiempoSubtextEl = document.getElementById('kpi-tiempo-subtext');
    const tiempoVarianzaEl = document.getElementById('kpi-tiempo-varianza');
    const varianzaSubtextEl = document.getElementById('kpi-tiempo-varianza-subtext');

    if (!errTiempo && pedidosTiempo && pedidosTiempo.length > 0) {
      const tiemposValidos = pedidosTiempo
        .map(p => Number(p.tiempo_pedido))
        .filter(t => !isNaN(t) && t > 0);

      if (tiemposValidos.length > 0) {
        const total = tiemposValidos.length;
        const sum = tiemposValidos.reduce((acc, cur) => acc + cur, 0);
        const mean = sum / total;
        const avg = Math.round(mean);
        const varianza = tiemposValidos.reduce((acc, cur) => acc + Math.pow(cur - mean, 2), 0) / total;
        const desviacion = Math.sqrt(varianza);
        const desviacionMin = Math.round(desviacion * 10) / 10;
        const minVal = Math.min(...tiemposValidos);
        const maxVal = Math.max(...tiemposValidos);
        const rapidos = tiemposValidos.filter(t => t < 25).length;
        const normales = tiemposValidos.filter(t => t >= 25 && t <= 40).length;
        const demorados = tiemposValidos.filter(t => t > 40).length;

        statsTiempo = {
          total,
          promedio: avg,
          varianza: Math.round(varianza * 10) / 10,
          desviacion: desviacionMin,
          min: minVal,
          max: maxVal,
          rapidos,
          normales,
          demorados
        };

        if (tiempoPromedioEl) tiempoPromedioEl.innerText = `${avg} min`;
        if (tiempoDiffEl) tiempoDiffEl.innerText = avg <= 35 ? 'Óptimo' : 'Demorado';
        if (tiempoSubtextEl) tiempoSubtextEl.innerText = `Calculado sobre ${total} pedidos`;

        if (tiempoVarianzaEl) {
          tiempoVarianzaEl.innerText = `± ${desviacionMin} min`;
        }
        if (varianzaSubtextEl) {
          varianzaSubtextEl.innerText = `Los pedidos suelen variar en ±${desviacionMin} min respecto al promedio`;
        }
      } else {
        statsTiempo = { total: 0, promedio: 0, varianza: 0, desviacion: 0, min: 0, max: 0, rapidos: 0, normales: 0, demorados: 0 };
        if (tiempoPromedioEl) tiempoPromedioEl.innerText = `0 min`;
        if (tiempoDiffEl) tiempoDiffEl.innerText = '';
        if (tiempoVarianzaEl) tiempoVarianzaEl.innerText = `± 0 min`;
      }
    } else {
      statsTiempo = { total: 0, promedio: 0, varianza: 0, desviacion: 0, min: 0, max: 0, rapidos: 0, normales: 0, demorados: 0 };
      if (tiempoPromedioEl) tiempoPromedioEl.innerText = `0 min`;
      if (tiempoDiffEl) tiempoDiffEl.innerText = '';
      if (tiempoVarianzaEl) tiempoVarianzaEl.innerText = `± 0 min`;
    }
  } catch (e) {
    console.error('[Dashboard] Error cargando KPIs:', e);
  }
}

// =========================================================================
// 2. CARGA DE LOS ÚLTIMOS 3 PEDIDOS GENERALES
// =========================================================================
async function cargarUltimosPedidos() {
  try {
    const { data, error } = await supabase
      .from('Pedidos')
      .select(`
        id_pedido, 
        coste_pedido, 
        estado_pedido, 
        inform_pedido,
        tipo_paquete,
        fecha_pedido,
        tiempo_pedido,
        id_cadete,
        id_cliente,
        Cadetes ( id_cad, nombre_cad, alias_cad ),
        Clientes ( id_cliente, nombre_cliente, telefono_cliente )
      `)
      .order('fecha_pedido', { ascending: false })
      .limit(3);

    if (error) {
      console.error('[Dashboard] Error cargando últimos 3 pedidos:', error);
      return;
    }

    if (data) {
      pedidosActivos = data;
    }
  } catch (e) {
    console.error('[Dashboard] Excepción cargando últimos 3 pedidos:', e);
  }
}

// =========================================================================
// 3. CARGA Y FILTRADO: EXCLUSIVAMENTE CADETES ACTIVOS (EN TURNO / RADAR / VIAJE)
// =========================================================================
async function cargarFlotaCadetes() {
  try {
    cadetesActivos.clear();

    // 1. Si sidebar_radar ya tiene los cadetes activos sincronizados con el radar, utilizarlos prioritariamente
    if (typeof window.getActiveCadetesList === 'function') {
      const activeList = window.getActiveCadetesList();
      if (Array.isArray(activeList)) {
        activeList.forEach(c => {
          cadetesActivos.set(c.id_cad, {
            id_cad: c.id_cad,
            nombre_cad: c.nombre_cad || c.nombre || `Cadete #${c.id_cad}`,
            alias_cad: c.alias_cad || '-',
            telef_cad: c.telef_cad || '',
            vehiculo_cad: c.vehiculo_cad || 'Moto',
            patente: c.patente || '',
            estado_cad: c.estado_cad || 'disponible'
          });
        });

        actualizarKPICadetes(cadetesActivos.size);
        renderizarFlota();
        return;
      }
    }

    // 2. Fallback directo: Detectar cadetes que tienen viajes activos en curso
    const { data: pedidosEnCurso } = await supabase
      .from('Pedidos')
      .select('id_cadete, estado_pedido')
      .in('estado_pedido', ['asignado', 'en_camino_entrega', 'en_curso']);

    const cadetesConViaje = new Set((pedidosEnCurso || []).map(p => Number(p.id_cadete)).filter(Boolean));

    // 3. Detectar cadetes conectados activamente por Presence ('cadetes-disponibles')
    const presenceMap = new Map();
    if (channelPresence && typeof channelPresence.presenceState === 'function') {
      const state = channelPresence.presenceState();
      for (const id in state) {
        if (id.startsWith('admin_')) continue;
        const presences = state[id];
        if (Array.isArray(presences) && presences.length > 0) {
          const cad = presences[presences.length - 1];
          if (cad && cad.estado_cad && cad.estado_cad !== 'offline' && cad.estado_cad !== 'desconectado') {
            const realId = Number(cad.id_cad || String(id).replace(/^cad_/, ''));
            if (realId) {
              presenceMap.set(realId, cad);
            }
          }
        }
      }
    }

    // Solo son activos si están en viaje activo O conectados en presence
    const idsSoloActivos = new Set([...cadetesConViaje, ...presenceMap.keys()]);

    if (idsSoloActivos.size > 0) {
      const { data: infoCadetes } = await supabase
        .from('Cadetes')
        .select('*')
        .in('id_cad', Array.from(idsSoloActivos));

      (infoCadetes || []).forEach(cad => {
        const pData = presenceMap.get(cad.id_cad);
        const enViaje = cadetesConViaje.has(cad.id_cad);
        const estado = enViaje ? 'ocupado' : (pData?.estado_cad || cad.estado_cad || 'disponible');

        cadetesActivos.set(cad.id_cad, {
          id_cad: cad.id_cad,
          nombre_cad: cad.nombre_cad || `Cadete #${cad.id_cad}`,
          alias_cad: cad.alias_cad || '-',
          telef_cad: cad.telef_cad || '',
          vehiculo_cad: cad.vehiculo_cad || 'Moto',
          patente: cad.patente || '',
          estado_cad: estado
        });
      });
    }

    actualizarKPICadetes(cadetesActivos.size);
    renderizarFlota();
  } catch (e) {
    console.error('[Dashboard] Error cargando flota de cadetes activos:', e);
  }
}

// =========================================================================
// 4. SUSCRIPCIONES REALTIME (PEDIDOS, CADETES Y PRESENCIA)
// =========================================================================
function iniciarSuscripciones() {
  if (channelDbPedidos) supabase.removeChannel(channelDbPedidos);
  if (channelDbCadetes) supabase.removeChannel(channelDbCadetes);

  // Escuchar inserciones, actualizaciones o cancelaciones en la tabla Pedidos
  channelDbPedidos = supabase.channel('dashboard-pedidos-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'Pedidos' }, async () => {
      await Promise.all([
        cargarKPIsBase(),
        cargarUltimosPedidos()
      ]);
      renderizarTablaPedidos();
    })
    .subscribe();

  // Escuchar cambios de estado en Cadetes (ej. cuando se conecta o inicia turno)
  channelDbCadetes = supabase.channel('dashboard-cadetes-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'Cadetes' }, async () => {
      await cargarFlotaCadetes();
    })
    .subscribe();
}

function iniciarRadarPresence() {
  if (channelPresence) {
    try { supabase.removeChannel(channelPresence); } catch (e) {}
  }

  channelPresence = supabase.channel(PRESENCE_CHANNEL_NAME);
  channelPresence
    .on('presence', { event: 'sync' }, () => {
      cargarFlotaCadetes();
    })
    .subscribe();
}

function actualizarKPICadetes(count = 0) {
  const kpiEl = document.getElementById('kpi-cadetes-activos');
  if (kpiEl) kpiEl.innerText = `${count}`;

  const flotaCountEl = document.getElementById('flota-count');
  if (flotaCountEl) flotaCountEl.innerText = `${count}`;
}

// =========================================================================
// 5. RENDERIZADO: TABLA DE LOS ÚLTIMOS 3 PEDIDOS
// =========================================================================
export function renderizarTablaPedidos() {
  const tbody = document.getElementById('dashboard-pedidos-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  
  if (pedidosActivos.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="py-8 text-center text-xs text-zinc-500 italic">
          No hay pedidos registrados en el sistema.
        </td>
      </tr>
    `;
    return;
  }

  pedidosActivos.forEach(p => {
    let statusClass = 'bg-blue-500/10 text-blue-400 border-blue-500/20';
    let statusIconClass = 'bg-blue-400 animate-pulse';
    let statusText = 'En espera';
    
    const st = String(p.estado_pedido || '').toLowerCase().trim();
    if (st === 'en_camino_entrega' || st === 'in_transit' || st === 'en_curso' || st === 'en_camino') {
      statusClass = 'bg-amber-500/10 text-amber-400 border-amber-500/20';
      statusIconClass = 'bg-amber-400 animate-pulse';
      statusText = 'En camino';
    } else if (st === 'entregado' || st === 'delivered' || st === 'finalizado') {
      statusClass = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
      statusIconClass = 'bg-emerald-400';
      statusText = 'Entregado';
    } else if (st === 'rendido') {
      statusClass = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
      statusIconClass = 'bg-emerald-400';
      statusText = 'Rendido';
    } else if (st === 'cancelado' || st === 'cancelled') {
      statusClass = 'bg-red-500/10 text-red-400 border-red-500/20';
      statusIconClass = 'bg-red-400';
      statusText = 'Cancelado';
    } else if (st === 'asignado') {
      statusClass = 'bg-blue-500/10 text-blue-400 border-blue-500/20';
      statusIconClass = 'bg-blue-400 animate-pulse';
      statusText = 'Asignado';
    } else if (st === 'en_confirmacion' || st === 'libre' || st === 'pendiente') {
      statusClass = 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20';
      statusIconClass = 'bg-cyan-400 animate-pulse';
      statusText = 'Confirmando';
    }

    const cadeteNombre = (p.Cadetes && p.Cadetes.nombre_cad) 
      ? p.Cadetes.nombre_cad 
      : (p.id_cadete ? `Cadete #${p.id_cadete}` : '<span class="text-zinc-500 italic">Sin asignar</span>');
      
    const clienteNombre = (p.Clientes && p.Clientes.nombre_cliente) 
      ? p.Clientes.nombre_cliente 
      : 'Consumidor Final';

    const localDetalle = p.inform_pedido 
      ? p.inform_pedido.split('-')[0].trim() 
      : (p.tipo_paquete || 'Envío estándar');
    
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-brand-dark/70 transition-colors cursor-pointer group border-b border-brand-border/40';
    tr.title = `Ver detalles del pedido #TD-${p.id_pedido} en Monitor de Envíos`;
    tr.onclick = () => {
      window.location.href = `monitoreo_envios.html?orderId=${p.id_pedido}`;
    };

    tr.innerHTML = `
      <td class="py-3.5 px-3 font-semibold text-white font-mono text-xs">
        <span class="group-hover:text-brand-accent transition-colors">#TD-${p.id_pedido}</span>
      </td>
      <td class="py-3.5 px-3">
        <span class="block text-zinc-200 text-xs font-semibold truncate max-w-[170px]" title="${clienteNombre}">${clienteNombre}</span>
        <span class="block text-[11px] text-zinc-400 truncate max-w-[170px]" title="${localDetalle}">${localDetalle}</span>
      </td>
      <td class="py-3.5 px-3 text-zinc-300 text-xs font-medium">${cadeteNombre}</td>
      <td class="py-3.5 px-3">
        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium ${statusClass} border">
          <span class="w-1.5 h-1.5 rounded-full ${statusIconClass}"></span> ${statusText}
        </span>
      </td>
      <td class="py-3.5 px-3 text-right font-bold text-emerald-400 text-xs font-mono">$${parseFloat(p.coste_pedido || 0).toLocaleString('es-AR')}</td>
    `;
    tbody.appendChild(tr);
  });
}

// =========================================================================
// 6. RENDERIZADO: LISTA DE FLOTA DE CADETES ACTIVOS
// =========================================================================
export function renderizarFlota() {
  const container = document.getElementById('dashboard-flota-container');
  if (!container) return;
  container.innerHTML = '';
  
  if (cadetesActivos.size === 0) {
    container.innerHTML = `
      <div class="p-5 rounded-2xl bg-brand-dark/40 border border-brand-border/60 text-center space-y-2">
        <div class="w-9 h-9 rounded-xl bg-zinc-800/80 border border-brand-border mx-auto flex items-center justify-center text-zinc-500">
          <i data-lucide="user-x" class="w-4 h-4"></i>
        </div>
        <p class="text-xs text-zinc-300 font-semibold">No hay cadetes activos en este momento</p>
        <p class="text-[11px] text-zinc-500 max-w-xs mx-auto">Aparecerán aquí automáticamente con su nombre y estado al conectarse en la app.</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }
  
  cadetesActivos.forEach((c) => {
    const st = String(c.estado_cad || '').toLowerCase().trim();
    let statusText = 'Disponible';
    let statusColor = 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
    let dotColor = 'bg-emerald-400 animate-pulse';

    if (st === 'ocupado' || st === 'en_camino' || st === 'en_curso' || st === 'en_viaje') {
      statusText = 'En viaje';
      statusColor = 'text-amber-400 bg-amber-500/10 border-amber-500/20';
      dotColor = 'bg-amber-400 animate-pulse';
    } else if (st === 'en_confirmacion' || st === 'confirmando') {
      statusText = 'Confirmando';
      statusColor = 'text-blue-400 bg-blue-500/10 border-blue-500/20';
      dotColor = 'bg-blue-400 animate-pulse';
    }

    const name = c.nombre_cad || c.nombre || `Cadete #${c.id_cad}`;
    const initials = name
      .split(' ')
      .filter(Boolean)
      .map(n => n[0])
      .join('')
      .substring(0, 2)
      .toUpperCase() || 'CD';

    const vehicle = c.vehiculo_cad || 'Moto';
    const plate = (c.patente && c.patente !== '-') ? ` • ${c.patente}` : '';

    const div = document.createElement('div');
    div.className = 'flex items-center justify-between p-3 rounded-2xl bg-brand-dark/70 border border-brand-border hover:border-brand-accent/40 transition-all cursor-pointer group shadow-sm';
    div.title = `Ver información de ${name} en Gestión de Cadetes`;
    div.onclick = () => {
      window.location.href = `gestion_de_personal.html?search=${encodeURIComponent(name)}`;
    };

    div.innerHTML = `
      <div class="flex items-center gap-3 min-w-0">
        <div class="relative shrink-0">
          <div class="w-10 h-10 rounded-xl bg-zinc-800 border border-brand-border flex items-center justify-center font-bold text-xs text-white shadow-inner group-hover:border-brand-accent/50 transition-colors">
            ${initials}
          </div>
          <span class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ${dotColor} border-2 border-brand-dark"></span>
        </div>
        <div class="min-w-0">
          <div class="flex items-center gap-1.5">
            <h5 class="text-xs font-bold text-white truncate group-hover:text-brand-accent transition-colors">${name}</h5>
            ${c.alias_cad && c.alias_cad !== '-' ? `<span class="text-[9px] text-zinc-400 bg-zinc-800 px-1 py-0.2 rounded border border-zinc-700">@${c.alias_cad}</span>` : ''}
          </div>
          <p class="text-[11px] text-zinc-400 truncate mt-0.5 font-mono">ID #${c.id_cad} • ${vehicle}${plate}</p>
        </div>
      </div>
      <span class="text-[10px] font-bold px-2.5 py-1 rounded-full border ${statusColor} shrink-0">${statusText}</span>
    `;
    container.appendChild(div);
  });

  if (window.lucide) window.lucide.createIcons();
}

// =========================================================================
// AUTO-INICIALIZACIÓN ROBUSTA (READYSTATE CHECK)
// =========================================================================
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => {
    initDashboard();
  });
} else {
  initDashboard();
}

// =========================================================================
// CONTROLADOR DEL MODAL DE DESGLOSE DE TIEMPO PROMEDIO & VARIANZA
// =========================================================================
export function openTiempoPromedioModal() {
  const modal = document.getElementById('modal-tiempo-desglose');
  const card = document.getElementById('modal-tiempo-card');
  if (!modal || !card) return;

  const { total, promedio, varianza, desviacion, min, max, rapidos, normales, demorados } = statsTiempo;

  const statAvg = document.getElementById('modal-stat-avg');
  const statDesv = document.getElementById('modal-stat-desv');
  const statRango = document.getElementById('modal-stat-rango');
  const statVar = document.getElementById('modal-stat-var');
  const statTotal = document.getElementById('modal-stat-total-pedidos');
  const statMin = document.getElementById('modal-stat-min');
  const statMax = document.getElementById('modal-stat-max');
  const diagTexto = document.getElementById('modal-diagnostico-texto');

  if (statAvg) statAvg.innerText = `${promedio} min`;
  if (statDesv) statDesv.innerText = `± ${desviacion} min`;
  if (statRango) {
    const rangoMin = Math.max(1, Math.round(promedio - desviacion));
    const rangoMax = Math.round(promedio + desviacion);
    statRango.innerText = total > 0 ? `${rangoMin} a ${rangoMax} min` : '0 min';
  }
  if (statVar) statVar.innerText = `${varianza} min²`;
  if (statTotal) statTotal.innerText = `${total} pedidos evaluados`;
  if (statMin) statMin.innerText = total > 0 ? `${min} min` : '-';
  if (statMax) statMax.innerText = total > 0 ? `${max} min` : '-';

  // Porcentajes de barras
  const pRapidos = total > 0 ? Math.round((rapidos / total) * 100) : 0;
  const pNormales = total > 0 ? Math.round((normales / total) * 100) : 0;
  const pDemorados = total > 0 ? Math.round((demorados / total) * 100) : 0;

  const rapCount = document.getElementById('modal-dist-rapidos-count');
  const normCount = document.getElementById('modal-dist-normales-count');
  const demCount = document.getElementById('modal-dist-demorados-count');
  const barRap = document.getElementById('modal-bar-rapidos');
  const barNorm = document.getElementById('modal-bar-normales');
  const barDem = document.getElementById('modal-bar-demorados');

  if (rapCount) rapCount.innerText = `${rapidos} (${pRapidos}%)`;
  if (normCount) normCount.innerText = `${normales} (${pNormales}%)`;
  if (demCount) demCount.innerText = `${demorados} (${pDemorados}%)`;

  if (barRap) barRap.style.width = `${pRapidos}%`;
  if (barNorm) barNorm.style.width = `${pNormales}%`;
  if (barDem) barDem.style.width = `${pDemorados}%`;

  // Diagnóstico contextual
  if (diagTexto) {
    if (total === 0) {
      diagTexto.innerText = 'Aún no se registran pedidos finalizados con tiempo computado para generar el desglose estadístico.';
    } else if (desviacion <= 5) {
      diagTexto.innerText = `Alta consistencia y predictibilidad. Los envíos varían muy poco (±${desviacion} min), por lo que la gran mayoría de clientes recibe su pedido entre ${Math.max(1, Math.round(promedio - desviacion))} y ${Math.round(promedio + desviacion)} min.`;
    } else if (desviacion <= 10) {
      diagTexto.innerText = `Consistencia regular. El tiempo de entrega promedio es de ${promedio} min con una oscilación típica de ±${desviacion} min según la zona y demanda del momento.`;
    } else {
      diagTexto.innerText = `Dispersión elevada (±${desviacion} min). Existen pedidos con demoras atípicas que superan la media (hasta ${max} min), lo que sugiere revisar distancias o disponibilidad de cadetes en horas pico.`;
    }
  }

  // Apertura animada
  modal.classList.remove('hidden');
  setTimeout(() => {
    modal.classList.remove('opacity-0');
    modal.classList.add('opacity-100');
    card.classList.remove('scale-95');
    card.classList.add('scale-100');
  }, 10);

  if (window.lucide) window.lucide.createIcons();
}

export function closeTiempoPromedioModal() {
  const modal = document.getElementById('modal-tiempo-desglose');
  const card = document.getElementById('modal-tiempo-card');
  if (!modal || !card) return;

  modal.classList.remove('opacity-100');
  modal.classList.add('opacity-0');
  card.classList.remove('scale-100');
  card.classList.add('scale-95');

  setTimeout(() => {
    modal.classList.add('hidden');
  }, 300);
}

// Cerrar con Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeTiempoPromedioModal();
  }
});

// Exponer globalmente
if (typeof window !== 'undefined') {
  window.initDashboard = initDashboard;
  window.cargarUltimosPedidos = cargarUltimosPedidos;
  window.cargarFlotaCadetes = cargarFlotaCadetes;
  window.openTiempoPromedioModal = openTiempoPromedioModal;
  window.closeTiempoPromedioModal = closeTiempoPromedioModal;
}
