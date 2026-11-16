// =========================================================================
// ESTILO DEL MAPA (MapLibre), el mismo que usa la app de cadetes
// =========================================================================
// Copia de la parte de estilo de SistemaCadetes/Scripts/mapa_td.js: si cambia allá, cambiarlo acá también.
//   * cargarEstiloMapa(): estilo oscuro vectorial (OpenFreeMap, sin clave) con la paleta de la app;
//     si no carga, los mosaicos de OpenStreetMap oscurecidos.

const ESTILO_VECTORIAL = 'https://tiles.openfreemap.org/styles/dark';

// Respaldo si el estilo vectorial no carga: los mosaicos de OpenStreetMap, oscurecidos
const ESTILO_RASTER = {
  version: 8,
  sources: {
    osm: {
      type: 'raster', tileSize: 256, maxzoom: 19,
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>'
    }
  },
  layers: [
    { id: 'fondo', type: 'background', paint: { 'background-color': '#0B0E14' } },
    {
      id: 'osm', type: 'raster', source: 'osm',
      paint: { 'raster-brightness-min': 0.85, 'raster-brightness-max': 0.08, 'raster-hue-rotate': 200, 'raster-saturation': -0.75, 'raster-contrast': 0.1 }
    }
  ]
};

// Lleva el estilo oscuro a la paleta de la app: calles más visibles y nombres en español
function adaptarEstilo(estilo) {
  const colores = {
    background: { 'background-color': '#0B0E14' },
    water: { 'fill-color': '#0E1A26' },
    waterway: { 'line-color': '#0E1A26' },
    landuse_residential: { 'fill-color': '#0E121A' },
    landcover_wood: { 'fill-color': '#0D1714' },
    landuse_park: { 'fill-color': '#0D1714' },
    building: { 'fill-color': '#151A24', 'fill-outline-color': '#1E2533' },
    highway_path: { 'line-color': '#1A202C' },
    highway_minor: { 'line-color': '#252C3A' },
    highway_major_casing: { 'line-color': '#3A4458' },
    highway_major_inner: { 'line-color': '#2C3444' },
    highway_major_subtle: { 'line-color': '#2C3444' },
    highway_motorway_casing: { 'line-color': '#46536B' },
    highway_motorway_inner: { 'line-color': '#36405A' },
    highway_motorway_subtle: { 'line-color': '#2C3444' },
    highway_name_other: { 'text-color': '#8E9AA8', 'text-halo-color': '#0B0E14', 'text-halo-width': 1.4 },
    highway_name_motorway: { 'text-color': '#A7B1BE', 'text-halo-color': '#0B0E14', 'text-halo-width': 1.4 }
  };
  const nombre = ['coalesce', ['get', 'name:es'], ['get', 'name'], ['get', 'name_en']];
  for (const capa of estilo.layers || []) {
    if (colores[capa.id]) capa.paint = { ...capa.paint, ...colores[capa.id] };
    if (capa.type !== 'symbol' || !capa.layout?.['text-field']) continue;
    if (/^(place_|highway_name|water_name)/.test(capa.id)) capa.layout['text-field'] = nombre;
    if (capa.id === 'highway_name_other') capa.layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 14, 10, 18, 13];
    if (capa.id.startsWith('place_')) capa.paint = { ...capa.paint, 'text-color': '#9CA3AF', 'text-halo-color': '#0B0E14' };
  }
  return estilo;
}

// Se pide una sola vez por página; cada mapa recibe su propia copia (MapLibre no debe compartir el objeto)
let estiloPromesa = null;
export async function cargarEstiloMapa() {
  if (!estiloPromesa) {
    estiloPromesa = (async () => {
      try {
        const ctrl = new AbortController();
        const corte = setTimeout(() => ctrl.abort(), 6000);
        const res = await fetch(ESTILO_VECTORIAL, { signal: ctrl.signal });
        clearTimeout(corte);
        if (res.ok) return adaptarEstilo(await res.json());
      } catch (e) {
        console.warn('[Mapa] Estilo vectorial no disponible, uso OSM raster:', e);
      }
      estiloPromesa = null; // el próximo mapa vuelve a intentar el vectorial
      return ESTILO_RASTER;
    })();
  }
  return structuredClone(await estiloPromesa);
}
