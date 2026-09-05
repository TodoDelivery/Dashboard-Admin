import { supabase } from './conexion_supabase.js';

let currentTab = 'cadetes'; // 'cadetes' | 'clientes'
let cadetes = [];
let clientes = [];
let currentSearch = '';

let editingCadeteId = null;
let editingClienteId = null;

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}


export async function initPersonal() {
  await Promise.all([fetchCadetes(), fetchClientes()]);
  renderTable();
  iniciarSuscripciones();
}

async function fetchCadetes() {
  const { data, error } = await supabase
    .from('Cadetes')
    .select('*')
    .order('f_creac', { ascending: false });

  if (!error && data) {
    cadetes = data.map(c => {
      let vehicle = 'Moto';
      let plate = null;
      if (c.patente && c.patente.trim() && c.patente !== '-') {
        plate = c.patente.trim().toUpperCase();
      } else if (c.vehiculo_cad && c.vehiculo_cad.includes(' - ')) {
        const parts = c.vehiculo_cad.split(' - ');
        vehicle = parts[0] || 'Moto';
        plate = parts[1] && parts[1].trim() ? parts[1].trim().toUpperCase() : null;
      } else if (c.vehiculo_cad) {
        vehicle = c.vehiculo_cad;
      }

      return {
        id: c.id_cad,
        name: c.nombre_cad || 'Sin Nombre',
        phone: c.telef_cad || '-',
        alias: c.alias_cad || '-',
        vehicle: vehicle,
        plate: plate,
        status: c.estado_cad || 'offline',
        created_at: c.f_creac,
        raw: c
      };
    });
  } else if (error) {
    console.error("Error al cargar cadetes:", error);
  }
}

async function fetchClientes() {
  const { data, error } = await supabase
    .from('Clientes')
    .select('*')
    .order('f_loggueo_cliente', { ascending: false, nullsFirst: false });

  if (!error && data) {
    clientes = data.map(cl => ({
      id: cl.id_cliente,
      name: cl.nombre_cliente || 'Cliente sin nombre',
      phone: cl.telefono_cliente || '-',
      last_login: cl.f_loggueo_cliente,
      raw: cl
    }));
  } else if (error) {
    console.error("Error al cargar clientes:", error);
  }
}

function iniciarSuscripciones() {
  supabase.channel('gestion-cadetes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'Cadetes' }, () => {
      fetchCadetes().then(() => filterData());
    })
    .subscribe();

  supabase.channel('gestion-clientes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'Clientes' }, () => {
      fetchClientes().then(() => filterData());
    })
    .subscribe();
}

window.switchTab = (tab) => {
  currentTab = tab;

  // UI Tabs Styling
  const btnCadetes = document.getElementById('tab-btn-cadetes');
  const btnClientes = document.getElementById('tab-btn-clientes');
  const headerTitle = document.getElementById('header-title');
  const headerSub = document.getElementById('header-subtitle');
  const btnActionText = document.getElementById('btn-action-text');
  const searchInput = document.getElementById('search-input');

  if (tab === 'cadetes') {
    if (btnCadetes) btnCadetes.className = "flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-xs bg-brand-accent text-white shadow-lg shadow-brand-accent/20 transition-all";
    if (btnClientes) btnClientes.className = "flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-xs bg-brand-dark text-zinc-400 border border-brand-border hover:text-white transition-all";
    if (headerTitle) headerTitle.innerText = "Flota de Cadetes";
    if (headerSub) headerSub.innerText = "Control de credenciales, accesos a la PWA y permisos de reparto";
    if (btnActionText) btnActionText.innerText = "Registrar un cadete";
    if (searchInput) searchInput.placeholder = "Buscar cadete por nombre, teléfono/DNI o alias...";
  } else {
    if (btnClientes) btnClientes.className = "flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-xs bg-brand-accent text-white shadow-lg shadow-brand-accent/20 transition-all";
    if (btnCadetes) btnCadetes.className = "flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-xs bg-brand-dark text-zinc-400 border border-brand-border hover:text-white transition-all";
    if (headerTitle) headerTitle.innerText = "Base de Clientes";
    if (headerSub) headerSub.innerText = "Gestión de clientes registrados en la plataforma";
    if (btnActionText) btnActionText.innerText = "Registrar un cliente";
    if (searchInput) searchInput.placeholder = "Buscar cliente por nombre, teléfono o ID...";
  }

  filterData();
};

