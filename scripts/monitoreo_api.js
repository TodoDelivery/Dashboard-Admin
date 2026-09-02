import { supabase } from './conexion_supabase.js';

let orders = [];
let availableCadetes = [];
let allCadetesCache = new Map();
let allClientesCache = new Map();
let currentSelectedOrderId = null;
let currentSearch = '';
let deliveredFilter = 'today'; // 'today' | 'all'

export async function initMonitoreo() {
  await Promise.all([
    fetchAllCadetes(),
    fetchAllClientes()
  ]);
  await fetchOrders();
  iniciarSuscripciones();
  
  // Render inicial
  renderColumns();

  // Abrir pedido específico si viene en la URL (?orderId=...)
  const urlParams = new URLSearchParams(window.location.search);
  const targetOrderId = urlParams.get('orderId');
  if (targetOrderId) {
    setTimeout(() => {
      window.openOrderModal(targetOrderId);
    }, 250);
  }

  // Polling de respaldo cada 25 segundos para no depender únicamente del socket
  setInterval(() => {
    fetchOrders().then(() => renderColumns());
  }, 25000);
}

function isSameDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() &&
         d1.getMonth() === d2.getMonth() &&
         d1.getDate() === d2.getDate();
}

function isOrderToday(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  return isSameDay(d, new Date());
}

function formatOrderDate(dateObj) {
  if (!dateObj || isNaN(dateObj.getTime())) return 'Reciente';
  const now = new Date();
  const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isSameDay(dateObj, now)) {
    return timeStr;
  }
  const dateStr = dateObj.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
  return `${dateStr} ${timeStr}`;
}

function normalizeStatus(st, hasCadete) {
  if (!st) return hasCadete ? 'in_transit' : 'unassigned';
  const s = String(st).toLowerCase().trim();
  if (s === 'delivered' || s === 'entregado' || s === 'finalizado' || s === 'completado') {
    return 'delivered';
  }
  if (s === 'in_transit' || s === 'en_curso' || s === 'en_camino' || s === 'asignado' || s === 'en_ruta') {
    return 'in_transit';
  }
  if (s === 'cancelled' || s === 'cancelado' || s === 'anulado') {
    return 'cancelled';
  }
  if (hasCadete && s !== 'unassigned' && s !== 'pendiente' && s !== 'en_confirmacion') {
    return 'in_transit';
  }
  return 'unassigned';
}

async function fetchAllCadetes() {
  const { data, error } = await supabase.from('Cadetes').select('*');
  if (!error && data) {
    allCadetesCache.clear();
    data.forEach(c => allCadetesCache.set(c.id_cad, c));
    availableCadetes = data.filter(c => {
      const st = String(c.estado_cad || '').toLowerCase();
      return st !== 'ocupado';
    });
  }
}

async function fetchAllClientes() {
  const { data, error } = await supabase.from('Clientes').select('*');
  if (!error && data) {
    allClientesCache.clear();
    data.forEach(cl => allClientesCache.set(cl.id_cliente, cl));
  }
}

