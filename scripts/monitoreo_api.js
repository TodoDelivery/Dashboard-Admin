import { supabase } from './conexion_supabase.js';

let orders = [];
let availableCadetes = [];
let currentSelectedOrderId = null;
let currentSearch = '';

export async function initMonitoreo() {
  await fetchCadetes();
  await fetchOrders();
  iniciarSuscripciones();
  
  // Render inicial
  renderColumns();
}

function normalizeStatus(st, hasCadete) {
  if (!st) return hasCadete ? 'in_transit' : 'unassigned';
  const s = st.toLowerCase().trim();
  if (s === 'delivered' || s === 'entregado' || s === 'finalizado' || s === 'completado') {
    return 'delivered';
  }
  if (s === 'in_transit' || s === 'en_curso' || s === 'en_camino' || s === 'asignado' || (hasCadete && s !== 'unassigned' && s !== 'pendiente')) {
    return 'in_transit';
  }
  return 'unassigned';
}

async function fetchCadetes() {
  const { data, error } = await supabase
    .from('Cadetes')
    .select('*');
    
  if (!error && data) {
    // Cadetes disponibles para asignación (no ocupados)
    availableCadetes = data.filter(c => c.estado_cad !== 'ocupado');
  }
}

async function fetchOrders() {
  const { data, error } = await supabase
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
      Cadetes ( id_cad, nombre_cad, telef_cad, vehiculo_cad ),
      Clientes ( id_cliente, nombre_cliente, telefono_cliente )
    `)
    .order('fecha_pedido', { ascending: false })
    .limit(100);

  if (error) {
    console.error("Error al cargar pedidos en monitor:", error);
    return;
  }

  if (data) {
    orders = data.map(o => {
      const hasCadete = !!o.id_cadete || (o.Cadetes && !!o.Cadetes.id_cad);
      const normalizedStatus = normalizeStatus(o.estado_pedido, hasCadete);
      const dateObj = o.fecha_pedido ? new Date(o.fecha_pedido) : new Date();
      const timeStr = isNaN(dateObj.getTime()) ? 'Reciente' : dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      return {
        id: o.id_pedido,
        time: timeStr,
        origin: 'Sucursal Central',
        destination: o.inform_pedido || 'Dirección de Entrega',
        customer: o.Clientes && o.Clientes.nombre_cliente ? o.Clientes.nombre_cliente : (o.id_cliente ? `Cliente #${String(o.id_cliente).substring(0,6)}` : 'Consumidor Final'),
        customerPhone: o.Clientes ? o.Clientes.telefono_cliente : '',
        total: parseFloat(o.coste_pedido) || 0,
        packageType: o.tipo_paquete || 'Paquete',
        estimatedTime: o.tiempo_pedido ? `${o.tiempo_pedido} min` : null,
        status: normalizedStatus,
        cadete: o.Cadetes ? o.Cadetes.nombre_cad : null,
        cadetePhone: o.Cadetes ? o.Cadetes.telef_cad : null,
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
      fetchCadetes().then(() => renderColumns());
    })
    .subscribe();
}

window.handleSearch = (e) => {
  currentSearch = e.target.value.toLowerCase();
  renderColumns();
};

window.renderColumns = () => {
  const filtered = orders.filter(o => {
    return o.id.toString().includes(currentSearch) || 
      o.customer.toLowerCase().includes(currentSearch) || 
      o.origin.toLowerCase().includes(currentSearch) ||
      o.destination.toLowerCase().includes(currentSearch) ||
      (o.packageType && o.packageType.toLowerCase().includes(currentSearch));
  });

  const unassigned = filtered.filter(o => o.status === 'unassigned');
  const inTransit = filtered.filter(o => o.status === 'in_transit');
  const delivered = filtered.filter(o => o.status === 'delivered');

  const countUnassignedEl = document.getElementById("count-unassigned");
  const countInTransitEl = document.getElementById("count-in-transit");
  if (countUnassignedEl) countUnassignedEl.innerText = unassigned.length;
  if (countInTransitEl) countInTransitEl.innerText = inTransit.length;
  if (countDeliveredEl) countDeliveredEl.innerText = delivered.length;

  renderCardList("col-unassigned", unassigned);
  renderCardList("col-in-transit", inTransit);
  renderCardList("col-delivered", delivered);
  
  if (window.lucide) window.lucide.createIcons();
};