window.filterData = () => {
  const searchInput = document.getElementById("search-input");
  if (searchInput) currentSearch = searchInput.value.toLowerCase().trim();
  renderTable();
};

window.renderTable = () => {
  const thead = document.getElementById("table-header");
  const tbody = document.getElementById("personal-table-body");
  if (!tbody || !thead) return;

  tbody.innerHTML = "";

  if (currentTab === 'cadetes') {
    // Header for Cadetes
    thead.innerHTML = `
      <tr class="border-b border-brand-border bg-brand-dark/50 text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
        <th class="py-3.5 px-4">Cadete (Nombre & Registro)</th>
        <th class="py-3.5 px-4">Alias / ID</th>
        <th class="py-3.5 px-4">Teléfono</th>
        <th class="py-3.5 px-4">Vehículo & Patente</th>
        <th class="py-3.5 px-4">Estado</th>
        <th class="py-3.5 px-4 text-right">Acciones</th>
      </tr>
    `;

    const filtered = cadetes.filter(c => {
      return c.name.toLowerCase().includes(currentSearch) ||
        c.phone.toLowerCase().includes(currentSearch) ||
        c.alias.toLowerCase().includes(currentSearch);
    });

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="py-12 text-center text-zinc-500">
            <i data-lucide="users" class="w-8 h-8 mx-auto mb-2 opacity-40"></i>
            <p class="text-xs">No se encontraron cadetes registrados</p>
          </td>
        </tr>
      `;
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    filtered.forEach(c => {
      const tr = document.createElement("tr");
      tr.className = "hover:bg-brand-dark/40 transition-colors";

      const initials = c.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
      const dateStr = c.created_at ? new Date(c.created_at).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '-';

      let statusColor = "bg-zinc-800 text-zinc-400 border-zinc-700";
      let statusLabel = "Offline";
      if (c.status === 'libre' || c.status === 'online') {
        statusColor = "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
        statusLabel = "Libre";
      } else if (c.status === 'ocupado' || c.status === 'en_curso') {
        statusColor = "bg-amber-500/10 text-amber-400 border-amber-500/20";
        statusLabel = "Ocupado";
      }

      tr.innerHTML = `
        <td class="py-4 px-4">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-full bg-zinc-800 border border-brand-border flex items-center justify-center font-bold text-xs text-white">
              ${initials}
            </div>
            <div>
              <span class="block font-semibold text-white">${c.name}</span>
              <span class="text-[10px] text-zinc-500">Reg: ${dateStr}</span>
            </div>
          </div>
        </td>
        <td class="py-4 px-4">
          <span class="text-xs font-semibold text-brand-gold block">${c.alias}</span>
          <span class="text-[10px] text-zinc-500">ID Cadete: #${c.id}</span>
        </td>
        <td class="py-4 px-4">
          <span class="text-xs text-zinc-300 font-mono">${c.phone}</span>
        </td>
        <td class="py-4 px-4">
          <div class="flex items-center gap-1.5 mb-1.5">
            <i data-lucide="${c.vehicle === 'Moto' ? 'bike' : c.vehicle === 'Bicicleta' ? 'footprints' : 'car'}" class="w-4 h-4 text-zinc-400"></i>
            <span class="text-xs text-zinc-300 font-medium">${c.vehicle}</span>
          </div>
          ${c.plate ? `
            <div class="flex items-center gap-1.5">
              <span class="inline-flex items-center gap-1 text-[11px] font-mono font-bold text-white bg-zinc-800/90 px-2 py-0.5 rounded border border-zinc-700 tracking-wider shadow-inner">
                <i data-lucide="tag" class="w-3 h-3 text-brand-gold"></i> ${c.plate}
              </span>
              <button onclick="openQuickPlateModal(${c.id})" class="text-zinc-500 hover:text-brand-gold transition-colors p-1 rounded hover:bg-zinc-800" title="Modificar patente de ${c.name}">
                <i data-lucide="edit-3" class="w-3.5 h-3.5"></i>
              </button>
            </div>
          ` : `
            <button onclick="openQuickPlateModal(${c.id})" class="inline-flex items-center gap-1.5 text-[10px] text-amber-400 hover:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 px-2.5 py-1 rounded-lg border border-amber-500/30 transition-all font-semibold group cursor-pointer" title="Hacer clic para subir la patente de ${c.name}">
              <i data-lucide="upload" class="w-3 h-3 group-hover:-translate-y-0.5 transition-transform text-amber-400"></i>
              <span>Subir patente requerida</span>
            </button>
          `}
        </td>
        <td class="py-4 px-4">
          <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold border ${statusColor}">
            ${statusLabel}
          </span>
        </td>
        <td class="py-4 px-4 text-right">
          <div class="flex items-center justify-end gap-2">
            <button onclick="editCadete(${c.id})" title="Editar Cadete" class="px-3 py-1.5 rounded-xl border border-brand-border text-zinc-300 hover:text-white hover:bg-zinc-800 transition-all text-xs font-medium flex items-center gap-1.5">
              <i data-lucide="edit-2" class="w-3.5 h-3.5 text-brand-gold"></i> Editar
            </button>
            <button onclick="deleteCadete(${c.id})" title="Eliminar Cadete" class="p-1.5 rounded-xl border border-brand-border text-zinc-500 hover:text-brand-accent hover:border-brand-accent/40 hover:bg-brand-accent/10 transition-all">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

  } else {
    // Header for Clientes
    thead.innerHTML = `
      <tr class="border-b border-brand-border bg-brand-dark/50 text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
        <th class="py-3.5 px-4">Cliente (Nombre)</th>
        <th class="py-3.5 px-4">ID Cliente (UUID)</th>
        <th class="py-3.5 px-4">Teléfono</th>
        <th class="py-3.5 px-4">Último Logueo</th>
        <th class="py-3.5 px-4 text-right">Acciones</th>
      </tr>
    `;

    const filtered = clientes.filter(cl => {
      return cl.name.toLowerCase().includes(currentSearch) ||
        cl.phone.toLowerCase().includes(currentSearch) ||
        (cl.id && cl.id.toLowerCase().includes(currentSearch));
    });

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" class="py-12 text-center text-zinc-500">
            <i data-lucide="user-x" class="w-8 h-8 mx-auto mb-2 opacity-40"></i>
            <p class="text-xs">No se encontraron clientes registrados</p>
          </td>
        </tr>
      `;
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    filtered.forEach(cl => {
      const tr = document.createElement("tr");
      tr.className = "hover:bg-brand-dark/40 transition-colors";

      const initials = cl.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
      const loginStr = cl.last_login
        ? new Date(cl.last_login).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : 'Sin ingresos';

      tr.innerHTML = `
        <td class="py-4 px-4">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-full bg-brand-accent/10 border border-brand-accent/20 flex items-center justify-center font-bold text-xs text-brand-accent">
              ${initials}
            </div>
            <div>
              <span class="block font-semibold text-white">${cl.name}</span>
            </div>
          </div>
        </td>
        <td class="py-4 px-4">
          <span class="text-xs font-mono text-zinc-400 block truncate max-w-[200px]" title="${cl.id}">${cl.id}</span>
        </td>
        <td class="py-4 px-4">
          <span class="text-xs text-zinc-300 font-mono">${cl.phone}</span>
        </td>
        <td class="py-4 px-4">
          <span class="text-xs text-zinc-400 flex items-center gap-1.5">
            <i data-lucide="clock" class="w-3.5 h-3.5 text-zinc-500"></i> ${loginStr}
          </span>
        </td>
        <td class="py-4 px-4 text-right">
          <div class="flex items-center justify-end gap-2">
            <button onclick="editCliente('${cl.id}')" title="Editar Cliente" class="px-3 py-1.5 rounded-xl border border-brand-border text-zinc-300 hover:text-white hover:bg-zinc-800 transition-all text-xs font-medium flex items-center gap-1.5">
              <i data-lucide="edit-2" class="w-3.5 h-3.5 text-brand-gold"></i> Editar
            </button>
            <button onclick="deleteCliente('${cl.id}')" title="Eliminar Cliente" class="p-1.5 rounded-xl border border-brand-border text-zinc-500 hover:text-brand-accent hover:border-brand-accent/40 hover:bg-brand-accent/10 transition-all">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  if (window.lucide) window.lucide.createIcons();
};

/* ====================================================
   MODAL ACTIONS & HANDLERS (CADETES)
   ==================================================== */

window.openModal = () => {
  if (currentTab === 'cadetes') {
    openCadeteModal();
  } else {
    openClienteModal();
  }
};

window.openCadeteModal = (id = null) => {
  editingCadeteId = id;
  const titleEl = document.getElementById('modal-cadete-title');
  const subEl = document.getElementById('modal-cadete-subtitle');
  const btnSubmit = document.getElementById('btn-submit-cadete');
  const passHelp = document.getElementById('pass-help-text');
  const selectVehicle = document.getElementById('input-vehicle');

  if (id) {
    const cad = cadetes.find(c => c.id === id);
    if (!cad) return;

    if (titleEl) titleEl.innerText = `Editar Cadete #${id}`;
    if (subEl) subEl.innerText = "Modifica los datos del repartidor en el sistema";
    if (btnSubmit) btnSubmit.innerText = "Guardar Cambios";
    if (passHelp) passHelp.innerText = "Dejar en blanco para mantener la contraseña actual.";

    document.getElementById('input-name').value = cad.name;
    document.getElementById('input-alias').value = cad.alias !== '-' ? cad.alias : '';
    document.getElementById('input-dni').value = cad.phone !== '-' ? cad.phone : '';

    // Normalizar selección de vehículo
    const vehicleVal = (cad.vehicle || 'Moto').trim().toLowerCase();
    let found = false;
    if (selectVehicle) {
      for (let opt of selectVehicle.options) {
        if (opt.value.toLowerCase() === vehicleVal) {
          selectVehicle.value = opt.value;
          found = true;
          break;
        }
      }
      if (!found) {
        selectVehicle.value = 'Moto';
      }
    }

    const plateInput = document.getElementById('input-plate');
    const plateBadge = document.getElementById('plate-current-badge');
    const plateHelp = document.getElementById('plate-help-text');

    if (cad.plate) {
      if (plateInput) {
        plateInput.value = cad.plate;
        plateInput.placeholder = `Modificar patente actual: ${cad.plate}`;
      }
      if (plateBadge) {
        plateBadge.innerHTML = `<span class="text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 font-bold"><i data-lucide="check" class="w-3 h-3 inline mr-1"></i>Actual: ${cad.plate}</span>`;
      }
      if (plateHelp) {
        plateHelp.innerText = `Patente actual: ${cad.plate}. Puedes modificarla en cualquier momento.`;
      }
    } else {
      if (plateInput) {
        plateInput.value = '';
        plateInput.placeholder = 'Sin patente registrada - Ingrese o suba la patente aquí (ej: AA123BB)';
      }
      if (plateBadge) {
        plateBadge.innerHTML = `<span class="text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20 font-semibold"><i data-lucide="alert-circle" class="w-3 h-3 inline mr-1"></i>Subir patente pendiente</span>`;
      }
      if (plateHelp) {
        plateHelp.innerText = 'El cadete aún no tiene patente asignada. Ingrese la matrícula para subirla.';
      }
    }

    document.getElementById('input-password').value = '';
    document.getElementById('input-password').required = false;
  } else {
    if (titleEl) titleEl.innerText = "Registrar Cadete";
    if (subEl) subEl.innerText = "Añade un nuevo repartidor a la plataforma";
    if (btnSubmit) btnSubmit.innerText = "Registrar Cadete";
    if (passHelp) passHelp.innerText = "Contraseña provisoria de ingreso inicial";

    const form = document.getElementById('cadete-form');
    if (form) form.reset();
    if (selectVehicle) selectVehicle.value = 'Moto';

    const plateInput = document.getElementById('input-plate');
    const plateBadge = document.getElementById('plate-current-badge');
    const plateHelp = document.getElementById('plate-help-text');
    if (plateInput) {
      plateInput.value = '';
      plateInput.placeholder = 'Ingrese patente o matrícula (ej: AA123BB)';
    }
    if (plateBadge) plateBadge.innerHTML = '';
    if (plateHelp) plateHelp.innerText = 'Opcional para bicicleta o transporte sin motor.';

    document.getElementById('input-password').value = 'Todo2026!';
    document.getElementById('input-password').required = true;
  }

  const m = document.getElementById('modal-backdrop');
  const c = document.getElementById('modal-container');
  m.classList.remove('hidden');
  setTimeout(() => {
    m.classList.add('opacity-100');
    c.classList.remove('scale-95');
  }, 10);
};

window.closeModal = () => {
  const m = document.getElementById('modal-backdrop');
  const c = document.getElementById('modal-container');
  if (m && c) {
    m.classList.remove('opacity-100');
    c.classList.add('scale-95');
    setTimeout(() => m.classList.add('hidden'), 300);
  }
  editingCadeteId = null;
};

window.editCadete = (id) => {
  openCadeteModal(id);
};

window.deleteCadete = async (id) => {
  if (!confirm(`¿Estás seguro de que deseas eliminar al cadete #${id}?`)) return;

  const { error } = await supabase
    .from('Cadetes')
    .delete()
    .eq('id_cad', id);

  if (error) {
    alert("Error al eliminar cadete: " + error.message);
  } else {
    await fetchCadetes();
    filterData();
  }
};

window.handleSaveCadete = async (e) => {
  e.preventDefault();
  const name = document.getElementById('input-name').value.trim();
  const alias = document.getElementById('input-alias').value.trim();
  const dni = document.getElementById('input-dni').value.trim();
  const vehicle = document.getElementById('input-vehicle').value;
  const plate = document.getElementById('input-plate').value.trim();
  const pass = document.getElementById('input-password').value.trim();

  const formattedPlate = plate ? plate.toUpperCase() : null;
  const vehicleStr = formattedPlate ? `${vehicle} - ${formattedPlate}` : vehicle;

  if (editingCadeteId) {
    // MODO EDICIÓN
    const updatePayload = {
      nombre_cad: name,
      alias_cad: alias,
      telef_cad: dni,
      vehiculo_cad: vehicleStr,
      patente: formattedPlate
    };

    if (pass) {
      updatePayload.contra_cad = await sha256(pass);
    }

    const { error } = await supabase
      .from('Cadetes')
      .update(updatePayload)
      .eq('id_cad', editingCadeteId);

    if (error) {
      alert("Error al actualizar cadete: " + error.message);
    } else {
      closeModal();
      await fetchCadetes();
      filterData();
      mostrarToast(`Cadete #${editingCadeteId} actualizado correctamente`, 'success');
    }
  } else {
    // MODO CREACIÓN
    const passHash = await sha256(pass || 'Todo2026!');
    const { data, error } = await supabase
      .from('Cadetes')
      .insert([{
        nombre_cad: name,
        alias_cad: alias,
        telef_cad: dni,
        vehiculo_cad: vehicleStr,
        patente: formattedPlate,
        contra_cad: passHash,
        estado_cad: 'offline'
      }])
      .select();

    if (error) {
      alert("Error al crear cadete: " + error.message);
    } else {
      closeModal();
      await fetchCadetes();
      filterData();
      mostrarToast(`Cadete registrado exitosamente`, 'success');

      // Credenciales: El usuario es el NOMBRE del cadete
      document.getElementById('copy-user').innerText = name;
      document.getElementById('copy-pass').innerText = pass || 'Todo2026!';
      if (data && data.length > 0) {
        document.getElementById('copy-user').innerText += ` (ID: ${data[0].id_cad})`;
      }
      openCredentialModal();
    }
  }
};

/* ====================================================
   MODAL ACTIONS & HANDLERS (CLIENTES)
   ==================================================== */

window.openClienteModal = (id = null) => {
  editingClienteId = id;
  const titleEl = document.getElementById('modal-cliente-title');
  const subEl = document.getElementById('modal-cliente-subtitle');
  const btnSubmit = document.getElementById('btn-submit-cliente');

  if (id) {
    const cl = clientes.find(c => c.id === id);
    if (!cl) return;

    if (titleEl) titleEl.innerText = "Editar Cliente";
    if (subEl) subEl.innerText = `Modificando datos del cliente`;
    if (btnSubmit) btnSubmit.innerText = "Guardar Cambios";

    document.getElementById('input-cliente-name').value = cl.name;
    document.getElementById('input-cliente-phone').value = cl.phone;
  } else {
    if (titleEl) titleEl.innerText = "Registrar Cliente";
    if (subEl) subEl.innerText = "Añade un nuevo cliente a la plataforma";
    if (btnSubmit) btnSubmit.innerText = "Registrar Cliente";

    const form = document.getElementById('cliente-form');
    if (form) form.reset();
  }

  const m = document.getElementById('cliente-modal-backdrop');
  const c = document.getElementById('cliente-modal-container');
  if (m && c) {
    m.classList.remove('hidden');
    setTimeout(() => {
      m.classList.add('opacity-100');
      c.classList.remove('scale-95');
    }, 10);
  }
};

window.closeClienteModal = () => {
  const m = document.getElementById('cliente-modal-backdrop');
  const c = document.getElementById('cliente-modal-container');
  if (m && c) {
    m.classList.remove('opacity-100');
    c.classList.add('scale-95');
    setTimeout(() => m.classList.add('hidden'), 300);
  }
  editingClienteId = null;
};

window.editCliente = (id) => {
  openClienteModal(id);
};

window.deleteCliente = async (id) => {
  if (!confirm(`¿Estás seguro de que deseas eliminar este cliente?`)) return;

  const { error } = await supabase
    .from('Clientes')
    .delete()
    .eq('id_cliente', id);

  if (error) {
    alert("Error al eliminar cliente: " + error.message + "\n(Es posible que tenga pedidos vinculados).");
  } else {
    await fetchClientes();
    filterData();
  }
};

window.handleSaveCliente = async (e) => {
  e.preventDefault();
  const name = document.getElementById('input-cliente-name').value.trim();
  const phone = document.getElementById('input-cliente-phone').value.trim();

  if (editingClienteId) {
    // MODO EDICIÓN
    const { error } = await supabase
      .from('Clientes')
      .update({
        nombre_cliente: name,
        telefono_cliente: phone
      })
      .eq('id_cliente', editingClienteId);

    if (error) {
      alert("Error al actualizar cliente: " + error.message);
    } else {
      closeClienteModal();
      await fetchClientes();
      filterData();
    }
  } else {
    // MODO CREACIÓN
    const { error } = await supabase
      .from('Clientes')
      .insert([{
        id_cliente: crypto.randomUUID(),
        nombre_cliente: name,
        telefono_cliente: phone,
        f_loggueo_cliente: new Date().toISOString()
      }]);

    if (error) {
      alert("Error al crear cliente: " + error.message);
    } else {
      closeClienteModal();
      await fetchClientes();
      filterData();
    }
  }
};

/* ====================================================
   CREDENTIAL MODAL
   ==================================================== */

window.openCredentialModal = () => {
  const m = document.getElementById('credential-modal');
  if (m) {
    m.classList.remove('hidden');
    setTimeout(() => m.classList.add('opacity-100'), 10);
  }
};

window.closeCredentialModal = () => {
  const m = document.getElementById('credential-modal');
  if (m) {
    m.classList.remove('opacity-100');
    setTimeout(() => m.classList.add('hidden'), 300);
  }
};

/* ====================================================
   QUICK PLATE MODAL (MODIFICACIÓN RÁPIDA DE PATENTE)
   ==================================================== */

let quickEditingCadeteId = null;

window.openQuickPlateModal = (id) => {
  const cad = cadetes.find(c => c.id === id);
  if (!cad) return;

  quickEditingCadeteId = id;
  const nameEl = document.getElementById('quick-plate-cadete-name');
  if (nameEl) nameEl.innerText = `${cad.name} (ID #${cad.id}) • ${cad.vehicle}`;

  const statusBox = document.getElementById('quick-plate-status-content');
  const inputEl = document.getElementById('quick-input-plate');

  if (cad.plate) {
    if (statusBox) {
      statusBox.innerHTML = `
        <span class="text-xs text-zinc-300">Patente actual:</span>
        <span class="inline-flex items-center gap-1.5 text-xs font-mono font-bold text-white bg-zinc-800 px-2.5 py-1 rounded-lg border border-zinc-700 shadow-inner">
          <i data-lucide="tag" class="w-3.5 h-3.5 text-brand-gold"></i> ${cad.plate}
        </span>
      `;
    }
    if (inputEl) {
      inputEl.value = cad.plate;
      inputEl.placeholder = `Modificar patente actual: ${cad.plate}`;
    }
  } else {
    if (statusBox) {
      statusBox.innerHTML = `
        <span class="text-xs text-amber-400 flex items-center gap-1.5 font-semibold">
          <i data-lucide="alert-circle" class="w-4 h-4"></i>
          Sin patente registrada
        </span>
        <span class="text-[11px] text-zinc-400 font-medium bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded">Pendiente de subir</span>
      `;
    }
    if (inputEl) {
      inputEl.value = '';
      inputEl.placeholder = 'Ingrese la nueva patente para subirla (ej: AA 123 BB)';
    }
  }

  const m = document.getElementById('quick-plate-modal');
  const c = document.getElementById('quick-plate-container');
  if (m && c) {
    m.classList.remove('hidden');
    setTimeout(() => {
      m.classList.add('opacity-100');
      c.classList.remove('scale-95');
      if (inputEl) inputEl.focus();
    }, 10);
  }

  if (window.lucide) window.lucide.createIcons();
};

window.closeQuickPlateModal = () => {
  const m = document.getElementById('quick-plate-modal');
  const c = document.getElementById('quick-plate-container');
  if (m && c) {
    m.classList.remove('opacity-100');
    c.classList.add('scale-95');
    setTimeout(() => m.classList.add('hidden'), 300);
  }
  quickEditingCadeteId = null;
};

window.handleSaveQuickPlate = async (e) => {
  e.preventDefault();
  if (!quickEditingCadeteId) return;

  const inputEl = document.getElementById('quick-input-plate');
  const rawPlate = inputEl ? inputEl.value.trim() : '';
  const newPlate = rawPlate ? rawPlate.toUpperCase() : null;

  const btnSave = document.getElementById('btn-save-quick-plate');
  const originalText = btnSave ? btnSave.innerHTML : '';
  if (btnSave) {
    btnSave.disabled = true;
    btnSave.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin"></i> Guardando...`;
    if (window.lucide) window.lucide.createIcons();
  }

  const cad = cadetes.find(c => c.id === quickEditingCadeteId);
  const vehicleBase = cad ? cad.vehicle : 'Moto';
  const vehicleStr = newPlate ? `${vehicleBase} - ${newPlate}` : vehicleBase;

  const { error } = await supabase
    .from('Cadetes')
    .update({
      patente: newPlate,
      vehiculo_cad: vehicleStr
    })
    .eq('id_cad', quickEditingCadeteId);

  if (btnSave) {
    btnSave.disabled = false;
    btnSave.innerHTML = originalText;
  }

  if (error) {
    alert("Error al actualizar la patente en Supabase: " + error.message);
  } else {
    closeQuickPlateModal();
    await fetchCadetes();
    filterData();
    mostrarToast(newPlate ? `Patente ${newPlate} asignada a ${cad ? cad.name : 'cadete'}` : `Patente removida con éxito`, 'success');
  }
};

/* ====================================================
   TOAST NOTIFICATIONS
   ==================================================== */

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

window.addEventListener('DOMContentLoaded', () => {
  initPersonal();
});