async function fetchOrders() {
  // 1. Intentar consulta enriquecida con relaciones directas
  let queryData = null;
  let queryError = null;

  const res = await supabase
    .from('Pedidos')
    .select(`
      id_pedido, 
      coste_pedido, 
      estado_pedido, 
      tiempo_pedido,
      inform_pedido,
      tipo_paquete,
      fecha_pedido,
      latitud_org,
      longitud_org,
      latitud_dest,
      longitud_dest,
      id_cadete,
      id_cliente,
      Cadetes ( id_cad, nombre_cad, telef_cad, vehiculo_cad ),
      Clientes ( id_cliente, nombre_cliente, telefono_cliente )
    `)
    .order('fecha_pedido', { ascending: false })
    .limit(500);

  if (res.error) {
    console.warn("Consulta con relaciones falló, intentando consulta plana de respaldo:", res.error);
    // Fallback: consulta sin joins
    const fallbackRes = await supabase
      .from('Pedidos')
      .select('*')
      .order('fecha_pedido', { ascending: false })
      .limit(500);

    queryData = fallbackRes.data;
    queryError = fallbackRes.error;
  } else {
    queryData = res.data;
  }

  if (queryError) {
    console.error("Error al cargar pedidos desde Supabase:", queryError);
    return;
  }

  if (queryData) {
    orders = queryData.map(o => {
      const hasCadete = !!o.id_cadete || (o.Cadetes && !!o.Cadetes.id_cad);
      const normalizedStatus = normalizeStatus(o.estado_pedido, hasCadete);
      const dateObj = o.fecha_pedido ? new Date(o.fecha_pedido) : new Date();
      const formattedTime = formatOrderDate(dateObj);

      // Resolver Cadete (vía join o vía cache local)
      let cadeteNombre = null;
      let cadetePhone = null;
      if (o.Cadetes && o.Cadetes.nombre_cad) {
        cadeteNombre = o.Cadetes.nombre_cad;
        cadetePhone = o.Cadetes.telef_cad;
      } else if (o.id_cadete && allCadetesCache.has(o.id_cadete)) {
        const c = allCadetesCache.get(o.id_cadete);
        cadeteNombre = c.nombre_cad;
        cadetePhone = c.telef_cad;
      }

      // Resolver Cliente (vía join o vía cache local)
      let clienteNombre = 'Consumidor Final';
      let clientePhone = '';
      if (o.Clientes && o.Clientes.nombre_cliente) {
        clienteNombre = o.Clientes.nombre_cliente;
        clientePhone = o.Clientes.telefono_cliente || '';
      } else if (o.id_cliente && allClientesCache.has(o.id_cliente)) {
        const cl = allClientesCache.get(o.id_cliente);
        clienteNombre = cl.nombre_cliente || 'Consumidor Final';
        clientePhone = cl.telefono_cliente || '';
      } else if (o.id_cliente) {
        clienteNombre = `Cliente #${String(o.id_cliente).substring(0, 6)}`;
      }

      return {
        id: o.id_pedido,
        time: formattedTime,
        raw_date: o.fecha_pedido,
        origin: 'Sucursal Central',
        destination: o.inform_pedido || 'Dirección de Entrega',
        customer: clienteNombre,
        customerPhone: clientePhone,
        total: parseFloat(o.coste_pedido) || 0,
        packageType: o.tipo_paquete || 'Paquete',
        estimatedTime: o.tiempo_pedido ? `${o.tiempo_pedido} min` : null,
        status: normalizedStatus,
        raw_status: o.estado_pedido,
        cadete: cadeteNombre,
        cadetePhone: cadetePhone,
        raw_data: o
      };
    });
  }
}

function iniciarSuscripciones() {
  // Suscripción Realtime a la tabla Pedidos
  supabase.channel('monitor-pedidos-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'Pedidos' }, () => {
      fetchOrders().then(() => renderColumns());
    })
    .subscribe();
    
  // Suscripción Realtime a la tabla Cadetes
  supabase.channel('monitor-cadetes-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'Cadetes' }, () => {
      fetchAllCadetes().then(() => renderColumns());
    })
    .subscribe();
}

window.handleSearch = (e) => {
  currentSearch = e.target.value.toLowerCase().trim();
  renderColumns();
};

window.setDeliveredFilter = (filter) => {
  deliveredFilter = filter;
  
  const btnToday = document.getElementById('btn-delivered-today');
  const btnAll = document.getElementById('btn-delivered-all');

  if (filter === 'today') {
    if (btnToday) btnToday.className = "px-2.5 py-1 rounded-lg font-bold transition-all bg-brand-accent text-white shadow-sm";
    if (btnAll) btnAll.className = "px-2.5 py-1 rounded-lg font-bold transition-all text-zinc-400 hover:text-white";
  } else {
    if (btnAll) btnAll.className = "px-2.5 py-1 rounded-lg font-bold transition-all bg-brand-accent text-white shadow-sm";
    if (btnToday) btnToday.className = "px-2.5 py-1 rounded-lg font-bold transition-all text-zinc-400 hover:text-white";
  }

  renderColumns();
};

window.refreshMonitoreo = async () => {
  const icon = document.getElementById('refresh-icon');
  if (icon) icon.classList.add('animate-spin');

  await Promise.all([
    fetchAllCadetes(),
    fetchAllClientes(),
    fetchOrders()
  ]);

  renderColumns();

  setTimeout(() => {
    if (icon) icon.classList.remove('animate-spin');
  }, 500);
};

