import { supabase } from './conexion_supabase.js';

// =========================================================================
// ESTADO GLOBAL DE CAJA Y RENDICIONES (CASHOUT)
// =========================================================================
// Regla de Negocio Todo Delivery:
// Facturación Total (100%) = Σ(coste_pedido)
// Ganancia Neta Cadete (60%) = Math.round(totalFacturado * 0.6)
// Efectivo a Rendir a Central (40%) = Math.round(totalFacturado * 0.4)
// Ciclo: 'entregado' (en caja pendiente) -> 'rendido' (caja liquidada a cero)
// =========================================================================

let cadetesSettlement = [];
let rawDeliveredOrders = [];
let currentSelectedCadete = null;
let currentGeneratedToken = '';
let currentPeriod = 'all'; // 'today' | 'yesterday' | 'week' | 'month' | 'all'
let currentSearch = '';
let currentStatusFilter = 'all'; // 'all' | 'pending' | 'settled'
let realtimeChannel = null;

const STORAGE_SETTLEMENTS_KEY = 'todo_delivery_caja_settlements_v2';
const STORAGE_CLOSURES_KEY = 'todo_delivery_caja_cierres_v2';

// =========================================================================
// INICIALIZACIÓN
// =========================================================================
export async function initCaja() {
  setupPeriodBadges();
  await fetchSettlements();
  iniciarSuscripcionRealtime();
}

function getStoredSettlements() {
  try {
    const raw = localStorage.getItem(STORAGE_SETTLEMENTS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error('Error leyendo localStorage settlements', e);
    return {};
  }
}

function saveStoredSettlement(cadeteId, data) {
  try {
    const all = getStoredSettlements();
    all[cadeteId] = {
      ...data,
      timestamp: new Date().toISOString()
    };
    localStorage.setItem(STORAGE_SETTLEMENTS_KEY, JSON.stringify(all));
  } catch (e) {
    console.error('Error guardando en localStorage', e);
  }
}

function removeStoredSettlement(cadeteId) {
  try {
    const all = getStoredSettlements();
    delete all[cadeteId];
    localStorage.setItem(STORAGE_SETTLEMENTS_KEY, JSON.stringify(all));
  } catch (e) {
    console.error('Error removiendo en localStorage', e);
  }
}

// Generador del Token Único de Rendición conforme a la especificación de Todo Delivery:
// Formato: TD-${id_cad}-${YYYYMMDD}-${random4} (ej: TD-1-20260905-7481)
function generarTokenLiquidacion(idCadete) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const yyyymmdd = `${yyyy}${mm}${dd}`;
  const random4 = Math.floor(1000 + Math.random() * 9000);
  return `TD-${idCadete}-${yyyymmdd}-${random4}`;
}

// =========================================================================
// OBTENCIÓN Y AGRUPACIÓN DE DATOS DE SUPABASE
// =========================================================================
async function fetchSettlements() {
  mostrarLoading(true);

  // Determinar rango de fechas según currentPeriod
  const now = new Date();
  let startDate = null;
  let endDate = null;

  if (currentPeriod === 'today') {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  } else if (currentPeriod === 'yesterday') {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0);
    endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999);
  } else if (currentPeriod === 'week') {
    startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (currentPeriod === 'month') {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
  }

  // 1. Consultar pedidos con joins a Cadetes y Clientes
  let query = supabase
    .from('Pedidos')
    .select(`
      id_pedido,
      id_cadete,
      id_cliente,
      coste_pedido,
      inform_pedido,
      estado_pedido,
      tipo_paquete,
      fecha_pedido,
      tiempo_pedido,
      latitud_org,
      latitud_dest,
      longitud_org,
      longitud_dest,
      Cadetes (
        id_cad,
        nombre_cad,
        telef_cad,
        alias_cad,
        vehiculo_cad,
        patente,
        estado_cad
      ),
      Clientes (
        id_cliente,
        nombre_cliente,
        telefono_cliente
      )
    `)
    .order('fecha_pedido', { ascending: false });

  if (startDate) {
    query = query.gte('fecha_pedido', startDate.toISOString());
  }
  if (endDate) {
    query = query.lte('fecha_pedido', endDate.toISOString());
  }

  const { data: pedidos, error: errPedidos } = await query;

  if (errPedidos) {
    console.error("Error cargando pedidos para caja:", errPedidos);
    mostrarToast("Error al conectar con la base de datos de Pedidos", "error");
    mostrarLoading(false);
    return;
  }

  // 2. Filtrar únicamente los pedidos completados:
  // - 'entregado' (entregados en turno, pendientes de rendir)
  // - 'rendido' (pedidos ya liquidados/cerrados)
  // - 'delivered' (para compatibilidad de registros anteriores)
  const deliveredList = (pedidos || []).filter(p => {
    const st = String(p.estado_pedido || '').toLowerCase().trim();
    return st === 'entregado' || st === 'rendido' || st === 'delivered' || st === 'finalizado';
  });

  rawDeliveredOrders = deliveredList;

  // 3. Obtener liquidaciones guardadas localmente
  const storedSettlements = getStoredSettlements();

  // 4. Agrupar por cadete
  const map = new Map();

  deliveredList.forEach(p => {
    if (!p.id_cadete) return;

    const cadInfo = p.Cadetes || {};
    const cadeteId = p.id_cadete;

    if (!map.has(cadeteId)) {
      const nombre = cadInfo.nombre_cad || `Cadete #${cadeteId}`;
      const initials = nombre
        .split(' ')
        .filter(Boolean)
        .map(n => n[0])
        .join('')
        .substring(0, 2)
        .toUpperCase() || 'CD';

      map.set(cadeteId, {
        id: cadeteId,
        name: nombre,
        avatar: initials,
        phone: cadInfo.telef_cad || 'Sin teléfono',
        alias: cadInfo.alias_cad || '-',
        vehicle: cadInfo.vehiculo_cad || 'Moto',
        plate: cadInfo.patente || '-',
        statusCad: cadInfo.estado_cad || 'offline',
        trips: 0,
        totalVolume: 0,
        // Pedidos pendientes de rendición ('entregado' o 'delivered')
        pendingTrips: 0,
        pendingVolume: 0,
        // Pedidos ya rendidos ('rendido')
        rendidoTrips: 0,
        rendidoVolume: 0,
        orders: [],
        settled: false,
        settlementData: storedSettlements[cadeteId] || null
      });
    }

    const stat = map.get(cadeteId);
    const monto = parseFloat(p.coste_pedido) || 0;
    stat.trips += 1;
    stat.totalVolume += monto;
    stat.orders.push(p);

    const st = String(p.estado_pedido || '').toLowerCase().trim();
    if (st === 'rendido') {
      stat.rendidoTrips += 1;
      stat.rendidoVolume += monto;
    } else {
      stat.pendingTrips += 1;
      stat.pendingVolume += monto;
    }
  });

  // Determinar si está 100% rendido en este período
  map.forEach(stat => {
    stat.settled = (stat.pendingTrips === 0 && stat.trips > 0);
  });

  cadetesSettlement = Array.from(map.values());

  mostrarLoading(false);
  renderSettlementTable();
}

