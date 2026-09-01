import { supabase } from './conexion_supabase.js';

let cadetes = [];
let currentFilterSearch = '';

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function initCadetes() {
  await fetchCadetes();
  renderTable();
  iniciarSuscripciones();
}

async function fetchCadetes() {
  const { data, error } = await supabase
    .from('Cadetes')
    .select('*')
    .order('f_creac', { ascending: false });

  if (!error && data) {
    cadetes = data.map(c => ({
      id: c.id_cad,
      name: c.nombre_cad || 'Desconocido',
      dni: c.telef_cad || '-', // Usando teléfono como DNI/Contacto
      user: c.alias_cad || `cadete${c.id_cad}`,
      vehicle: c.vehiculo_cad ? c.vehiculo_cad.split(' - ')[0] : 'Desconocido',
      plate: c.vehiculo_cad && c.vehiculo_cad.includes(' - ') ? c.vehiculo_cad.split(' - ')[1] : '-',
      raw_status: c.estado_cad,
      contra: c.contra_cad
    }));
  }
}

function iniciarSuscripciones() {
  supabase.channel('gestion-cadetes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'Cadetes' }, payload => {
      fetchCadetes().then(() => filterCadetes());
    })
    .subscribe();
}

window.filterCadetes = () => {
  const searchInput = document.getElementById("search-input");
  
  if (searchInput) currentFilterSearch = searchInput.value.toLowerCase();

  const filtered = cadetes.filter(c => {
    return c.name.toLowerCase().includes(currentFilterSearch) || 
           c.dni.includes(currentFilterSearch) || 
           c.user.toLowerCase().includes(currentFilterSearch);
  });

  renderTable(filtered);
};

window.renderTable = (data = cadetes) => {
  const tbody = document.getElementById("cadetes-table-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!data || data.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="py-12 text-center text-zinc-500">
          <i data-lucide="users" class="w-8 h-8 mx-auto mb-2 opacity-40"></i>
          <p class="text-xs">No se encontraron cadetes registrados</p>
        </td>
      </tr>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  data.forEach(c => {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-brand-dark/40 transition-colors";
    
    tr.innerHTML = `
      <td class="py-4 px-4">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-full bg-zinc-800 border border-brand-border flex items-center justify-center font-bold text-xs text-white">
            ${c.name.split(' ').map(n=>n[0]).join('').substring(0,2)}
          </div>
          <div>
            <span class="block font-semibold text-white">${c.name}</span>
            <span class="text-[11px] text-zinc-500">DNI/Tel: ${c.dni}</span>
          </div>
        </div>
      </td>
      <td class="py-4 px-4">
        <span class="text-xs font-mono text-zinc-300 block">@${c.user}</span>
        <span class="text-[10px] text-zinc-500">ID: ${c.id}</span>
      </td>
      <td class="py-4 px-4">
        <div class="flex items-center gap-1.5">
          <i data-lucide="${c.vehicle === 'Moto' ? 'bike' : c.vehicle === 'Bicicleta' ? 'footprints' : 'car'}" class="w-4 h-4 text-zinc-400"></i>
          <span class="text-xs text-zinc-300 font-medium">${c.vehicle}</span>
        </div>
        <span class="text-[10px] text-zinc-500 font-mono">${c.plate !== '-' ? 'Patente: ' + c.plate : 'Sin patente'}</span>
      </td>

      <td class="py-4 px-4 text-right">
        <div class="flex items-center justify-end gap-2">
          <button onclick="editCadete(${c.id})" title="Editar Cadete" class="px-3 py-1.5 rounded-xl border border-brand-border text-zinc-400 hover:text-white hover:bg-zinc-800 transition-all text-xs font-medium flex items-center gap-2">
            <i data-lucide="edit-2" class="w-3.5 h-3.5"></i> Editar
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  if (window.lucide) window.lucide.createIcons();
};

window.editCadete = (id) => {
  alert("Editar cadete #" + id + " no implementado. Podrás modificar sus datos aquí próximamente.");
};

window.handleCreateCadete = async (e) => {
  e.preventDefault();
  const name = document.getElementById('input-name').value;
  const dni = document.getElementById('input-dni').value;
  const vehicle = document.getElementById('input-vehicle').value;
  const plate = document.getElementById('input-plate').value || '-';
  const user = document.getElementById('input-username').value;
  const pass = document.getElementById('input-password').value;
  const passHash = await sha256(pass);

  const { data, error } = await supabase
    .from('Cadetes')
    .insert([{
      nombre_cad: name,
      telef_cad: dni, // Guardamos DNI/Tel en telef_cad
      vehiculo_cad: `${vehicle} - ${plate}`,
      alias_cad: user,
      contra_cad: passHash,
      estado_cad: 'offline'
    }])
    .select();

  if (error) {
    alert("Error al crear cadete: " + error.message);
  } else {
    window.closeModal();
    // Mostrar modal con los datos generados
    document.getElementById('copy-user').innerText = user;
    document.getElementById('copy-pass').innerText = pass;
    
    if(data && data.length > 0){
       // Se podría agregar info del ID generado
       document.getElementById('copy-user').innerText += ` (ID: ${data[0].id_cad})`;
    }
    
    window.openCredentialModal();
  }
};



window.openModal = () => {
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
  m.classList.remove('opacity-100');
  c.classList.add('scale-95');
  setTimeout(() => m.classList.add('hidden'), 300);
  const form = document.getElementById('cadete-form');
  if(form) form.reset();
};

window.openCredentialModal = () => {
  const m = document.getElementById('credential-modal');
  m.classList.remove('hidden');
  setTimeout(() => m.classList.add('opacity-100'), 10);
};

window.closeCredentialModal = () => {
  const m = document.getElementById('credential-modal');
  m.classList.remove('opacity-100');
  setTimeout(() => m.classList.add('hidden'), 300);
};

window.addEventListener('DOMContentLoaded', () => {
  initCadetes();
});