window.renderColumns = () => {
  const filtered = orders.filter(o => {
    return o.id.toString().includes(currentSearch) || 
      o.customer.toLowerCase().includes(currentSearch) || 
      o.origin.toLowerCase().includes(currentSearch) ||
      o.destination.toLowerCase().includes(currentSearch) ||
      (o.packageType && o.packageType.toLowerCase().includes(currentSearch)) ||
      (o.cadete && o.cadete.toLowerCase().includes(currentSearch));
  });

  // Columna 1: Por Asignar (incluye cancelados sin cadete para visibilidad operativa)
  const unassigned = filtered.filter(o => o.status === 'unassigned' || o.status === 'cancelled');
  
  // Columna 2: En tránsito / curso
  const inTransit = filtered.filter(o => o.status === 'in_transit');
  
  // Columna 3: Entregados (según filtro Hoy vs Histórico)
  const allDelivered = filtered.filter(o => o.status === 'delivered');
  const displayedDelivered = deliveredFilter === 'today'
    ? allDelivered.filter(o => isOrderToday(o.raw_date))
    : allDelivered;

  const countUnassignedEl = document.getElementById("count-unassigned");
  const countInTransitEl = document.getElementById("count-in-transit");
  const countDeliveredEl = document.getElementById("count-delivered");

  if (countUnassignedEl) countUnassignedEl.innerText = unassigned.length;
  if (countInTransitEl) countInTransitEl.innerText = inTransit.length;
  if (countDeliveredEl) countDeliveredEl.innerText = displayedDelivered.length;

  renderCardList("col-unassigned", unassigned);
  renderCardList("col-in-transit", inTransit);
  renderCardList("col-delivered", displayedDelivered);
  
  if (window.lucide) window.lucide.createIcons();
};