// =========================================================================
// SUSCRIPCIÓN EN TIEMPO REAL
// =========================================================================
function iniciarSuscripcionRealtime() {
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
  }

  realtimeChannel = supabase
    .channel('caja-realtime-pedidos')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'Pedidos' }, () => {
      fetchSettlements();
    })
    .subscribe();
}

// =========================================================================
// RENDERIZADO DE TABLA Y TARJETAS (KPIs)
// =========================================================================
window.renderSettlementTable = () => {
  const searchInput = document.getElementById("search-settlement");
  if (searchInput) currentSearch = searchInput.value.toLowerCase().trim();

  const statusSelect = document.getElementById("filter-settlement-status");
  if (statusSelect) currentStatusFilter = statusSelect.value;

  const tbody = document.getElementById("settlement-table-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  let totalGross = 0;
  let totalPendingStreet = 0;
  let totalCompany40 = 0;
  let totalCadetes60 = 0;
  let totalTrips = 0;

  // Filtrado de cadetes para la vista
  const filtered = cadetesSettlement.filter(c => {
    const matchSearch =
      c.name.toLowerCase().includes(currentSearch) ||
      c.alias.toLowerCase().includes(currentSearch) ||
      c.phone.toLowerCase().includes(currentSearch);

    let matchStatus = true;
    if (currentStatusFilter === 'pending') matchStatus = !c.settled;
    if (currentStatusFilter === 'settled') matchStatus = c.settled;

    return matchSearch && matchStatus;
  });

  // Calculamos métricas globales basadas en el esquema 60% Cadete / 40% Central
  cadetesSettlement.forEach(c => {
    const cadeteEarnings = Math.round(c.totalVolume * 0.6); // 60%
    const companyEarnings = Math.round(c.totalVolume * 0.4); // 40%
    const pendingOwed = Math.round(c.pendingVolume * 0.4); // 40% de lo pendiente

    totalGross += c.totalVolume;
    totalPendingStreet += pendingOwed;
    totalCompany40 += companyEarnings;
    totalCadetes60 += cadeteEarnings;
    totalTrips += c.trips;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="py-12 text-center text-zinc-400">
          <div class="flex flex-col items-center justify-center gap-3">
            <div class="w-12 h-12 rounded-2xl bg-zinc-800/80 border border-brand-border flex items-center justify-center text-zinc-500">
              <i data-lucide="inbox" class="w-6 h-6"></i>
            </div>
            <p class="font-semibold text-zinc-300">No se encontraron liquidaciones para este filtro</p>
            <p class="text-xs text-zinc-500 max-w-sm">Prueba cambiando el período de tiempo (ej. "Histórico Total" o "Últimos 7 días") o el filtro de estado.</p>
            <button onclick="changePeriodFilter('all')" class="mt-2 text-xs font-bold text-brand-accent hover:underline flex items-center gap-1">
              <i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i> Ver histórico completo
            </button>
          </div>
        </td>
      </tr>
    `;
    actualizarCards(totalGross, totalPendingStreet, totalCompany40, totalCadetes60, totalTrips);
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  filtered.forEach(c => {
    const cadeteEarnings = Math.round(c.totalVolume * 0.6); // 60%
    const companyEarnings = Math.round(c.totalVolume * 0.4); // 40%
    const pendingOwed = Math.round(c.pendingVolume * 0.4); // 40% pendiente de rendir

    const tr = document.createElement("tr");
    tr.className = "hover:bg-brand-dark/40 transition-colors border-b border-brand-border/40";

    tr.innerHTML = `
      <td class="py-4 px-4">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-zinc-800/90 border border-brand-border flex items-center justify-center font-bold text-xs text-white shadow-inner">
            ${c.avatar}
          </div>
          <div>
            <div class="flex items-center gap-2">
              <span class="font-bold text-white">${c.name}</span>
              ${c.alias && c.alias !== '-' ? `<span class="text-[10px] bg-zinc-800 text-zinc-300 px-1.5 py-0.5 rounded border border-zinc-700">@${c.alias}</span>` : ''}
            </div>
            <div class="flex items-center gap-2 text-[11px] text-zinc-400 mt-0.5">
              <span><i data-lucide="phone" class="w-3 h-3 inline mr-0.5 text-zinc-500"></i>${c.phone}</span>
              <span>•</span>
              <span class="${c.settled ? 'text-emerald-400 font-semibold' : 'text-amber-400 font-medium'}">
                ${c.settled ? 'Rendido al día' : `${c.pendingTrips} pendientes`}
              </span>
            </div>
          </div>
        </div>
      </td>
      <td class="py-4 px-4 font-mono text-zinc-300 font-medium">
        <div class="flex items-center gap-2">
          <span>${c.trips} viajes</span>
          <button onclick="openBreakdownModal(${c.id})" class="text-zinc-500 hover:text-brand-accent transition-colors p-1 rounded hover:bg-zinc-800" title="Ver desglose de pedidos">
            <i data-lucide="eye" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      </td>
      <td class="py-4 px-4 font-mono text-brand-gold font-semibold">
        $${c.totalVolume.toLocaleString('es-AR')}
      </td>
      <td class="py-4 px-4 font-mono text-zinc-200 font-semibold">
        <span class="text-emerald-400">+$${cadeteEarnings.toLocaleString('es-AR')}</span>
      </td>
      <td class="py-4 px-4 font-mono text-blue-400 font-semibold">
        $${companyEarnings.toLocaleString('es-AR')}
      </td>
      <td class="py-4 px-4 font-mono font-bold">
        ${c.settled
          ? `<span class="text-emerald-400 flex items-center gap-1.5 text-xs"><i data-lucide="check-check" class="w-4 h-4"></i> $0 (Caja a Cero)</span>`
          : `<span class="text-amber-400 flex items-center gap-1.5" title="Monto en efectivo que el cadete debe devolver a la central">
               <i data-lucide="arrow-down-right" class="w-4 h-4 text-amber-400"></i> $${pendingOwed.toLocaleString('es-AR')} (Rendir 40%)
             </span>`
        }
      </td>
      <td class="py-4 px-4 text-right">
        ${c.settled
          ? `<div class="inline-flex items-center gap-2">
               <button onclick="verConstanciaCadete(${c.id})" class="inline-flex items-center gap-1 text-xs text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 px-3 py-1.5 rounded-xl border border-emerald-500/20 font-medium transition-all" title="Ver constancia de liquidación">
                 <i data-lucide="check" class="w-3.5 h-3.5"></i> Rendido
               </button>
               <button onclick="reopenSettlement(${c.id})" class="text-zinc-500 hover:text-amber-400 p-1 rounded-lg hover:bg-zinc-800 text-xs transition-colors" title="Reabrir pedidos a 'entregado'">
                 <i data-lucide="rotate-ccw" class="w-3.5 h-3.5"></i>
               </button>
             </div>`
          : `<button onclick="openSettlementModal(${c.id})" class="px-3.5 py-2 bg-brand-accent hover:bg-brand-accentHover text-white text-xs font-bold rounded-xl shadow-lg shadow-brand-accent/20 transition-all active:scale-[0.97] flex items-center gap-1.5 ml-auto">
               <i data-lucide="hand-coins" class="w-3.5 h-3.5"></i>
               <span>Rendir Caja</span>
             </button>`
        }
      </td>
    `;
    tbody.appendChild(tr);
  });

  actualizarCards(totalGross, totalPendingStreet, totalCompany40, totalCadetes60, totalTrips);
  if (window.lucide) window.lucide.createIcons();
};

function actualizarCards(totalGross, totalPendingStreet, totalCompany40, totalCadetes60, totalTrips) {
  const domSales = document.getElementById("card-total-sales");
  const domStreet = document.getElementById("card-cash-street");
  const domNet = document.getElementById("card-net-earnings");
  const domPay = document.getElementById("card-cadetes-pay");
  const badgeInfo = document.getElementById("badge-period-info");

  if (domSales) domSales.innerText = `$${Math.round(totalGross).toLocaleString('es-AR')}`;
  if (domStreet) domStreet.innerText = `$${Math.round(totalPendingStreet).toLocaleString('es-AR')}`;
  if (domNet) domNet.innerText = `$${Math.round(totalCompany40).toLocaleString('es-AR')}`;
  if (domPay) domPay.innerText = `$${Math.round(totalCadetes60).toLocaleString('es-AR')}`;

  if (badgeInfo) {
    const periodNames = {
      today: 'Hoy',
      yesterday: 'Ayer',
      week: 'Últimos 7 días',
      month: 'Este Mes',
      all: 'Histórico Total'
    };
    badgeInfo.innerText = `${periodNames[currentPeriod] || 'Período'} • ${totalTrips} envíos procesados`;
  }
}

// =========================================================================
// CAMBIO DE PERÍODO TEMPORAL
// =========================================================================
window.changePeriodFilter = (period) => {
  currentPeriod = period;
  setupPeriodBadges();
  fetchSettlements();
};

function setupPeriodBadges() {
  const buttons = document.querySelectorAll('.period-filter-btn');
  buttons.forEach(btn => {
    const p = btn.getAttribute('data-period');
    if (p === currentPeriod) {
      btn.className = 'period-filter-btn px-3 py-1.5 rounded-xl bg-brand-accent text-white text-xs font-bold transition-all shadow-md shadow-brand-accent/20';
    } else {
      btn.className = 'period-filter-btn px-3 py-1.5 rounded-xl border border-brand-border bg-brand-dark hover:bg-zinc-800 text-zinc-400 hover:text-white text-xs font-medium transition-all';
    }
  });
}

// =========================================================================
// MODAL DE RENDICIÓN Y LIQUIDACIÓN INDIVIDUAL (CASHOUT)
// =========================================================================
window.openSettlementModal = (cadeteId) => {
  currentSelectedCadete = cadetesSettlement.find(c => c.id === cadeteId);
  if (!currentSelectedCadete) return;

  // Tomamos solo los pedidos que están en 'entregado' pendientes de liquidar a 'rendido'
  const pendingOrders = currentSelectedCadete.orders.filter(o => {
    const st = String(o.estado_pedido || '').toLowerCase().trim();
    return st === 'entregado' || st === 'delivered';
  });

  const facturadoTurno = pendingOrders.reduce((acc, o) => acc + (parseFloat(o.coste_pedido) || 0), 0);
  const gananciaCadete60 = Math.round(facturadoTurno * 0.6); // 60%
  const efectivoRendir40 = Math.round(facturadoTurno * 0.4); // 40%

  currentGeneratedToken = generarTokenLiquidacion(cadeteId);

  const nameEl = document.getElementById("modal-cadete-name");
  const subEl = document.getElementById("modal-cadete-subinfo");
  const tokenBadge = document.getElementById("modal-settlement-token");

  if (nameEl) nameEl.innerText = `${currentSelectedCadete.name}`;
  if (subEl) subEl.innerText = `ID #${currentSelectedCadete.id} • Tel: ${currentSelectedCadete.phone} • ${currentSelectedCadete.vehicle} (${currentSelectedCadete.plate})`;
  if (tokenBadge) tokenBadge.innerText = currentGeneratedToken;

  const cashInHandEl = document.getElementById("modal-cash-in-hand");
  const earningsEl = document.getElementById("modal-cadete-earnings");
  const balanceLabel = document.getElementById("modal-balance-label");
  const balanceAmount = document.getElementById("modal-balance-amount");
  const balanceExp = document.getElementById("modal-balance-explanation");

  if (cashInHandEl) cashInHandEl.innerText = `$${facturadoTurno.toLocaleString('es-AR')}`;
  if (earningsEl) earningsEl.innerText = `+$${gananciaCadete60.toLocaleString('es-AR')}`;

  if (balanceLabel) balanceLabel.innerText = "Efectivo a Rendir a Central (40%):";
  if (balanceAmount) {
    balanceAmount.className = "text-brand-gold font-mono text-xl font-extrabold";
    balanceAmount.innerText = `$${efectivoRendir40.toLocaleString('es-AR')}`;
  }
  if (balanceExp) {
    balanceExp.innerHTML = `
      El repartidor retiene su ganancia acumulada de <strong class="text-emerald-400">+$${gananciaCadete60.toLocaleString('es-AR')} (60%)</strong> y debe entregar <strong class="text-brand-gold">$${efectivoRendir40.toLocaleString('es-AR')} (40%)</strong> a la administración central de Todo Delivery.
    `;
  }

  // Renderizar los pedidos que van a pasar de 'entregado' a 'rendido'
  const ordersContainer = document.getElementById("modal-cadete-orders-list");
  if (ordersContainer) {
    ordersContainer.innerHTML = pendingOrders.map(o => {
      const fecha = new Date(o.fecha_pedido);
      const timeFormatted = isNaN(fecha.getTime()) ? '-' : fecha.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const clienteNombre = o.Clientes ? o.Clientes.nombre_cliente : 'Cliente';
      const detalle = o.tipo_paquete || o.inform_pedido || 'Envío estándar';
      const monto = parseFloat(o.coste_pedido) || 0;
      const comision40 = Math.round(monto * 0.4);
      const ganancia60 = Math.round(monto * 0.6);

      return `
        <tr class="border-b border-brand-border/40 text-xs hover:bg-zinc-800/40">
          <td class="py-2.5 px-3 font-mono font-bold text-white">#${o.id_pedido}</td>
          <td class="py-2.5 px-3 text-zinc-400 font-mono">${timeFormatted}</td>
          <td class="py-2.5 px-3 text-zinc-300 truncate max-w-[130px]">${clienteNombre}</td>
          <td class="py-2.5 px-3 text-zinc-400 truncate max-w-[150px]">${detalle}</td>
          <td class="py-2.5 px-3 text-right font-mono font-bold text-white">$${monto.toLocaleString('es-AR')}</td>
          <td class="py-2.5 px-3 text-right font-mono text-emerald-400 font-semibold">+$${ganancia60.toLocaleString('es-AR')}</td>
          <td class="py-2.5 px-3 text-right font-mono text-brand-gold font-bold">$${comision40.toLocaleString('es-AR')}</td>
        </tr>
      `;
    }).join('');
  }

  // Reset inputs
  const methodSelect = document.getElementById("modal-payment-method");
  if (methodSelect) methodSelect.value = "efectivo";
  const notesInput = document.getElementById("modal-settlement-notes");
  if (notesInput) notesInput.value = "";

  const m = document.getElementById('settlement-modal');
  const c = document.getElementById('modal-container');
  if (m && c) {
    m.classList.remove('hidden');
    setTimeout(() => {
      m.classList.add('opacity-100');
      c.classList.remove('scale-95');
    }, 10);
  }

  if (window.lucide) window.lucide.createIcons();
};

window.closeSettlementModal = () => {
  const m = document.getElementById('settlement-modal');
  const c = document.getElementById('modal-container');
  if (m && c) {
    m.classList.remove('opacity-100');
    c.classList.add('scale-95');
    setTimeout(() => m.classList.add('hidden'), 300);
  }
};

window.confirmSettlement = async () => {
  if (!currentSelectedCadete) return;

  const methodSelect = document.getElementById("modal-payment-method");
  const notesInput = document.getElementById("modal-settlement-notes");
  const method = methodSelect ? methodSelect.value : 'efectivo';
  const notes = notesInput ? notesInput.value : '';

  const pendingOrders = currentSelectedCadete.orders.filter(o => {
    const st = String(o.estado_pedido || '').toLowerCase().trim();
    return st === 'entregado' || st === 'delivered';
  });

  if (pendingOrders.length === 0) {
    mostrarToast("No hay pedidos pendientes de rendir para este cadete", "info");
    window.closeSettlementModal();
    return;
  }

  const facturadoTurno = pendingOrders.reduce((acc, o) => acc + (parseFloat(o.coste_pedido) || 0), 0);
  const cadeteShare60 = Math.round(facturadoTurno * 0.6);
  const companyShare40 = Math.round(facturadoTurno * 0.4);
  const pendingOrderIds = pendingOrders.map(o => o.id_pedido);

  const confirmBtn = document.getElementById("btn-confirm-settlement");
  const originalBtnContent = confirmBtn ? confirmBtn.innerHTML : '';
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin"></i> Liquidando en BD...`;
    if (window.lucide) window.lucide.createIcons();
  }

  // 1. Confirmación en BD: Los pedidos pasan de 'entregado' a 'rendido'
  const { error: errUpdatePedidos } = await supabase
    .from('Pedidos')
    .update({ estado_pedido: 'rendido' })
    .in('id_pedido', pendingOrderIds);

  if (errUpdatePedidos) {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = originalBtnContent;
    }
    alert("Error al actualizar pedidos a 'rendido': " + errUpdatePedidos.message);
    return;
  }

  // 2. El estado del cadete en la tabla Cadetes pasa a 'desconectado'
  await supabase
    .from('Cadetes')
    .update({ estado_cad: 'desconectado' })
    .eq('id_cad', currentSelectedCadete.id);

  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = originalBtnContent;
  }

  // 3. Guardar registro local con el Token
  const token = currentGeneratedToken || generarTokenLiquidacion(currentSelectedCadete.id);
  saveStoredSettlement(currentSelectedCadete.id, {
    token: token,
    cadeteName: currentSelectedCadete.name,
    totalVolume: facturadoTurno,
    cadeteShare: cadeteShare60,
    companyShare: companyShare40,
    method: method,
    notes: notes,
    tripsCount: pendingOrders.length,
    orderIds: pendingOrderIds
  });

  window.closeSettlementModal();
  await fetchSettlements();
  mostrarToast(`¡Caja rendida con éxito! Token: ${token}`, "success");
};

