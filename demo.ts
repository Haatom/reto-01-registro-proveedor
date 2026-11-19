/**
 * demo.ts — Verificación de herramientas sin modelo
 *
 * Ejecuta todos los casos llamando directamente a las herramientas
 * e imprime un resumen por caso.
 *
 * Uso: bun run demo.ts
 */

import { rmSync, mkdirSync, readdirSync } from "fs";
import { resolve, join } from "path";
import * as tools from "./src/tools/proveedor.js";

const PROJECT_DIR = resolve(import.meta.dirname);
const ctx = { directory: PROJECT_DIR, sessionId: "demo" };

// Limpiar out/ al inicio para determinismo
const outDir = join(PROJECT_DIR, "out");
try { rmSync(outDir, { recursive: true }); } catch { /* no existe */ }
mkdirSync(outDir, { recursive: true });

console.log("═══════════════════════════════════════════════════════════");
console.log("  DEMO — Agente de Registro como Proveedor (sin modelo)");
console.log("═══════════════════════════════════════════════════════════\n");

// Descubrir casos disponibles
const casosDir = join(PROJECT_DIR, "fixtures", "reto-01", "casos");
const casos = readdirSync(casosDir).filter((d) => {
  try {
    return readdirSync(join(casosDir, d)).includes("solicitud.json");
  } catch { return false; }
});

console.log(`Casos encontrados: ${casos.join(", ")}\n`);

for (const caso of casos) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`📂 CASO: ${caso}`);
  console.log(`${"─".repeat(60)}`);

  // Paso 1: Leer solicitud
  console.log("\n📧 1. Leyendo solicitud...");
  const readResult = JSON.parse(await tools.leer_solicitud.execute({ caso }, ctx));
  if (!readResult.ok) {
    console.log(`  ❌ Error: ${readResult.error}`);
    continue;
  }
  const data = readResult.data;
  console.log(`  País: ${data.pais} | Cliente: ${data.cliente} | Formato: ${data.formato}`);
  console.log(`  Campos solicitados: ${data.campos.length}`);
  console.log(`  Soportes exigidos: ${data.soportes.join(", ")}`);

  // Paso 2: Mapear campos
  console.log("\n🔗 2. Mapeando campos al maestro...");
  const mapResult = JSON.parse(
    await tools.mapear_campos.execute({ caso, campos: data.campos }, ctx)
  );
  if (!mapResult.ok) {
    console.log(`  ❌ Error: ${mapResult.error}`);
    continue;
  }
  const mapeo = mapResult.data;
  console.log(`  ✅ Llenos: ${mapeo.llenos.length}`);
  for (const item of mapeo.llenos) {
    console.log(`     • ${item.etiqueta} = ${typeof item.valor === "object" ? JSON.stringify(item.valor) : item.valor} (${item.fuente})`);
  }

  if (mapeo.faltantes.length > 0) {
    console.log(`  ❌ Faltantes: ${mapeo.faltantes.length}`);
    for (const item of mapeo.faltantes) {
      console.log(`     • ${item.etiqueta}: ${item.motivo}`);
    }
  }

  if (mapeo.requiere_confirmacion.length > 0) {
    console.log(`  ⚠️  Requieren confirmación: ${mapeo.requiere_confirmacion.length}`);
    for (const item of mapeo.requiere_confirmacion) {
      console.log(`     • ${item.etiqueta}: ${item.nota}`);
    }
  }

  // Paso 3: Generar formulario
  console.log("\n📄 3. Generando formulario...");
  const formResult = JSON.parse(
    await tools.generar_formulario.execute({ caso, mapeo }, ctx)
  );
  if (formResult.ok) {
    console.log(`  ✅ Generado: ${formResult.data.ruta} (${formResult.data.formato})`);
  } else {
    console.log(`  ❌ Error: ${formResult.error}`);
  }

  // Paso 4: Armar paquete
  console.log("\n📦 4. Armando paquete para firma...");
  const paqResult = JSON.parse(
    await tools.armar_paquete.execute({ caso }, ctx)
  );
  if (paqResult.ok) {
    const paq = paqResult.data;
    console.log(`  Ruta: ${paq.ruta}`);
    console.log(`  Listo para firma: ${paq.listo_para_firma ? "✅ SÍ" : "❌ NO"}`);
    for (const item of paq.checklist) {
      const icon = item.estado === "presente" ? "✅" : item.estado === "vencido" ? "⚠️" : "❌";
      console.log(`     ${icon} ${item.tipo}: ${item.estado}${item.vigencia_hasta ? ` (vigencia: ${item.vigencia_hasta})` : ""}`);
    }
  } else {
    console.log(`  ❌ Error: ${paqResult.error}`);
  }

  // Paso 5: Simular envío SIN confirmación (debe fallar)
  console.log("\n🚫 5. Intentando envío sin confirmación...");
  const envioFail = JSON.parse(
    await tools.simular_envio.execute({ caso, confirmado: false }, ctx)
  );
  console.log(`  ${envioFail.ok ? "⚠️ No debió pasar" : "✅ Rechazado correctamente"}: ${envioFail.error || "enviado"}`);

  // Paso 6: Simular envío CON confirmación
  console.log("\n✉️  6. Enviando con confirmación explícita...");
  const envioOk = JSON.parse(
    await tools.simular_envio.execute({ caso, confirmado: true }, ctx)
  );
  if (envioOk.ok) {
    console.log(`  ✅ Envío simulado: ${envioOk.data.ruta}`);
  } else {
    console.log(`  ❌ Error: ${envioOk.error}`);
  }
}

console.log(`\n\n${"═".repeat(60)}`);
console.log("  DEMO COMPLETADA");
console.log(`${"═".repeat(60)}`);
console.log(`\nArchivos generados en: ${outDir}`);
