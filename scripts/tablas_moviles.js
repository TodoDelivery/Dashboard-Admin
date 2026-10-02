// =========================================================================
// TABLAS COMO TARJETAS EN CELULARES
// =========================================================================
// En pantallas angostas styles/responsive.css muestra cada fila de una tabla como una tarjeta con
// renglones "ETIQUETA ... valor". Acá se copia el título de cada columna al data-label de sus celdas,
// y se repite cada vez que la tabla se vuelve a pintar: las funciones que arman las filas no cambian.

function etiquetarTabla(tabla) {
  const titulos = [...tabla.querySelectorAll(':scope > thead th')]
    .map(th => th.textContent.replace(/\s+/g, ' ').trim());

  tabla.querySelectorAll(':scope > tbody > tr').forEach(fila => {
    [...fila.children].forEach((celda, i) => {
      if (celda.hasAttribute('colspan') || !titulos[i]) return;
      if (celda.dataset.label !== titulos[i]) celda.dataset.label = titulos[i];
    });
  });
}

function iniciarTablasMoviles() {
  document.querySelectorAll('table').forEach(tabla => {
    tabla.classList.add('tabla-tarjetas');
    etiquetarTabla(tabla);
    // Filas nuevas, o títulos que cambian (pestaña Cadetes/Clientes, porcentajes de comisión)
    new MutationObserver(() => etiquetarTabla(tabla))
      .observe(tabla, { childList: true, subtree: true, characterData: true });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', iniciarTablasMoviles);
} else {
  iniciarTablasMoviles();
}