// =========================================================================
// REABRIR RENDICIÓN (DESHACER CIERRE DE PEDIDOS)
// =========================================================================
window.reopenSettlement = async (cadeteId) => {
  const cad = cadetesSettlement.find(c => c.id === cadeteId);
  if (!cad) return;

  if (confirm(`¿Deseas reabrir la rendición de ${cad.name}? Los pedidos volverán a estado 'entregado' y se reactivará el saldo deudor de caja.`)) {
    const rendidoOrderIds = cad.orders
      .filter(o => o.estado_pedido === 'rendido')
      .map(o => o.id_pedido);

    if (rendidoOrderIds.length > 0) {
      const { error } = await supabase
        .from('Pedidos')
        .update({ estado_pedido: 'entregado' })
        .in('id_pedido', rendidoOrderIds);

      if (error) {
        alert("Error al revertir pedidos a 'entregado': " + error.message);
        return;
      }
    }

    removeStoredSettlement(cadeteId);
    await fetchSettlements();
    mostrarToast(`Caja de ${cad.name} reabierta a 'entregado'`, "info");
  }
};

// =========================================================================
// VER CONSTANCIA / COMPROBANTE Y ENVIAR POR WHATSAPP
// =========================================================================
window.verConstanciaCadete = (cadeteId) => {
  const cad = cadetesSettlement.find(c => c.id === cadeteId);
  if (!cad) return;

  const stored = getStoredSettlements()[cadeteId] || {};
  const token = stored.token || generarTokenLiquidacion(cadeteId);
  const facturado = cad.totalVolume;
  const ganancia60 = Math.round(facturado * 0.6);
  const rendido40 = Math.round(facturado * 0.4);

  const phoneSanitized = (cad.phone || '').replace(/\D/g, '');

  const msg = `*TODO DELIVERY - CONSTANCIA DE RENDICIÓN DE CAJA*\n` +
    `--------------------------------------\n` +
    `🔖 *Token:* ${token}\n` +
    `🛵 *Cadete:* ${cad.name}\n` +
    `📦 *Envíos Rendidos:* ${cad.trips}\n` +
    `💵 *Facturación Total (100%):* $${facturado.toLocaleString('es-AR')}\n` +
    `🟢 *Ganancia Repartidor (60%):* +$${ganancia60.toLocaleString('es-AR')}\n` +
    `🏦 *Efectivo Rendido a Central (40%):* $${rendido40.toLocaleString('es-AR')}\n` +
    `✅ *Estado de Caja:* LIQUIDADO A CERO\n` +
    `📅 *Fecha:* ${new Date().toLocaleDateString('es-AR')} ${new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}\n` +
    `--------------------------------------\n` +
    `¡Gracias por tu jornada de trabajo!`;

  if (confirm(`Comprobante de Caja (${token}):\n\n- Facturación: $${facturado}\n- Ganancia Cadete (60%): +$${ganancia60}\n- Efectivo Rendido (40%): $${rendido40}\n\n¿Deseas abrir WhatsApp para enviar la constancia al repartidor?`)) {
    const url = phoneSanitized 
      ? `https://wa.me/${phoneSanitized}?text=${encodeURIComponent(msg)}`
      : `https://wa.me/?text=${encodeURIComponent(msg)}`;
    window.open(url, '_blank');
  }
};

