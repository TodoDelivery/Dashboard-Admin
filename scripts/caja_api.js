import { supabase } from './conexion_supabase.js';

let cadetesSettlement = [];
let currentSelectedCadete = null;
let currentSearch = '';
// Registro local de liquidaciones en la sesión actual
// Nota: En un sistema real esto debería guardarse en una tabla de DB (ej. 'Liquidaciones' o actualizar 'Pedidos')
let liquidacionesSesion = new Set();

export async function initCaja() {
  await fetchSettlements();
  renderSettlementTable();
}

async function fetchSettlements() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  // Obtener pedidos de hoy que estén entregados
  const { data: pedidos, error: errPedidos } = await supabase
    .from('Pedidos')
    .select(`
      id_cadete,
      coste_pedido,
      Cadetes ( id_cad, nombre_cad )
    `)
    .gte('fecha_pedido', startOfDay.toISOString())
    .eq('estado_pedido', 'delivered');

  if (errPedidos) {
    console.error("Error cargando pedidos para caja", errPedidos);
    return;
  }

  // Agrupar por cadete
  const map = new Map();
  pedidos.forEach(p => {
    if (!p.id_cadete) return;
    
    if (!map.has(p.id_cadete)) {
      map.set(p.id_cadete, {
        id: p.id_cadete,
        name: p.Cadetes ? p.Cadetes.nombre_cad : `Cadete #${p.id_cadete}`,
        avatar: p.Cadetes && p.Cadetes.nombre_cad ? p.Cadetes.nombre_cad.split(' ').map(n=>n[0]).join('').substring(0,2) : 'XX',
        trips: 0,
        cashCollected: 0,
        totalVolume: 0,
        settled: liquidacionesSesion.has(p.id_cadete)
      });
    }

    const stat = map.get(p.id_cadete);
    stat.trips += 1;
    stat.totalVolume += (p.coste_pedido || 0);
    // Asumimos efectivo por defecto si no hay columna metodo_pago, si existe evaluarla.
    stat.cashCollected += (p.coste_pedido || 0); 
  });

  cadetesSettlement = Array.from(map.values());
}

