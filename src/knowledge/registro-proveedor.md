# Conocimiento del proceso: Registro como Proveedor

## Contexto
Periferia IT Group recibe entre 8 y 12 solicitudes mensuales de registro como proveedor de clientes en 5 países: Colombia (CO), Ecuador (EC), Perú (PE), Panamá (PA) y Honduras (HN).

## Fuentes de datos
- **Maestro**: `fixtures/reto-01/repositorio/maestro.json` — Datos corporativos de Periferia (ficticios).
- **Glosario**: `fixtures/reto-01/glosario-campos.json` — Mapeo de sinónimos de etiquetas de clientes a claves del maestro.
- **Soportes**: `fixtures/reto-01/repositorio/soportes/index.json` — Lista de documentos disponibles con vigencia.

## Reglas de negocio

### RN1 — Identificador tributario por país
| País | Identificador | Nota |
|------|---------------|------|
| CO   | NIT           | Periferia tiene NIT colombiano. Se usa directo. |
| EC   | RUC           | Se llena con NIT + requiere_confirmacion. |
| PE   | RUC           | Se llena con NIT + requiere_confirmacion. |
| PA   | RUC           | Se llena con NIT + requiere_confirmacion. |
| HN   | RTN           | Se llena con NIT + requiere_confirmacion. |

### RN2 — Datos bancarios
Los datos bancarios se llenan SOLO si la plantilla los solicita explícitamente. NUNCA aparecen en el borrador de correo de respuesta.

### RN3 — Soportes y vigencia
- Soporte vencido → bloquea `listo_para_firma`.
- Soporte ausente → bloquea `listo_para_firma`.
- Campo faltante → NO bloquea, pero aparece en checklist.

### RN4 — Confirmación humana
Ninguna acción externa (envío) se ejecuta sin confirmación explícita del usuario en el turno inmediato anterior.

### RN5 — Logging
Toda ejecución deja registro en `out/<caso>/log.jsonl`.

## Formatos de salida
| Formato | Prioridad | Salida |
|---------|-----------|--------|
| xlsx    | P0        | `out/<caso>/formulario.xlsx` |
| pdf     | P1        | `out/<caso>/formulario.pdf` |
| portal  | P2        | `out/<caso>/valores-portal.md` (valores para copiar) |
