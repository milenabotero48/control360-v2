// Utilidad exportar a Excel sin dependencias externas
// Usa formato CSV con BOM para que Excel lo abra correctamente en español
export const exportarExcel = (datos, columnas, nombreArchivo) => {
  const BOM = '\uFEFF';
  const encabezado = columnas.map(c => c.label).join(';');
  const filas = datos.map(fila =>
    columnas.map(c => {
      const val = c.getValue ? c.getValue(fila) : (fila[c.key] ?? '');
      // Escapar punto y coma y saltos de línea
      const str = String(val).replace(/;/g, ',').replace(/\n/g, ' ');
      return str;
    }).join(';')
  );
  const csv = BOM + [encabezado, ...filas].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${nombreArchivo}_${new Date().toISOString().slice(0,10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
};