// =========================================================================
// MODAL DE DESGLOSE / AUDITORÍA DE VIAJES POR CADETE
// =========================================================================
window.openBreakdownModal = (cadeteId) => {
  const cad = cadetesSettlement.find(c => c.id === cadeteId);
  if (!cad) return;

  const titleEl = document.getElementById("breakdown-modal-title");
  const subEl = document.getElementById("breakdown-modal-sub");
  if (titleEl) titleEl.innerText = `Viajes de ${cad.name}`;
  if (subEl) subEl.innerText = `${cad.trips} viajes (${cad.pendingTrips} pendientes, ${cad.rendidoTrips} rendidos) • Facturación: $${cad.totalVolume.toLocaleString('es-AR')}`;

  const tbody = document.getElementById("breakdown-modal-tbody");
  if (tbody) {
    tbody.innerHTML = cad.orders.map(o => {
      const fecha = new Date(o.fecha_pedido);
      const dateFormatted = isNaN(fecha.getTime()) ? '-' : fecha.toLocaleDateString([], { day: '2-digit', month: '2-digit' }) + ' ' + fecha.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const clienteNombre = o.Clientes ? o.Clientes.nombre_cliente : 'Cliente';
      const clienteTel = o.Clientes ? o.Clientes.telefono_cliente : '-';
      const detalle = o.tipo_paquete || o.inform_pedido || 'Envío estándar';
      const monto = parseFloat(o.coste_pedido) || 0;
      const isRendido = o.estado_pedido === 'rendido';

      return `
        <tr class="border-b border-brand-border/40 hover:bg-zinc-800/40 text-xs">
          <td class="py-3 px-4 font-mono font-bold text-white">#${o.id_pedido}</td>
          <td class="py-3 px-4 text-zinc-400 font-mono">${dateFormatted}</td>
          <td class="py-3 px-4">
            <span class="block font-semibold text-white">${clienteNombre}</span>
            <span class="text-[11px] text-zinc-500">${clienteTel}</span>
          </td>
          <td class="py-3 px-4 text-zinc-300 max-w-xs truncate">${detalle}</td>
          <td class="py-3 px-4 font-mono font-bold text-white text-right">$${monto.toLocaleString('es-AR')}</td>
          <td class="py-3 px-4 font-mono text-emerald-400 font-semibold text-right">+$${Math.round(monto * 0.6).toLocaleString('es-AR')}</td>
          <td class="py-3 px-4 font-mono text-brand-gold font-bold text-right">$${Math.round(monto * 0.4).toLocaleString('es-AR')}</td>
          <td class="py-3 px-4 text-right">
            <span class="inline-block text-[10px] font-semibold px-2 py-0.5 rounded ${isRendido ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'}">
              ${isRendido ? 'Rendido' : 'Entregado'}
            </span>
          </td>
        </tr>
      `;
    }).join('');
  }

  const m = document.getElementById('breakdown-modal');
  const c = document.getElementById('breakdown-modal-container');
  if (m && c) {
    m.classList.remove('hidden');
    setTimeout(() => {
      m.classList.add('opacity-100');
      c.classList.remove('scale-95');
    }, 10);
  }

  if (window.lucide) window.lucide.createIcons();
};