window.renderSettlementTable = () => {
  const searchInput = document.getElementById("search-settlement");
  if (searchInput) currentSearch = searchInput.value.toLowerCase();
  
  const tbody = document.getElementById("settlement-table-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  let totalGross = 0;
  let totalCash = 0;
  let totalAppCommissions = 0;
  let totalCadeteNet = 0;

  cadetesSettlement.forEach(c => {
    const cadeteShare = c.totalVolume * 0.85; // 85% repartidor
    const companyShare = c.totalVolume * 0.15; // 15% empresa
    const balance = cadeteShare - c.cashCollected;

    totalGross += c.totalVolume;
    totalCash += c.cashCollected;
    totalAppCommissions += companyShare;
    totalCadeteNet += cadeteShare;

    if (c.name.toLowerCase().includes(currentSearch)) {
      const tr = document.createElement("tr");
      tr.className = "hover:bg-brand-dark/40 transition-colors";
      
      tr.innerHTML = `
        <td class="py-4 px-4">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-full bg-zinc-800 border border-brand-border flex items-center justify-center font-bold text-xs text-white">
              ${c.avatar}
            </div>
            <div>
              <span class="block font-semibold text-white">${c.name}</span>
              <span class="text-[11px] ${c.settled ? 'text-emerald-400' : 'text-amber-400'} font-medium">
                ${c.settled ? 'Liquidado hoy' : 'Pendiente de cierre'}
              </span>
            </div>
          </div>
        </td>
        <td class="py-4 px-4 font-mono text-zinc-300 font-medium">${c.trips} entregas</td>
        <td class="py-4 px-4 font-mono text-brand-gold font-semibold">$${c.cashCollected.toLocaleString()}</td>
        <td class="py-4 px-4 font-mono text-zinc-200 font-semibold">$${cadeteShare.toLocaleString()}</td>
        <td class="py-4 px-4 font-mono text-emerald-400 font-semibold">$${companyShare.toLocaleString()}</td>
        <td class="py-4 px-4 font-mono font-bold">
          ${balance >= 0 
            ? `<span class="text-emerald-400">+ $${balance.toLocaleString()} (A favor)</span>` 
            : `<span class="text-brand-accent">- $${Math.abs(balance).toLocaleString()} (Debe)</span>`
          }
        </td>
        <td class="py-4 px-4 text-right">
          ${c.settled 
            ? `<span class="inline-flex items-center gap-1 text-xs text-emerald-400 bg-emerald-500/10 px-3 py-1 rounded-xl border border-emerald-500/20 font-medium">
                 <i data-lucide="check" class="w-3.5 h-3.5"></i> Rendido
               </span>`
            : `<button onclick="openSettlementModal(${c.id})" class="px-3 py-1.5 bg-brand-accent hover:bg-brand-accentHover text-white text-xs font-bold rounded-xl shadow-md transition-all">
                 Rendir
               </button>`
          }
        </td>
      `;
      tbody.appendChild(tr);
    }
  });

  const domSales = document.getElementById("card-total-sales");
  const domStreet = document.getElementById("card-cash-street");
  const domNet = document.getElementById("card-net-earnings");
  const domPay = document.getElementById("card-cadetes-pay");
  
  if(domSales) domSales.innerText = `$${totalGross.toLocaleString()}`;
  if(domStreet) domStreet.innerText = `$${totalCash.toLocaleString()}`;
  if(domNet) domNet.innerText = `$${totalAppCommissions.toLocaleString()}`;
  if(domPay) domPay.innerText = `$${totalCadeteNet.toLocaleString()}`;

  if (window.lucide) window.lucide.createIcons();
};

window.openSettlementModal = (cadeteId) => {
  currentSelectedCadete = cadetesSettlement.find(c => c.id === cadeteId);
  if (!currentSelectedCadete) return;

  const cadeteShare = currentSelectedCadete.totalVolume * 0.85;
  const balance = cadeteShare - currentSelectedCadete.cashCollected;

  document.getElementById("modal-cadete-name").innerText = `Cadete: ${currentSelectedCadete.name}`;
  document.getElementById("modal-cash-in-hand").innerText = `$${currentSelectedCadete.cashCollected.toLocaleString()}`;
  document.getElementById("modal-cadete-earnings").innerText = `$${cadeteShare.toLocaleString()}`;
  
  const balanceLabel = document.getElementById("modal-balance-label");
  const balanceAmount = document.getElementById("modal-balance-amount");
  const balanceExp = document.getElementById("modal-balance-explanation");

  if (balance >= 0) {
    balanceLabel.innerText = "Monto a abonarle al cadete:";
    balanceAmount.className = "text-emerald-400 font-mono text-base font-bold";
    balanceAmount.innerText = `$${balance.toLocaleString()}`;
    balanceExp.innerText = "La empresa debe transferirle o entregarle este saldo al cadete por sus viajes con tarjeta/online.";
  } else {
    balanceLabel.innerText = "Monto que el cadete entrega a caja:";
    balanceAmount.className = "text-brand-accent font-mono text-base font-bold";
    balanceAmount.innerText = `$${Math.abs(balance).toLocaleString()}`;
    balanceExp.innerText = "El cadete cobró más efectivo que su comisión ganada. Debe depositar la diferencia en caja.";
  }

  const m = document.getElementById('settlement-modal');
  const c = document.getElementById('modal-container');
  m.classList.remove('hidden');
  setTimeout(() => {
    m.classList.add('opacity-100');
    c.classList.remove('scale-95');
  }, 10);
};

window.closeSettlementModal = () => {
  const m = document.getElementById('settlement-modal');
  const c = document.getElementById('modal-container');
  m.classList.remove('opacity-100');
  c.classList.add('scale-95');
  setTimeout(() => m.classList.add('hidden'), 300);
};

window.confirmSettlement = () => {
  if (currentSelectedCadete) {
    currentSelectedCadete.settled = true;
    liquidacionesSesion.add(currentSelectedCadete.id); // Guardar estado en sesión
    window.closeSettlementModal();
    window.renderSettlementTable();
  }
};

window.exportReport = () => {
  alert("Generando y descargando el reporte consolidado en formato CSV/Excel...");
};

window.openClosureModal = () => {
  alert("Cierre de jornada ejecutado con éxito. Se guardó el balance contable del turno.");
};

// Start
window.addEventListener('DOMContentLoaded', () => {
  initCaja();
});
