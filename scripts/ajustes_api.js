import { supabase } from './conexion_supabase.js';

// Variables globales de tarifas
let BASE_FEE = 1200;
let PRICE_PER_KM = 350;
let SURGE_PRICE_PERCENT = 20; // 20%
let COMISION_EMPRESA = 40; // % de cada pedido que el cadete rinde a la empresa
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

  // Respaldo por si la tabla no emite cambios por Realtime (ej: editada desde el panel de Supabase)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') fetchCotiz();
  });
  setInterval(fetchCotiz, 60000);
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
    const comision = parseFloat(data.Porc_Comision);
    if (Number.isFinite(comision)) COMISION_EMPRESA = comision;
  }

  pintarTarifas();
}

// Actualizar UI de tarjetas de tarifa
function pintarTarifas() {
  const displayBase = document.getElementById("display-base-price");
  const displayKm = document.getElementById("display-km-price");
  const displaySurge = document.getElementById("display-surge-price");
  const displayComision = document.getElementById("display-comision");
  const detalleComision = document.getElementById("display-comision-detalle");

  if (displayBase) displayBase.innerText = `$${BASE_FEE.toLocaleString('es-AR')}`;
  if (displayKm) displayKm.innerText = `$${PRICE_PER_KM.toLocaleString('es-AR')}`;
  if (displaySurge) displaySurge.innerText = `+ ${SURGE_PRICE_PERCENT}%`;
  if (displayComision) displayComision.innerText = `${COMISION_EMPRESA}%`;
  if (detalleComision) detalleComision.innerText = `El cadete rinde ${COMISION_EMPRESA}% a la empresa y se queda con ${Math.round((100 - COMISION_EMPRESA) * 100) / 100}%.`;
}

window.openCotizModal = () => {
  const m = document.getElementById('cotiz-modal-backdrop');
  const c = document.getElementById('cotiz-modal-container');
  
  // Set current values
  const inputBajada = document.getElementById('input-bajada');
  const inputKm = document.getElementById('input-km');
  const inputDinamica = document.getElementById('input-dinamica');
  const inputComision = document.getElementById('input-comision');

  if (inputBajada) inputBajada.value = BASE_FEE;
  if (inputKm) inputKm.value = PRICE_PER_KM;
  if (inputDinamica) inputDinamica.value = SURGE_PRICE_PERCENT;
  if (inputComision) inputComision.value = COMISION_EMPRESA;

  if (m && c) {
    m.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
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
    document.body.classList.remove('overflow-hidden');
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
  const newComision = parseFloat(document.getElementById('input-comision').value);

  if (!Number.isFinite(newComision) || newComision < 0 || newComision > 100) {
    alert("La comisión tiene que ser un porcentaje entre 0 y 100.");
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = originalText;
    }
    return;
  }

  const { error } = await supabase
    .from('Datos_cotiz')
    .upsert({
      id: 1,
      bajada_band: newBajada,
      tarifa_km: newKm,
      porc_tarif_dinamica: newDinamica,
      Porc_Comision: newComision
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
    COMISION_EMPRESA = newComision;

    pintarTarifas();

    window.closeCotizModal();
  }
};

window.addEventListener('DOMContentLoaded', () => {
  initAjustes();
});