window.closeBreakdownModal = () => {
  const m = document.getElementById('breakdown-modal');
  const c = document.getElementById('breakdown-modal-container');
  if (m && c) {
    m.classList.remove('opacity-100');
    c.classList.add('scale-95');
    setTimeout(() => m.classList.add('hidden'), 300);
  }
};

// =========================================================================
// MODAL DE CIERRE DE JORNADA
// =========================================================================
window.openClosureModal = () => {
  let totalGross = 0;
  let totalCompany40 = 0;
  let totalCadetes60 = 0;
  let settledCadetesCount = 0;

  cadetesSettlement.forEach(c => {
    totalGross += c.totalVolume;
    totalCompany40 += Math.round(c.totalVolume * 0.4);
    totalCadetes60 += Math.round(c.totalVolume * 0.6);
    if (c.settled) settledCadetesCount++;
  });

  const domDate = document.getElementById("closure-date");
  const domTotalSales = document.getElementById("closure-total-sales");
  const domCompanyProfit = document.getElementById("closure-company-profit");
  const domCadetesProfit = document.getElementById("closure-cadetes-profit");
  const domSettledStatus = document.getElementById("closure-settled-status");

  const todayStr = new Date().toLocaleDateString('es-AR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  if (domDate) domDate.innerText = todayStr;
  if (domTotalSales) domTotalSales.innerText = `$${Math.round(totalGross).toLocaleString('es-AR')}`;
  if (domCompanyProfit) domCompanyProfit.innerText = `$${Math.round(totalCompany40).toLocaleString('es-AR')}`;
  if (domCadetesProfit) domCadetesProfit.innerText = `$${Math.round(totalCadetes60).toLocaleString('es-AR')}`;

  if (domSettledStatus) {
    domSettledStatus.innerHTML = `
      <span class="font-bold ${settledCadetesCount === cadetesSettlement.length ? 'text-emerald-400' : 'text-amber-400'}">
        ${settledCadetesCount} de ${cadetesSettlement.length} cadetes están al día con su caja rendida
      </span>
    `;
  }

  const m = document.getElementById('closure-modal');
  const c = document.getElementById('closure-modal-container');
  if (m && c) {
    m.classList.remove('hidden');
    setTimeout(() => {
      m.classList.add('opacity-100');
      c.classList.remove('scale-95');
    }, 10);
  }

  if (window.lucide) window.lucide.createIcons();
};

window.closeClosureModal = () => {
  const m = document.getElementById('closure-modal');
  const c = document.getElementById('closure-modal-container');
  if (m && c) {
    m.classList.remove('opacity-100');
    c.classList.add('scale-95');
    setTimeout(() => m.classList.add('hidden'), 300);
  }
};

window.confirmJornadaClosure = () => {
  const today = new Date().toISOString().split('T')[0];
  let totalGross = 0;
  let totalCompany = 0;
  let totalCadetes = 0;

  cadetesSettlement.forEach(c => {
    totalGross += c.totalVolume;
    totalCompany += Math.round(c.totalVolume * 0.4);
    totalCadetes += Math.round(c.totalVolume * 0.6);
  });

  const closureData = {
    date: today,
    closedAt: new Date().toISOString(),
    totalGross,
    totalCompany40: totalCompany,
    totalCadetes60: totalCadetes,
    cadetesCount: cadetesSettlement.length,
    ordersCount: rawDeliveredOrders.length
  };

  try {
    const raw = localStorage.getItem(STORAGE_CLOSURES_KEY);
    const closures = raw ? JSON.parse(raw) : [];
    closures.unshift(closureData);
    localStorage.setItem(STORAGE_CLOSURES_KEY, JSON.stringify(closures));
  } catch (e) {
    console.error("Error guardando cierre", e);
  }

  window.closeClosureModal();
  mostrarToast("¡Jornada cerrada con éxito! Balance contable archivado.", "success");
};

// =========================================================================
// EXPORTACIÓN REAL A CSV
// =========================================================================
window.exportReport = () => {
  if (cadetesSettlement.length === 0) {
    mostrarToast("No hay liquidaciones disponibles para exportar", "warning");
    return;
  }

  const todayStr = new Date().toISOString().split('T')[0];
  const csvRows = [];

  // Encabezados
  csvRows.push([
    "ID Cadete",
    "Nombre Cadete",
    "Alias",
    "Teléfono",
    "Vehículo",
    "Patente",
    "Viajes Totales",
    "Viajes Pendientes",
    "Viajes Rendidos",
    "Facturación Total (100% ARS)",
    "Ganancia Cadete (60% ARS)",
    "Comisión Central (40% ARS)",
    "Deuda Pendiente a Rendir (ARS)",
    "Estado Caja"
  ].map(h => `"${h}"`).join(","));

  // Filas por cadete
  cadetesSettlement.forEach(c => {
    const cadeteEarnings = Math.round(c.totalVolume * 0.6);
    const companyEarnings = Math.round(c.totalVolume * 0.4);
    const pendingOwed = Math.round(c.pendingVolume * 0.4);

    csvRows.push([
      c.id,
      `"${c.name.replace(/"/g, '""')}"`,
      `"${c.alias.replace(/"/g, '""')}"`,
      `"${c.phone.replace(/"/g, '""')}"`,
      `"${c.vehicle.replace(/"/g, '""')}"`,
      `"${c.plate.replace(/"/g, '""')}"`,
      c.trips,
      c.pendingTrips,
      c.rendidoTrips,
      c.totalVolume,
      cadeteEarnings,
      companyEarnings,
      pendingOwed,
      `"${c.settled ? 'Rendido' : 'Pendiente'}"`
    ].join(","));
  });

  // Fila de Totales
  const sumGross = cadetesSettlement.reduce((acc, c) => acc + c.totalVolume, 0);
  const sumCadetes = Math.round(sumGross * 0.6);
  const sumCompany = Math.round(sumGross * 0.4);
  const sumPending = cadetesSettlement.reduce((acc, c) => acc + Math.round(c.pendingVolume * 0.4), 0);
  const sumTrips = cadetesSettlement.reduce((acc, c) => acc + c.trips, 0);

  csvRows.push([
    "TOTALES",
    `"-"`,
    `"-"`,
    `"-"`,
    `"-"`,
    `"-"`,
    sumTrips,
    `"-"`,
    `"-"`,
    sumGross,
    sumCadetes,
    sumCompany,
    sumPending,
    `"-"`
  ].join(","));

  // Generar Blob con BOM UTF-8 para compatibilidad perfecta con Excel
  const csvContent = "\uFEFF" + csvRows.join("\r\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `reporte_caja_tododelivery_${todayStr}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  mostrarToast("Reporte descargado en formato CSV exitosamente", "success");
};

// =========================================================================
// UTILIDADES: TOAST Y LOADING
// =========================================================================
function mostrarToast(mensaje, tipo = 'info') {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  const colors = {
    success: 'bg-emerald-500/95 text-white border-emerald-400',
    error: 'bg-brand-accent/95 text-white border-brand-accentHover',
    warning: 'bg-amber-500/95 text-white border-amber-400',
    info: 'bg-zinc-800/95 text-zinc-100 border-brand-border'
  };

  const icons = {
    success: 'check-circle',
    error: 'alert-triangle',
    warning: 'alert-circle',
    info: 'info'
  };

  toast.className = `flex items-center gap-3 px-4 py-3 rounded-2xl border shadow-2xl backdrop-blur-md text-xs font-semibold transform transition-all duration-300 translate-y-2 opacity-0 ${colors[tipo] || colors.info}`;
  toast.innerHTML = `
    <i data-lucide="${icons[tipo] || 'info'}" class="w-4 h-4 shrink-0"></i>
    <span>${mensaje}</span>
  `;

  container.appendChild(toast);
  if (window.lucide) window.lucide.createIcons();

  setTimeout(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  }, 10);

  setTimeout(() => {
    toast.classList.add('translate-y-2', 'opacity-0');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function mostrarLoading(show) {
  const spinner = document.getElementById("caja-loading-indicator");
  if (spinner) {
    if (show) spinner.classList.remove("hidden");
    else spinner.classList.add("hidden");
  }
}

// Iniciar al cargar el DOM
window.addEventListener('DOMContentLoaded', () => {
  initCaja();
});
