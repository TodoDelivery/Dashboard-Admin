import { supabase } from './conexion_supabase.js';

// =========================================================================
// ESTADO GLOBAL DE CAJA Y RENDICIONES (CASHOUT)
// =========================================================================
// Regla de Negocio Todo Delivery:
// Facturación Total (100%) = Σ(coste_pedido)
// Comisión de la central = Pedidos.porc_comision (congelada al aceptar el cadete);
// si el pedido todavía no la tiene, Datos_cotiz.Porc_Comision vigente (se edita en Ajustes)
// Efectivo a Rendir a Central = Σ Math.round(coste_pedido * comisión del pedido / 100)
// Ganancia Neta Cadete = Σ (coste_pedido - parte de la central)
// Ciclo: 'entregado' (en caja pendiente) -> 'rendido' (caja liquidada a cero)
// =========================================================================

let cadetesSettlement = [];
let rawDeliveredOrders = [];
let currentSelectedCadete = null;
// Rango de fechas elegido en el calendario ('YYYY-MM-DD' en hora local; '' = sin límite de ese lado)
let fechaDesde = '';
let fechaHasta = '';
let currentSearch = '';
let currentStatusFilter = 'all'; // 'all' | 'pending' | 'settled'
let realtimeChannel = null;
let canalComision = null;

// % de cada pedido que el cadete rinde a la central. Lo edita el admin en Ajustes (Datos_cotiz.Porc_Comision)
let COMISION = 40;

// =========================================================================
// INICIALIZACIÓN
// =========================================================================
export async function initCaja() {
  await cargarComision();
  await fetchSettlements();
  iniciarSuscripcionRealtime();
}

// =========================================================================
// COMISIÓN DE LA CENTRAL
// =========================================================================
const textoPct = (n) => `${Number(n.toFixed(2)).toLocaleString('es-AR')}%`;
const pctEmpresa = () => textoPct(COMISION);
const pctCadete = () => textoPct(100 - COMISION);

const montoDe = (p) => parseFloat(p.coste_pedido) || 0;
const pctDe = (p) => {
  const n = Number(p.porc_comision);
  return p.porc_comision != null && Number.isFinite(n) ? n : COMISION;
};
const empresaDe = (p) => Math.round(montoDe(p) * pctDe(p) / 100);
const cadeteDe = (p) => Math.round(montoDe(p) - empresaDe(p));
const sumar = (pedidos, fn) => pedidos.reduce((acc, p) => acc + fn(p), 0);

// "60%" si todos los pedidos tienen la misma comisión; "varios %" si se mezclan
function pctDePedidos(pedidos, deCadete = false) {
  const pcts = [...new Set(pedidos.map(pctDe))];
  if (pcts.length > 1) return 'varios %';
  const pct = pcts.length ? pcts[0] : COMISION;
  return textoPct(deCadete ? 100 - pct : pct);
}
const esPendiente = (p) => {
  const st = String(p.estado_pedido || '').toLowerCase().trim();
  return st === 'entregado' || st === 'delivered';
};

async function cargarComision() {
  try {
    const { data, error } = await supabase
      .from('Datos_cotiz')
      .select('Porc_Comision')
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const valor = Number(data?.Porc_Comision);
    if (Number.isFinite(valor) && valor >= 0 && valor <= 100) COMISION = valor;
  } catch (err) {
    console.warn('No se pudo leer Porc_Comision, se usa', COMISION + '%:', err);
  }
  pintarPorcentajes();
}

// Textos fijos del HTML: [data-comision-empresa] y [data-comision-cadete]
function pintarPorcentajes() {
  document.querySelectorAll('[data-comision-empresa]').forEach(el => { el.textContent = pctEmpresa(); });
  document.querySelectorAll('[data-comision-cadete]').forEach(el => { el.textContent = pctCadete(); });
}