function renderCardList(containerId, list) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";

  if (list.length === 0) {
    container.innerHTML = `
      <div class="h-32 flex flex-col items-center justify-center text-zinc-600 border border-dashed border-brand-border/60 rounded-xl">
        <i data-lucide="inbox" class="w-6 h-6 mb-1 opacity-40"></i>
        <span class="text-xs">Sin pedidos en este estado</span>
      </div>
    `;
    return;
  }

  list.forEach(order => {
    const card = document.createElement("div");
    card.className = "bg-brand-card border border-brand-border rounded-2xl p-4 space-y-3.5 hover:border-zinc-600 transition-all shadow-lg";

    const isUnassigned = order.status === 'unassigned';
    const isInTransit = order.status === 'in_transit';

    card.innerHTML = `
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="font-bold text-white text-xs font-mono">#TD-${order.id}</span>
          <span class="text-[10px] text-zinc-400 bg-brand-dark px-2 py-0.5 rounded border border-brand-border">${order.time}</span>
          ${order.packageType ? `<span class="text-[9px] font-semibold text-brand-gold bg-brand-gold/10 px-1.5 py-0.5 rounded border border-brand-gold/20">${order.packageType}</span>` : ''}
        </div>
        <span class="text-[11px] font-bold text-emerald-400 font-mono">
          $${order.total.toLocaleString()}
        </span>
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

      <div class="p-2 bg-brand-dark/70 rounded-xl border border-brand-border/60 text-[11px] text-zinc-400 flex items-center justify-between">
        <span class="truncate">Cliente: <strong class="text-zinc-200">${order.customer}</strong></span>
        ${order.customerPhone ? `<span class="text-zinc-500 font-mono text-[10px]">${order.customerPhone}</span>` : `<span class="text-zinc-500 font-mono text-[10px]">Detalles</span>`}
      </div>

      <div class="pt-2 border-t border-brand-border/60 flex items-center justify-between">
        <div class="flex items-center gap-1.5">
          ${order.cadete 
            ? `<div class="w-6 h-6 rounded-full bg-zinc-800 text-white text-[10px] flex items-center justify-center font-bold">${order.cadete.split(' ').map(n=>n[0]).join('').substring(0,2)}</div>
               <span class="text-xs text-zinc-300 font-medium">${order.cadete}</span>`
            : `<span class="text-xs text-amber-400 font-medium flex items-center gap-1"><i data-lucide="alert-circle" class="w-3.5 h-3.5"></i> Sin asignar</span>`
          }
        </div>

        <div class="flex items-center gap-1.5">
          ${isUnassigned ? `
            <button onclick="openAssignModal('${order.id}')" class="px-3 py-1.5 bg-brand-accent hover:bg-brand-accentHover text-white text-xs font-bold rounded-xl shadow-md transition-all flex items-center gap-1">
              <i data-lucide="user-check" class="w-3.5 h-3.5"></i> Despachar
            </button>
          ` : ''}

          ${isInTransit ? `
            <button onclick="markDelivered('${order.id}')" title="Marcar como entregado" class="p-1.5 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-white border border-emerald-500/20 rounded-lg transition-all">
              <i data-lucide="check" class="w-3.5 h-3.5"></i>
            </button>
            <button onclick="openAssignModal('${order.id}')" title="Reasignar cadete" class="p-1.5 bg-brand-dark text-zinc-400 hover:text-white border border-brand-border rounded-lg transition-all">
              <i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i>
            </button>
          ` : ''}
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

window.openAssignModal = (orderId) => {
  currentSelectedOrderId = orderId;
  const titleEl = document.getElementById("modal-order-title");
  if (titleEl) titleEl.innerText = `Pedido #TD-${orderId}`;
  
  const listContainer = document.getElementById("cadetes-select-list");
  if (!listContainer) return;
  listContainer.innerHTML = "";

  if (availableCadetes.length === 0) {
    listContainer.innerHTML = '<p class="text-xs text-zinc-500 text-center py-4">No hay cadetes disponibles en este momento.</p>';
  }

  availableCadetes.forEach(cadete => {
    const item = document.createElement("button");
    item.type = "button";
    item.onclick = () => window.assignCadeteToOrder(cadete.id_cad);
    item.className = "w-full flex items-center justify-between p-3 rounded-xl bg-brand-dark border border-brand-border hover:border-brand-accent/50 text-left transition-all group";
    
    item.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center font-bold text-xs text-white">
          ${cadete.nombre_cad.split(' ').map(n=>n[0]).join('').substring(0,2)}
        </div>
        <div>
          <h5 class="text-xs font-bold text-white group-hover:text-brand-accent transition-colors">${cadete.nombre_cad}</h5>
          <p class="text-[10px] text-zinc-400">${cadete.vehiculo_cad || 'Vehículo'} • Disponible</p>
        </div>
      </div>
      <span class="text-xs font-bold text-emerald-400">Asignar</span>
    `;
    listContainer.appendChild(item);
  });

  const m = document.getElementById('assign-modal');
  const c = document.getElementById('assign-container');
  if (m && c) {
    m.classList.remove('hidden');
    setTimeout(() => {
      m.classList.add('opacity-100');
      c.classList.remove('scale-95');
    }, 10);
  }
  if (window.lucide) window.lucide.createIcons();
};

window.closeAssignModal = () => {
  const m = document.getElementById('assign-modal');
  const c = document.getElementById('assign-container');
  if (m && c) {
    m.classList.remove('opacity-100');
    c.classList.add('scale-95');
    setTimeout(() => m.classList.add('hidden'), 300);
  }
};

window.assignCadeteToOrder = async (cadeteId) => {
  window.closeAssignModal();
  
  // Actualizar en Supabase
  const { error } = await supabase
    .from('Pedidos')
    .update({ 
      id_cadete: cadeteId, 
      estado_pedido: 'in_transit' 
    })
    .eq('id_pedido', currentSelectedOrderId);
    
  if (error) {
    alert('Error al asignar cadete: ' + error.message);
  } else {
    // También actualizar estado del cadete a ocupado
    await supabase.from('Cadetes').update({ estado_cad: 'ocupado' }).eq('id_cad', cadeteId);
  }
};

window.markDelivered = async (orderId) => {
  const order = orders.find(o => o.id === orderId);
  if (!order) return;
  
  const { error } = await supabase
    .from('Pedidos')
    .update({ estado_pedido: 'delivered' })
    .eq('id_pedido', orderId);
    
  if (error) {
    alert('Error al actualizar pedido: ' + error.message);
  } else if (order.raw_data.id_cadete) {
    // Liberar al cadete
    await supabase.from('Cadetes').update({ estado_cad: 'libre' }).eq('id_cad', order.raw_data.id_cadete);
  }
};

// Start
window.addEventListener('DOMContentLoaded', () => {
  initMonitoreo();
});
