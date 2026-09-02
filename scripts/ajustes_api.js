import { supabase } from './conexion_supabase.js';

// Variables globales de tarifas
let BASE_FEE = 1200;
let PRICE_PER_KM = 350;
let SURGE_PRICE_PERCENT = 20; // 20%
let cotizId = 1;

export async function initAjustes() {
  await fetchCotiz();
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

  // Actualizar UI de tarjetas de tarifa
  const displayBase = document.getElementById("display-base-price");
  const displayKm = document.getElementById("display-km-price");
  const displaySurge = document.getElementById("display-surge-price");

  if (displayBase) displayBase.innerText = `$${BASE_FEE.toLocaleString()}`;
  if (displayKm) displayKm.innerText = `$${PRICE_PER_KM.toLocaleString()}`;
  if (displaySurge) displaySurge.innerText = `+ ${SURGE_PRICE_PERCENT}%`;
}

window.openCotizModal = () => {
  const m = document.getElementById('cotiz-modal-backdrop');
  const c = document.getElementById('cotiz-modal-container');
  
  // Set current values
  const inputBajada = document.getElementById('input-bajada');
  const inputKm = document.getElementById('input-km');
  const inputDinamica = document.getElementById('input-dinamica');

  if (inputBajada) inputBajada.value = BASE_FEE;
  if (inputKm) inputKm.value = PRICE_PER_KM;
  if (inputDinamica) inputDinamica.value = SURGE_PRICE_PERCENT;

  if (m && c) {
    m.classList.remove('hidden');
    setTimeout(() => {
      m.classList.add('opacity-100');
      c.classList.remove('scale-95');
    }, 10);
  }
};

window.closeCotizModal = () => {
  const m = document.getElementById('cotiz-modal-backdrop');
  const c = document.getElementById('cotiz-modal-container');
  if (m && c) {
    m.classList.remove('opacity-100');
    c.classList.add('scale-95');
    setTimeout(() => m.classList.add('hidden'), 300);
  }
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
    BASE_FEE = newBajada;
    PRICE_PER_KM = newKm;
    SURGE_PRICE_PERCENT = newDinamica;

    const displayBase = document.getElementById("display-base-price");
    const displayKm = document.getElementById("display-km-price");
    const displaySurge = document.getElementById("display-surge-price");

    if (displayBase) displayBase.innerText = `$${BASE_FEE.toLocaleString()}`;
    if (displayKm) displayKm.innerText = `$${PRICE_PER_KM.toLocaleString()}`;
    if (displaySurge) displaySurge.innerText = `+ ${SURGE_PRICE_PERCENT}%`;

    window.closeCotizModal();
  }
};

window.addEventListener('DOMContentLoaded', () => {
  initAjustes();
});