const pesos = (n) => `$${Math.round(Number(n) || 0).toLocaleString('es-AR')}`;
const fechaHora = (iso) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '-' : `${d.toLocaleDateString('es-AR')} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};
const ETIQUETA_METODO = { efectivo: 'Efectivo', transferencia: 'Transferencia', descuento: 'Ajuste de saldo' };

// Rendiciones guardadas en la BD (tabla Rendiciones), la más nueva primero
const rendicionesDe = (cadeteId) => cadetesSettlement.find(c => c.id === cadeteId)?.rendiciones || [];
const ultimaConfirmada = (cadeteId) => rendicionesDe(cadeteId).find(r => r.estado === 'confirmada');
const buscarRendicion = (idRendicion) => cadetesSettlement.flatMap(c => c.rendiciones).find(r => r.id_rendicion === idRendicion);

// =========================================================================
// OBTENCIÓN Y AGRUPACIÓN DE DATOS DE SUPABASE
// =========================================================================
async function fetchSettlements() {
  mostrarLoading(true);

  // Rango de fechas del calendario: días completos en hora local (el Date local ya sale en UTC con toISOString)
  const startDate = fechaDesde ? new Date(`${fechaDesde}T00:00:00`) : null;
  const endDate = fechaHasta ? new Date(`${fechaHasta}T23:59:59.999`) : null;

  // 1. Consultar pedidos con joins a Cadetes y Clientes
  let query = supabase
    .from('Pedidos')
    .select(`
      id_pedido,
      id_cadete,
      id_cliente,
      coste_pedido,
      porc_comision,
      id_rendicion,
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

  // 3. Agrupar por cadete
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
        totalEmpresa: 0,
        totalCadete: 0,
        // Pedidos pendientes de rendición ('entregado' o 'delivered')
        pendingTrips: 0,
        pendingVolume: 0,
        pendingEmpresa: 0,
        // Pedidos ya rendidos ('rendido')
        rendidoTrips: 0,
        rendidoVolume: 0,
        rendidoEmpresa: 0,
        orders: [],
        settled: false,
        rendiciones: []
      });
    }

    const stat = map.get(cadeteId);
    const monto = montoDe(p);
    const empresa = empresaDe(p);
    stat.trips += 1;
    stat.totalVolume += monto;
    stat.totalEmpresa += empresa;
    stat.totalCadete += cadeteDe(p);
    stat.orders.push(p);

    const st = String(p.estado_pedido || '').toLowerCase().trim();
    if (st === 'rendido') {
      stat.rendidoTrips += 1;
      stat.rendidoVolume += monto;
      stat.rendidoEmpresa += empresa;
    } else {
      stat.pendingTrips += 1;
      stat.pendingVolume += monto;
      stat.pendingEmpresa += empresa;
    }
  });

  // Determinar si está 100% rendido en este período
  map.forEach(stat => {
    stat.settled = (stat.pendingTrips === 0 && stat.trips > 0);
  });

  // 4. Rendiciones de esos cadetes (todas las fechas: son el historial de caja)
  if (map.size > 0) {
    const { data: rendiciones, error: errRend } = await supabase
      .from('Rendiciones')
      .select('*')
      .in('id_cadete', [...map.keys()])
      .order('fecha', { ascending: false });
    if (errRend) {
      console.error('Error cargando rendiciones:', errRend);
      mostrarToast('No se pudieron cargar las rendiciones guardadas', 'error');
    }
    (rendiciones || []).forEach(r => map.get(r.id_cadete)?.rendiciones.push(r));
  }

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

  // Varios cambios seguidos (una rendición toca muchos pedidos) se juntan en una sola recarga
  let recarga = null;
  realtimeChannel = supabase
    .channel('caja-realtime-pedidos')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'Pedidos' }, () => {
      clearTimeout(recarga);
      recarga = setTimeout(fetchSettlements, 400);
    })
    .subscribe();

  // Si el admin cambia la comisión en Ajustes, la caja se recalcula sin recargar
  if (canalComision) {
    supabase.removeChannel(canalComision);
  }
  canalComision = supabase
    .channel('caja-realtime-comision')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'Datos_cotiz' }, async () => {
      await cargarComision();
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

  // Métricas del rango elegido
  const totales = { facturado: 0, pendiente: 0, rendido: 0, cadetes: 0, envios: 0, cadetesConDeuda: 0 };

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

  // Métricas globales con la comisión de cada pedido
  cadetesSettlement.forEach(c => {
    totales.facturado += c.totalVolume;
    totales.pendiente += c.pendingEmpresa;
    totales.rendido += c.rendidoEmpresa;
    totales.cadetes += c.totalCadete;
    totales.envios += c.trips;
    if (c.pendingTrips > 0) totales.cadetesConDeuda += 1;
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
            <p class="text-xs text-zinc-500 max-w-sm">Prueba ampliando el rango de fechas o cambiando el filtro de estado.</p>
            <button onclick="setDateShortcut('all')" class="mt-2 text-xs font-bold text-brand-accent hover:underline flex items-center gap-1">
              <i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i> Ver todas las fechas
            </button>
          </div>
        </td>
      </tr>
    `;
    actualizarCards(totales);
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  filtered.forEach(c => {
    const cadeteEarnings = c.totalCadete;
    const companyEarnings = c.totalEmpresa;
    const pendingOwed = c.pendingEmpresa;
    const pctPendiente = pctDePedidos(c.orders.filter(o => o.estado_pedido !== 'rendido'));

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
          <button onclick="openBreakdownModal(${c.id})" class="text-zinc-500 hover:text-brand-accent transition-colors p-2 -m-1 rounded hover:bg-zinc-800" title="Ver desglose de pedidos">
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
               <i data-lucide="arrow-down-right" class="w-4 h-4 text-amber-400"></i> $${pendingOwed.toLocaleString('es-AR')} (Rendir ${pctPendiente})
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

  actualizarCards(totales);
  if (window.lucide) window.lucide.createIcons();
};

function actualizarCards(t) {
  const pesos = (n) => `$${Math.round(n).toLocaleString('es-AR')}`;
  const poner = (id, texto) => { const el = document.getElementById(id); if (el) el.innerText = texto; };

  poner("card-total-sales", pesos(t.facturado));
  poner("card-cash-street", pesos(t.pendiente));
  poner("card-net-earnings", pesos(t.rendido));
  poner("card-cadetes-pay", pesos(t.cadetes));
  poner("card-total-sales-detalle", `Total cobrado a clientes en ${t.envios} ${t.envios === 1 ? 'envío entregado' : 'envíos entregados'}`);

  poner("badge-period-info", `${textoRangoFechas()} • ${t.envios} envíos`);
}

// =========================================================================
// FILTRO POR FECHAS (CALENDARIO)
// =========================================================================
const fechaLocalISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fechaLegible = (iso) => iso.split('-').reverse().join('/');

function textoRangoFechas() {
  if (fechaDesde && fechaHasta) return fechaDesde === fechaHasta ? fechaLegible(fechaDesde) : `${fechaLegible(fechaDesde)} al ${fechaLegible(fechaHasta)}`;
  if (fechaDesde) return `Desde el ${fechaLegible(fechaDesde)}`;
  if (fechaHasta) return `Hasta el ${fechaLegible(fechaHasta)}`;
  return 'Todas las fechas';
}

function aplicarRangoFechas(desde, hasta) {
  // Si quedaron al revés se ordenan en vez de mostrar un rango vacío
  if (desde && hasta && desde > hasta) [desde, hasta] = [hasta, desde];
  fechaDesde = desde;
  fechaHasta = hasta;
  const inputDesde = document.getElementById('filtro-fecha-desde');
  const inputHasta = document.getElementById('filtro-fecha-hasta');
  if (inputDesde) inputDesde.value = desde;
  if (inputHasta) inputHasta.value = hasta;
  fetchSettlements();
}

window.changeDateRange = () => {
  aplicarRangoFechas(
    document.getElementById('filtro-fecha-desde')?.value || '',
    document.getElementById('filtro-fecha-hasta')?.value || ''
  );
};

window.setDateShortcut = (atajo) => {
  const hoy = new Date();
  if (atajo === 'today') aplicarRangoFechas(fechaLocalISO(hoy), fechaLocalISO(hoy));
  else if (atajo === 'month') aplicarRangoFechas(fechaLocalISO(new Date(hoy.getFullYear(), hoy.getMonth(), 1)), fechaLocalISO(hoy));
  else aplicarRangoFechas('', '');
};

// =========================================================================
// MODAL DE RENDICIÓN Y LIQUIDACIÓN INDIVIDUAL (CASHOUT)
// =========================================================================
window.openSettlementModal = (cadeteId) => {
  currentSelectedCadete = cadetesSettlement.find(c => c.id === cadeteId);
  if (!currentSelectedCadete) return;

  // Tomamos solo los pedidos que están en 'entregado' pendientes de liquidar a 'rendido'
  const pendingOrders = currentSelectedCadete.orders.filter(esPendiente);

  const facturadoTurno = sumar(pendingOrders, montoDe);
  const gananciaCadete60 = sumar(pendingOrders, cadeteDe);
  const efectivoRendir40 = sumar(pendingOrders, empresaDe);
  const pctEmpresaTurno = pctDePedidos(pendingOrders);
  const pctCadeteTurno = pctDePedidos(pendingOrders, true);

  const nameEl = document.getElementById("modal-cadete-name");
  const subEl = document.getElementById("modal-cadete-subinfo");
  const tokenBadge = document.getElementById("modal-settlement-token");

  if (nameEl) nameEl.innerText = `${currentSelectedCadete.name}`;
  if (subEl) subEl.innerText = `ID #${currentSelectedCadete.id} • Tel: ${currentSelectedCadete.phone} • ${currentSelectedCadete.vehicle} (${currentSelectedCadete.plate})`;
  if (tokenBadge) tokenBadge.innerText = 'Se genera al confirmar';

  const cashInHandEl = document.getElementById("modal-cash-in-hand");
  const earningsEl = document.getElementById("modal-cadete-earnings");
  const balanceLabel = document.getElementById("modal-balance-label");
  const balanceAmount = document.getElementById("modal-balance-amount");
  const balanceExp = document.getElementById("modal-balance-explanation");

  if (cashInHandEl) cashInHandEl.innerText = `$${facturadoTurno.toLocaleString('es-AR')}`;
  if (earningsEl) earningsEl.innerText = `+$${gananciaCadete60.toLocaleString('es-AR')}`;

  if (balanceLabel) balanceLabel.innerText = `Efectivo a Rendir a Central (${pctEmpresaTurno}):`;
  if (balanceAmount) {
    balanceAmount.className = "text-brand-gold font-mono text-xl font-extrabold";
    balanceAmount.innerText = `$${efectivoRendir40.toLocaleString('es-AR')}`;
  }
  if (balanceExp) {
    balanceExp.innerHTML = `
      El repartidor retiene su ganancia acumulada de <strong class="text-emerald-400">+$${gananciaCadete60.toLocaleString('es-AR')} (${pctCadeteTurno})</strong> y debe entregar <strong class="text-brand-gold">$${efectivoRendir40.toLocaleString('es-AR')} (${pctEmpresaTurno})</strong> a la administración central de Todo Delivery.
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
      const monto = montoDe(o);
      const comision40 = empresaDe(o);
      const ganancia60 = cadeteDe(o);

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
    document.body.classList.add('overflow-hidden');
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
    document.body.classList.remove('overflow-hidden');
    setTimeout(() => m.classList.add('hidden'), 300);
  }
};

window.confirmSettlement = async () => {
  if (!currentSelectedCadete) return;

  const methodSelect = document.getElementById("modal-payment-method");
  const notesInput = document.getElementById("modal-settlement-notes");
  const method = methodSelect ? methodSelect.value : 'efectivo';
  const notes = notesInput ? notesInput.value : '';

  const pendingOrders = currentSelectedCadete.orders.filter(esPendiente);

  if (pendingOrders.length === 0) {
    mostrarToast("No hay pedidos pendientes de rendir para este cadete", "info");
    window.closeSettlementModal();
    return;
  }

  const confirmBtn = document.getElementById("btn-confirm-settlement");
  const originalBtnContent = confirmBtn ? confirmBtn.innerHTML : '';
  const restaurarBoton = () => {
    if (!confirmBtn) return;
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = originalBtnContent;
  };
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin"></i> Liquidando en BD...`;
    if (window.lucide) window.lucide.createIcons();
  }

  // La BD calcula los montos con el % de cada pedido, guarda la rendición y marca los pedidos en un solo paso.
  // Si algún pedido cambió desde que se abrió el modal, rechaza todo y no rinde a medias.
  const { data: rendicion, error } = await supabase.rpc('rendir_caja', {
    p_id_cadete: currentSelectedCadete.id,
    p_ids_pedidos: pendingOrders.map(o => o.id_pedido),
    p_metodo_pago: method,
    p_notas: notes
  });

  if (error) {
    restaurarBoton();
    alert(`No se pudo rendir la caja: ${error.message}`);
    window.closeSettlementModal();
    await fetchSettlements();
    return;
  }

  await supabase
    .from('Cadetes')
    .update({ estado_cad: 'desconectado' })
    .eq('id_cad', currentSelectedCadete.id);

  restaurarBoton();
  window.closeSettlementModal();
  await fetchSettlements();
  mostrarToast(`¡Caja rendida con éxito! Token: ${rendicion.token}`, "success");
};

// =========================================================================
// REABRIR = ANULAR UNA RENDICIÓN PUNTUAL (sus pedidos vuelven a 'entregado')
// =========================================================================
window.anularRendicion = async (idRendicion) => {
  const rend = buscarRendicion(idRendicion);
  if (!rend || rend.estado !== 'confirmada') return;

  const aviso = `¿Reabrir la rendición ${rend.token}?\n\n` +
    `Queda anulada (no se borra) y sus ${rend.cant_pedidos} pedidos vuelven a pendientes de rendir ` +
    `(${pesos(rend.monto_empresa)} a rendir otra vez).`;
  if (!confirm(aviso)) return;

  const { error } = await supabase.rpc('anular_rendicion', { p_id_rendicion: idRendicion });
  if (error) {
    alert(`No se pudo reabrir la rendición: ${error.message}`);
    return;
  }
  window.closeBreakdownModal();
  await fetchSettlements();
  mostrarToast(`Rendición ${rend.token} anulada; sus pedidos volvieron a pendientes`, "info");
};

window.reopenSettlement = (cadeteId) => {
  const rend = ultimaConfirmada(cadeteId);
  if (!rend) {
    mostrarToast("Este cadete no tiene rendiciones confirmadas para reabrir", "warning");
    return;
  }
  window.anularRendicion(rend.id_rendicion);
};

// =========================================================================
// VER CONSTANCIA / COMPROBANTE Y ENVIAR POR WHATSAPP (sale de la rendición guardada)
// =========================================================================
window.verConstancia = async (idRendicion) => {
  const rend = buscarRendicion(idRendicion);
  if (!rend) return;
  const cad = cadetesSettlement.find(c => c.id === rend.id_cadete) || { name: `Cadete #${rend.id_cadete}`, phone: '' };

  // % de los pedidos de esa rendición; si fue anulada (ya no tiene pedidos) se muestra el % efectivo
  const { data: pedidosRend } = await supabase.from('Pedidos').select('porc_comision').eq('id_rendicion', idRendicion);
  const pctEfectivo = rend.total_facturado > 0 ? rend.monto_empresa / rend.total_facturado * 100 : COMISION;
  const conPct = (pedidosRend || []).length ? pedidosRend : [{ porc_comision: pctEfectivo }];
  const pctEmp = pctDePedidos(conPct);
  const pctCad = pctDePedidos(conPct, true);
  const anulada = rend.estado === 'anulada';

  const msg = `*TODO DELIVERY - CONSTANCIA DE RENDICIÓN DE CAJA*\n` +
    `--------------------------------------\n` +
    `🔖 *Token:* ${rend.token}\n` +
    `🛵 *Cadete:* ${cad.name}\n` +
    `📦 *Envíos Rendidos:* ${rend.cant_pedidos}\n` +
    `💵 *Facturación Total (100%):* ${pesos(rend.total_facturado)}\n` +
    `🟢 *Ganancia Repartidor (${pctCad}):* +${pesos(rend.monto_cadete)}\n` +
    `🏦 *Efectivo Rendido a Central (${pctEmp}):* ${pesos(rend.monto_empresa)}\n` +
    `💳 *Método:* ${ETIQUETA_METODO[rend.metodo_pago] || rend.metodo_pago}\n` +
    (rend.notas ? `📝 *Nota:* ${rend.notas}\n` : '') +
    `✅ *Estado:* ${anulada ? `ANULADA el ${fechaHora(rend.fecha_anulacion)}` : 'LIQUIDADO A CERO'}\n` +
    `📅 *Fecha:* ${fechaHora(rend.fecha)}\n` +
    `--------------------------------------\n` +
    `¡Gracias por tu jornada de trabajo!`;

  const resumen = `Constancia ${rend.token}${anulada ? ' (ANULADA)' : ''}:\n\n` +
    `- Fecha: ${fechaHora(rend.fecha)}\n- Envíos: ${rend.cant_pedidos}\n- Facturación: ${pesos(rend.total_facturado)}\n` +
    `- Ganancia Cadete (${pctCad}): +${pesos(rend.monto_cadete)}\n- Efectivo Rendido (${pctEmp}): ${pesos(rend.monto_empresa)}\n\n` +
    `¿Deseas abrir WhatsApp para enviar la constancia al repartidor?`;
  if (confirm(resumen)) {
    const phoneSanitized = (cad.phone || '').replace(/\D/g, '');
    const url = phoneSanitized
      ? `https://wa.me/${phoneSanitized}?text=${encodeURIComponent(msg)}`
      : `https://wa.me/?text=${encodeURIComponent(msg)}`;
    window.open(url, '_blank');
  }
};

window.verConstanciaCadete = (cadeteId) => {
  const rend = ultimaConfirmada(cadeteId);
  if (!rend) {
    mostrarToast("Este cadete no tiene rendiciones guardadas", "warning");
    return;
  }
  window.verConstancia(rend.id_rendicion);
};

function renderRendiciones(cad) {
  const lista = document.getElementById("breakdown-rendiciones-list");
  if (!lista) return;
  if (cad.rendiciones.length === 0) {
    lista.innerHTML = `<p class="py-4 px-4 text-xs text-zinc-500">Todavía no tiene rendiciones guardadas.</p>`;
    return;
  }
  lista.innerHTML = cad.rendiciones.map(r => {
    const anulada = r.estado === 'anulada';
    return `
      <div class="flex items-center justify-between gap-3 py-2.5 px-4 text-xs ${anulada ? 'opacity-60' : ''}">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-mono font-bold text-brand-gold">${r.token}</span>
            <span class="text-[10px] font-semibold px-2 py-0.5 rounded ${anulada ? 'bg-zinc-800 text-zinc-400 border border-zinc-700' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'}">${anulada ? 'Anulada' : 'Confirmada'}</span>
          </div>
          <span class="text-zinc-400">${fechaHora(r.fecha)} • ${r.cant_pedidos} envíos • Rendido ${pesos(r.monto_empresa)} • ${ETIQUETA_METODO[r.metodo_pago] || r.metodo_pago}</span>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button onclick="verConstancia(${r.id_rendicion})" class="text-zinc-400 hover:text-emerald-400 p-2 rounded-lg hover:bg-zinc-800" title="Ver constancia">
            <i data-lucide="file-text" class="w-3.5 h-3.5"></i>
          </button>
          ${anulada ? '' : `<button onclick="anularRendicion(${r.id_rendicion})" class="text-zinc-400 hover:text-amber-400 p-2 rounded-lg hover:bg-zinc-800" title="Reabrir (anular esta rendición)">
            <i data-lucide="rotate-ccw" class="w-3.5 h-3.5"></i>
          </button>`}
        </div>
      </div>
    `;
  }).join('');
}

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
      const monto = montoDe(o);
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
          <td class="py-3 px-4 font-mono text-emerald-400 font-semibold text-right">+$${cadeteDe(o).toLocaleString('es-AR')}</td>
          <td class="py-3 px-4 font-mono text-brand-gold font-bold text-right">$${empresaDe(o).toLocaleString('es-AR')}</td>
          <td class="py-3 px-4 text-right">
            <span class="inline-block text-[10px] font-semibold px-2 py-0.5 rounded ${isRendido ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'}">
              ${isRendido ? 'Rendido' : 'Entregado'}
            </span>
          </td>
        </tr>
      `;
    }).join('');
  }

  renderRendiciones(cad);

  const m = document.getElementById('breakdown-modal');
  const c = document.getElementById('breakdown-modal-container');
  if (m && c) {
    m.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
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
    document.body.classList.remove('overflow-hidden');
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
    totalCompany40 += c.totalEmpresa;
    totalCadetes60 += c.totalCadete;
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
    document.body.classList.add('overflow-hidden');
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
    document.body.classList.remove('overflow-hidden');
    setTimeout(() => m.classList.add('hidden'), 300);
  }
};

window.confirmJornadaClosure = async () => {
  const cierre = {
    fecha: fechaLocalISO(new Date()),
    desde: fechaDesde || null,
    hasta: fechaHasta || null,
    total_facturado: cadetesSettlement.reduce((acc, c) => acc + c.totalVolume, 0),
    total_empresa: cadetesSettlement.reduce((acc, c) => acc + c.totalEmpresa, 0),
    total_cadetes: cadetesSettlement.reduce((acc, c) => acc + c.totalCadete, 0),
    cant_cadetes: cadetesSettlement.length,
    cant_pedidos: rawDeliveredOrders.length,
    cadetes_al_dia: cadetesSettlement.filter(c => c.settled).length
  };

  const { error } = await supabase.from('Cierres_jornada').insert(cierre);
  if (error) {
    alert(`No se pudo guardar el cierre de jornada: ${error.message}`);
    return;
  }

  window.closeClosureModal();
  mostrarToast("¡Jornada cerrada con éxito! Balance guardado en la base.", "success");
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
    `Ganancia Cadete (${pctDePedidos(rawDeliveredOrders, true)} ARS)`,
    `Comisión Central (${pctDePedidos(rawDeliveredOrders)} ARS)`,
    "Deuda Pendiente a Rendir (ARS)",
    "Estado Caja"
  ].map(h => `"${h}"`).join(","));

  // Filas por cadete
  cadetesSettlement.forEach(c => {
    const cadeteEarnings = c.totalCadete;
    const companyEarnings = c.totalEmpresa;
    const pendingOwed = c.pendingEmpresa;

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
  const sumCadetes = cadetesSettlement.reduce((acc, c) => acc + c.totalCadete, 0);
  const sumCompany = cadetesSettlement.reduce((acc, c) => acc + c.totalEmpresa, 0);
  const sumPending = cadetesSettlement.reduce((acc, c) => acc + c.pendingEmpresa, 0);
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