function renderCardList(containerId, list) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";

  if (list.length === 0) {
    const isDeliveredEmpty = containerId === 'col-delivered';
    const emptyMsg = isDeliveredEmpty && deliveredFilter === 'today'
      ? 'No hay entregas registradas hoy'
      : 'Sin pedidos en este estado';

    container.innerHTML = `
      <div class="h-32 flex flex-col items-center justify-center text-zinc-600 border border-dashed border-brand-border/60 rounded-xl">
        <i data-lucide="inbox" class="w-6 h-6 mb-1 opacity-40"></i>
        <span class="text-xs">${emptyMsg}</span>
      </div>
    `;
    return;
  }

  list.forEach(order => {
    const card = document.createElement("div");
    card.className = "bg-brand-card border border-brand-border rounded-2xl p-4 space-y-3.5 hover:border-zinc-500 transition-all shadow-lg cursor-pointer group";
    card.onclick = (e) => {
      if (!e.target.closest("button") && !e.target.closest("a")) {
        window.openOrderModal(order.id);
      }
    };

    const isUnassigned = order.status === 'unassigned';
    const isInTransit = order.status === 'in_transit';
    const isCancelled = order.status === 'cancelled';
    const isDelivered = order.status === 'delivered';

    let statusBadge = '';
    if (isCancelled) {
      statusBadge = `<span class="text-[9px] font-bold text-red-400 bg-red-500/10 px-2 py-0.5 rounded border border-red-500/20">Cancelado</span>`;
    } else if (order.packageType) {
      statusBadge = `<span class="text-[9px] font-semibold text-brand-gold bg-brand-gold/10 px-1.5 py-0.5 rounded border border-brand-gold/20">${order.packageType}</span>`;
    }

    card.innerHTML = `
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="font-bold text-white text-xs font-mono group-hover:text-brand-accent transition-colors">#TD-${order.id}</span>
          <span class="text-[10px] text-zinc-400 bg-brand-dark px-2 py-0.5 rounded border border-brand-border">${order.time}</span>
          ${statusBadge}
        </div>
        <div class="flex items-center gap-1.5">
          <span class="text-[11px] font-bold text-emerald-400 font-mono">
            $${order.total.toLocaleString()}
          </span>
          <button onclick="event.stopPropagation(); window.openOrderModal('${order.id}')" title="Ver / Gestionar Pedido (Solo Lectura)" class="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-brand-dark border border-brand-border/40 transition-all">
            <i data-lucide="eye" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      </div>

      <div class="space-y-1.5 text-xs">
        <div class="flex items-start gap-2 text-zinc-300">
          <i data-lucide="store" class="w-3.5 h-3.5 text-zinc-500 mt-0.5 shrink-0"></i>
          <span class="truncate font-medium">${order.origin}</span>
        </div>
        <div class="flex items-start gap-2 text-zinc-300">
          <i data-lucide="map-pin" class="w-3.5 h-3.5 text-brand-accent mt-0.5 shrink-0"></i>
          <span class="truncate font-medium">${order.destination}</span>
        </div>
      </div>

      <div onclick="event.stopPropagation(); window.openOrderModal('${order.id}')" class="p-2 bg-brand-dark/70 rounded-xl border border-brand-border/60 text-[11px] text-zinc-400 flex items-center justify-between hover:border-zinc-500 transition-colors" title="Ver detalles del pedido">
        <span class="truncate">Cliente: <strong class="text-zinc-200">${order.customer}</strong></span>
        <span class="text-zinc-400 font-mono text-[10px] flex items-center gap-1 hover:text-white">
          <i data-lucide="file-text" class="w-3 h-3 text-brand-gold"></i> Detalles
        </span>
      </div>

      <div class="pt-2 border-t border-brand-border/60 flex items-center justify-between">
        <div class="flex items-center gap-1.5">
          ${order.cadete 
            ? `<div class="w-6 h-6 rounded-full bg-zinc-800 text-white text-[10px] flex items-center justify-center font-bold">${order.cadete.split(' ').map(n=>n[0]).join('').substring(0,2)}</div>
               <span class="text-xs text-zinc-300 font-medium truncate max-w-[110px]">${order.cadete}</span>`
            : (isCancelled
                ? `<span class="text-xs text-zinc-500 font-medium flex items-center gap-1"><i data-lucide="x-circle" class="w-3.5 h-3.5"></i> Anulado</span>`
                : `<span class="text-xs text-amber-400 font-medium flex items-center gap-1"><i data-lucide="alert-circle" class="w-3.5 h-3.5"></i> Sin asignar</span>`
              )
          }
        </div>

        <div class="flex items-center gap-2">
          ${isInTransit ? `
            <span class="text-[10px] font-semibold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20 flex items-center gap-1">
              <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span> En viaje
            </span>
          ` : ''}

          ${isDelivered ? `
            <span class="text-[10px] font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 flex items-center gap-1">
              <i data-lucide="check" class="w-3 h-3"></i> Entregado
            </span>
          ` : ''}

          <button onclick="event.stopPropagation(); window.deleteOrder('${order.id}')" title="Eliminar Pedido" class="px-2.5 py-1 text-xs font-semibold text-red-400 hover:text-white bg-red-500/10 hover:bg-red-600 border border-red-500/20 rounded-xl transition-all flex items-center gap-1 shadow-sm">
            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            <span>Eliminar</span>
          </button>
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}



/* ====================================================
   MODAL EDITOR DE PEDIDOS (SOLO LECTURA & ELIMINAR)
   ==================================================== */

window.openOrderModal = (orderId) => {
  const order = orders.find(o => String(o.id) === String(orderId));
  if (!order) return;

  currentSelectedOrderId = order.id;

  const subtitleEl = document.getElementById('order-modal-subtitle');
  if (subtitleEl) subtitleEl.innerText = `Pedido #TD-${order.id}`;

  const statusBadgeContainer = document.getElementById('order-modal-status-badge');
  if (statusBadgeContainer) {
    let badgeHtml = '';
    if (order.status === 'unassigned') {
      badgeHtml = '<span class="px-2.5 py-1 rounded-full text-[11px] font-bold bg-blue-500/10 text-blue-400 border border-blue-500/20">Por Asignar</span>';
    } else if (order.status === 'in_transit') {
      badgeHtml = '<span class="px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping"></span> En Curso</span>';
    } else if (order.status === 'delivered') {
      badgeHtml = '<span class="px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1"><i data-lucide="check" class="w-3 h-3"></i> Entregado</span>';
    } else if (order.status === 'cancelled') {
      badgeHtml = '<span class="px-2.5 py-1 rounded-full text-[11px] font-bold bg-red-500/10 text-red-400 border border-red-500/20">Cancelado</span>';
    }
    statusBadgeContainer.innerHTML = badgeHtml;
  }

  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  };
  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.innerText = val;
  };

  setVal('order-view-id', `#TD-${order.id}`);
  
  let formattedFullDate = order.time;
  if (order.raw_date) {
    try {
      const d = new Date(order.raw_date);
      formattedFullDate = `${d.toLocaleDateString()} a las ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } catch (e) {}
  }
  setVal('order-view-date', formattedFullDate);
  setVal('order-view-customer', order.customer);
  setVal('order-view-phone', order.customerPhone || 'Sin teléfono registrado');
  setVal('order-view-cadete', order.cadete || 'Sin repartidor asignado');

  let cadeteDetail = 'Sin detalles';
  if (order.cadete) {
    const veh = order.raw_data?.Cadetes?.vehiculo_cad || 'Vehículo';
    const tel = order.cadetePhone ? ` • Tel: ${order.cadetePhone}` : '';
    cadeteDetail = `${veh}${tel}`;
  }
  setVal('order-view-cadete-detail', cadeteDetail);
  setVal('order-view-total', `$${order.total.toLocaleString()}`);
  setVal('order-view-time', order.estimatedTime || 'No especificado');
  setVal('order-view-package', order.packageType || 'Estándar');
  setVal('order-view-info', order.raw_data?.inform_pedido || order.destination || 'Sin descripción detallada');
  setText('order-view-origin', order.origin || 'Sucursal Central');
  setText('order-view-destination', order.destination || 'Dirección de Entrega');

  const btnDel = document.getElementById('btn-delete-order');
  if (btnDel) {
    btnDel.disabled = false;
    btnDel.innerHTML = `<i data-lucide="trash-2" class="w-4 h-4"></i> <span>Eliminar Pedido</span>`;
  }

  const m = document.getElementById('order-modal-backdrop');
  const c = document.getElementById('order-modal-container');
  if (m && c) {
    m.classList.remove('hidden');
    setTimeout(() => {
      m.classList.add('opacity-100');
      c.classList.remove('scale-95');
    }, 10);
  }
  if (window.lucide) window.lucide.createIcons();
};

window.closeOrderModal = () => {
  const m = document.getElementById('order-modal-backdrop');
  const c = document.getElementById('order-modal-container');
  if (m && c) {
    m.classList.remove('opacity-100');
    c.classList.add('scale-95');
    setTimeout(() => m.classList.add('hidden'), 300);
  }
};

window.handleDeleteCurrentOrder = () => {
  if (currentSelectedOrderId) {
    window.deleteOrder(currentSelectedOrderId);
  }
};

window.deleteOrder = async (orderId) => {
  if (!orderId) return;
  const order = orders.find(o => String(o.id) === String(orderId));
  const confirmDelete = confirm(`¿Estás seguro de que deseas eliminar permanentemente el pedido #TD-${orderId}?\nEsta acción es irreversible y eliminará el registro de la base de datos.`);
  if (!confirmDelete) return;

  const btn = document.getElementById('btn-delete-order');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> <span>Eliminando...</span>`;
    if (window.lucide) window.lucide.createIcons();
  }

  try {
    // Si el pedido tenía un cadete asignado en viaje, liberarlo
    if (order && order.raw_data && order.raw_data.id_cadete && order.status === 'in_transit') {
      try {
        await supabase
          .from('Cadetes')
          .update({ estado_cad: 'disponible' })
          .eq('id_cad', order.raw_data.id_cadete);
      } catch (cadErr) {
        console.warn("No se pudo actualizar estado del cadete al eliminar pedido:", cadErr);
      }
    }

    const { error } = await supabase
      .from('Pedidos')
      .delete()
      .eq('id_pedido', orderId);

    if (error) {
      alert('Error al eliminar pedido: ' + error.message);
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i data-lucide="trash-2" class="w-4 h-4"></i> <span>Eliminar Pedido</span>`;
        if (window.lucide) window.lucide.createIcons();
      }
      return;
    }

    window.closeOrderModal();
    orders = orders.filter(o => String(o.id) !== String(orderId));
    renderColumns();
    await fetchOrders();
    renderColumns();
  } catch (err) {
    console.error("Error al eliminar pedido:", err);
    alert("Ocurrió un error inesperado al eliminar el pedido.");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="trash-2" class="w-4 h-4"></i> <span>Eliminar Pedido</span>`;
      if (window.lucide) window.lucide.createIcons();
    }
  }
};

// Inicialización garantizada sin depender únicamente de DOMContentLoaded
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => {
    initMonitoreo();
  });
} else {
  initMonitoreo();
}

window.initMonitoreo = initMonitoreo;
