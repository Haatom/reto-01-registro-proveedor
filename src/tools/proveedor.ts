import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, appendFileSync } from "fs";
import { join, resolve } from "path";

// ─── Tipos internos ───────────────────────────────────────────────
type ToolResult = string;
type Ctx = { directory: string; sessionId: string };

function ok(data: unknown): ToolResult {
  return JSON.stringify({ ok: true, data });
}

function fail(error: string): ToolResult {
  return JSON.stringify({ ok: false, error });
}

function log(ctx: Ctx, caso: string, herramienta: string, okFlag: boolean, resumen: string) {
  const outDir = join(ctx.directory, "out", caso);
  mkdirSync(outDir, { recursive: true });
  const entry = { ts: new Date().toISOString(), herramienta, ok: okFlag, resumen };
  appendFileSync(join(outDir, "log.jsonl"), JSON.stringify(entry) + "\n");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ─── HU-1: Leer la solicitud ─────────────────────────────────────
export const leer_solicitud = {
  description:
    "Lee el correo del cliente y la plantilla adjunta de un caso, devolviendo campos solicitados, país, formato y soportes exigidos.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/"),
  },
  async execute(args: { caso: string }, ctx: Ctx): Promise<ToolResult> {
    try {
      const casoDir = join(ctx.directory, "fixtures", "reto-01", "casos", args.caso);
      if (!existsSync(casoDir)) {
        log(ctx, args.caso, "proveedor_leer_solicitud", false, `Caso no encontrado: ${args.caso}`);
        return fail(`El caso "${args.caso}" no existe en fixtures/reto-01/casos/`);
      }

      const solicitud = readJson(join(casoDir, "solicitud.json")) as Record<string, unknown>;
      const formato = solicitud.formato as string;

      let campos: Array<{ etiqueta: string; obligatorio?: boolean; hoja?: string; celda_etiqueta?: string; celda_valor?: string }> = [];

      if (formato === "xlsx") {
        const plantilla = readJson(join(casoDir, "plantilla-celdas.json")) as Array<{
          hoja: string; celda_etiqueta: string; etiqueta: string; celda_valor: string;
        }>;
        campos = plantilla.map((c) => ({
          etiqueta: c.etiqueta,
          hoja: c.hoja,
          celda_etiqueta: c.celda_etiqueta,
          celda_valor: c.celda_valor,
        }));
      } else if (formato === "pdf") {
        const plantilla = readJson(join(casoDir, "plantilla-campos.json")) as Array<{
          etiqueta: string; obligatorio: boolean;
        }>;
        campos = plantilla.map((c) => ({
          etiqueta: c.etiqueta,
          obligatorio: c.obligatorio,
        }));
      } else if (formato === "portal") {
        const plantilla = readJson(join(casoDir, "plantilla-campos.json")) as Array<{
          etiqueta: string; obligatorio: boolean;
        }>;
        campos = plantilla.map((c) => ({
          etiqueta: c.etiqueta,
          obligatorio: c.obligatorio,
        }));
      }

      const soportes = readJson(join(casoDir, "soportes-exigidos.json")) as string[];

      const result = {
        pais: solicitud.pais,
        cliente: solicitud.cliente,
        formato,
        campos: campos.map((c) => c.etiqueta),
        campos_detalle: campos,
        soportes,
        correo: {
          id: solicitud.id,
          de: solicitud.de,
          asunto: solicitud.asunto,
          fecha: solicitud.fecha,
          cuerpo: solicitud.cuerpo,
        },
      };

      log(ctx, args.caso, "proveedor_leer_solicitud", true,
        `${campos.length} campos, formato ${formato}, ${soportes.length} soportes`);
      return ok(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(ctx, args.caso, "proveedor_leer_solicitud", false, msg);
      return fail(msg);
    }
  },
};

// ─── HU-2: Mapear campos al maestro ──────────────────────────────
export const mapear_campos = {
  description:
    "Cruza cada campo solicitado con el repositorio maestro usando el glosario de sinónimos. Devuelve campos llenos, faltantes y los que requieren confirmación.",
  args: {
    caso: z.string().describe("Nombre del caso"),
    campos: z.array(z.string()).describe("Lista de etiquetas de campos solicitados"),
  },
  async execute(args: { caso: string; campos: string[] }, ctx: Ctx): Promise<ToolResult> {
    try {
      const maestro = readJson(
        join(ctx.directory, "fixtures", "reto-01", "repositorio", "maestro.json")
      ) as Record<string, unknown>;
      const glosario = readJson(
        join(ctx.directory, "fixtures", "reto-01", "glosario-campos.json")
      ) as Record<string, string>;

      const casoDir = join(ctx.directory, "fixtures", "reto-01", "casos", args.caso);
      const solicitud = readJson(join(casoDir, "solicitud.json")) as Record<string, unknown>;
      const pais = solicitud.pais as string;

      // RN1: Traducción de identificador tributario por país
      const idTributarioPorPais: Record<string, string> = {
        CO: "NIT",
        EC: "RUC",
        PE: "RUC",
        PA: "RUC",
        HN: "RTN",
      };

      const llenos: Array<{ etiqueta: string; valor: unknown; fuente: string }> = [];
      const faltantes: Array<{ etiqueta: string; motivo: string }> = [];
      const requiere_confirmacion: Array<{ etiqueta: string; valor: unknown; fuente: string; nota: string }> = [];

      for (const etiqueta of args.campos) {
        // Buscar la clave en el glosario
        const claveMaestro = glosario[etiqueta];

        if (!claveMaestro) {
          faltantes.push({ etiqueta, motivo: "No existe mapeo en el glosario ni en el maestro" });
          continue;
        }

        const valor = getNestedValue(maestro, claveMaestro);

        if (valor === undefined || valor === null) {
          faltantes.push({ etiqueta, motivo: `Clave "${claveMaestro}" no tiene valor en el maestro` });
          continue;
        }

        // RN1: Identificador tributario extranjero
        const esIdTributario = ["NIT", "RUC", "RTN", "Identificación tributaria", "Número de identificación fiscal"].includes(etiqueta);
        if (esIdTributario && pais !== "CO") {
          const idEsperado = idTributarioPorPais[pais] || "desconocido";
          requiere_confirmacion.push({
            etiqueta,
            valor,
            fuente: `maestro.${claveMaestro}`,
            nota: `Periferia solo tiene NIT colombiano. El cliente pide ${idEsperado} (${pais}). Se llena con el NIT pero requiere confirmación como identificador extranjero.`,
          });
          continue;
        }

        llenos.push({ etiqueta, valor, fuente: `maestro.${claveMaestro}` });
      }

      const result = { llenos, faltantes, requiere_confirmacion };
      log(ctx, args.caso, "proveedor_mapear_campos", true,
        `${llenos.length} llenos, ${faltantes.length} faltantes, ${requiere_confirmacion.length} requieren confirmación`);
      return ok(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(ctx, args.caso, "proveedor_mapear_campos", false, msg);
      return fail(msg);
    }
  },
};

// ─── HU-3: Generar formulario ────────────────────────────────────
export const generar_formulario = {
  description:
    "Genera el formulario lleno en el formato solicitado (xlsx, pdf o portal). Para xlsx escribe en las celdas indicadas. Para pdf genera un documento. Para portal produce un archivo con valores listos para copiar.",
  args: {
    caso: z.string().describe("Nombre del caso"),
    mapeo: z.object({
      llenos: z.array(z.object({
        etiqueta: z.string(),
        valor: z.unknown(),
        fuente: z.string(),
      })),
      faltantes: z.array(z.object({
        etiqueta: z.string(),
        motivo: z.string(),
      })),
      requiere_confirmacion: z.array(z.object({
        etiqueta: z.string(),
        valor: z.unknown(),
        fuente: z.string(),
        nota: z.string(),
      })),
    }).describe("Resultado de mapear_campos"),
  },
  async execute(
    args: { caso: string; mapeo: { llenos: Array<{ etiqueta: string; valor: unknown; fuente: string }>; faltantes: Array<{ etiqueta: string; motivo: string }>; requiere_confirmacion: Array<{ etiqueta: string; valor: unknown; fuente: string; nota: string }> } },
    ctx: Ctx
  ): Promise<ToolResult> {
    try {
      const casoDir = join(ctx.directory, "fixtures", "reto-01", "casos", args.caso);
      const solicitud = readJson(join(casoDir, "solicitud.json")) as Record<string, unknown>;
      const formato = solicitud.formato as string;

      const outDir = join(ctx.directory, "out", args.caso);
      mkdirSync(outDir, { recursive: true });

      // Combinar llenos + confirmados para el llenado
      const valoresMap = new Map<string, unknown>();
      for (const item of args.mapeo.llenos) {
        valoresMap.set(item.etiqueta, item.valor);
      }
      for (const item of args.mapeo.requiere_confirmacion) {
        valoresMap.set(item.etiqueta, item.valor);
      }

      if (formato === "xlsx") {
        // Generar xlsx con ExcelJS
        const plantilla = readJson(join(casoDir, "plantilla-celdas.json")) as Array<{
          hoja: string; celda_etiqueta: string; etiqueta: string; celda_valor: string;
        }>;

        // Intentar usar ExcelJS
        try {
          const ExcelJS = await import("exceljs");
          const workbook = new ExcelJS.default.Workbook();

          // Agrupar por hoja
          const hojas = new Map<string, Array<{ celda_etiqueta: string; etiqueta: string; celda_valor: string }>>();
          for (const campo of plantilla) {
            if (!hojas.has(campo.hoja)) hojas.set(campo.hoja, []);
            hojas.get(campo.hoja)!.push(campo);
          }

          for (const [nombreHoja, campos] of hojas) {
            const sheet = workbook.addWorksheet(nombreHoja);
            for (const campo of campos) {
              sheet.getCell(campo.celda_etiqueta).value = campo.etiqueta;
              sheet.getCell(campo.celda_etiqueta).font = { bold: true };
              const valor = valoresMap.get(campo.etiqueta);
              if (valor !== undefined) {
                sheet.getCell(campo.celda_valor).value = typeof valor === "object" ? JSON.stringify(valor) : valor as string | number;
              } else {
                sheet.getCell(campo.celda_valor).value = "[FALTANTE]";
                sheet.getCell(campo.celda_valor).font = { color: { argb: "FFFF0000" } };
              }
            }
            // Ajustar anchos
            sheet.getColumn("B").width = 35;
            sheet.getColumn("C").width = 50;
            if (sheet.getColumn("A")) sheet.getColumn("A").width = 35;
          }

          const ruta = join(outDir, "formulario.xlsx");
          await workbook.xlsx.writeFile(ruta);

          log(ctx, args.caso, "proveedor_generar_formulario", true, `Generado ${ruta}`);
          return ok({ ruta: `out/${args.caso}/formulario.xlsx`, formato: "xlsx" });
        } catch {
          // Fallback: generar JSON con la estructura
          const data = plantilla.map((c) => ({
            hoja: c.hoja,
            celda: c.celda_valor,
            etiqueta: c.etiqueta,
            valor: valoresMap.get(c.etiqueta) ?? "[FALTANTE]",
          }));
          const ruta = join(outDir, "formulario.json");
          writeFileSync(ruta, JSON.stringify(data, null, 2));
          log(ctx, args.caso, "proveedor_generar_formulario", true, `Generado como JSON (ExcelJS no disponible)`);
          return ok({ ruta: `out/${args.caso}/formulario.json`, formato: "json-fallback" });
        }
      } else if (formato === "pdf") {
        // P1: Generar PDF con pdf-lib
        try {
          const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
          const doc = await PDFDocument.create();
          const font = await doc.embedFont(StandardFonts.Helvetica);
          const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

          const plantilla = readJson(join(casoDir, "plantilla-campos.json")) as Array<{
            etiqueta: string; obligatorio: boolean;
          }>;

          let page = doc.addPage([612, 792]);
          let y = 740;

          // Título
          page.drawText(`Formulario de Registro - ${solicitud.cliente}`, {
            x: 50, y, size: 16, font: fontBold, color: rgb(0.1, 0.1, 0.4),
          });
          y -= 30;
          page.drawText(`Fecha: ${solicitud.fecha}`, { x: 50, y, size: 10, font });
          y -= 30;

          // Línea separadora
          page.drawLine({ start: { x: 50, y }, end: { x: 562, y }, thickness: 1, color: rgb(0.7, 0.7, 0.7) });
          y -= 20;

          for (const campo of plantilla) {
            if (y < 60) {
              page = doc.addPage([612, 792]);
              y = 740;
            }

            const oblig = campo.obligatorio ? " *" : "";
            page.drawText(`${campo.etiqueta}${oblig}:`, {
              x: 50, y, size: 10, font: fontBold,
            });
            y -= 15;

            const valor = valoresMap.get(campo.etiqueta);
            const valorStr = valor !== undefined && valor !== null ? String(valor) : "[FALTANTE]";
            page.drawText(valorStr, {
              x: 70, y, size: 10, font,
              color: valor ? rgb(0, 0, 0) : rgb(0.8, 0, 0),
            });
            y -= 25;
          }

          const pdfBytes = await doc.save();
          const ruta = join(outDir, "formulario.pdf");
          writeFileSync(ruta, pdfBytes);

          log(ctx, args.caso, "proveedor_generar_formulario", true, `PDF generado ${ruta}`);
          return ok({ ruta: `out/${args.caso}/formulario.pdf`, formato: "pdf" });
        } catch {
          // Fallback text
          const plantilla = readJson(join(casoDir, "plantilla-campos.json")) as Array<{
            etiqueta: string; obligatorio: boolean;
          }>;
          const lines = [`FORMULARIO DE REGISTRO - ${solicitud.cliente}`, `Fecha: ${solicitud.fecha}`, ""];
          for (const campo of plantilla) {
            const valor = valoresMap.get(campo.etiqueta) ?? "[FALTANTE]";
            lines.push(`${campo.etiqueta}${campo.obligatorio ? " *" : ""}: ${valor}`);
          }
          const ruta = join(outDir, "formulario.txt");
          writeFileSync(ruta, lines.join("\n"));
          log(ctx, args.caso, "proveedor_generar_formulario", true, `Texto generado (pdf-lib no disponible)`);
          return ok({ ruta: `out/${args.caso}/formulario.txt`, formato: "txt-fallback" });
        }
      } else if (formato === "portal") {
        // P2: Portal web - no se implementa, se genera valores-portal.md
        const plantilla = readJson(join(casoDir, "plantilla-campos.json")) as Array<{
          etiqueta: string; obligatorio: boolean;
        }>;

        const lines = [
          `# Valores para portal web - ${solicitud.cliente}`,
          "",
          `> Formato no soportado para llenado automático.`,
          `> Los siguientes valores están listos para copiar manualmente en el portal.`,
          "",
          "| Campo | Valor | Estado |",
          "|---|---|---|",
        ];

        for (const campo of plantilla) {
          const valor = valoresMap.get(campo.etiqueta);
          const estado = valor !== undefined ? "✅ Lleno" : "❌ Faltante";
          const valorStr = valor !== undefined ? String(valor) : "-";
          lines.push(`| ${campo.etiqueta} | ${valorStr} | ${estado} |`);
        }

        const ruta = join(outDir, "valores-portal.md");
        writeFileSync(ruta, lines.join("\n"));

        log(ctx, args.caso, "proveedor_generar_formulario", true, `Formato portal: valores-portal.md generado`);
        return ok({ ruta: `out/${args.caso}/valores-portal.md`, formato: "portal" });
      } else {
        log(ctx, args.caso, "proveedor_generar_formulario", false, `Formato no soportado: ${formato}`);
        return fail(`Formato "${formato}" no soportado. Formatos válidos: xlsx, pdf, portal.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(ctx, args.caso, "proveedor_generar_formulario", false, msg);
      return fail(msg);
    }
  },
};

// ─── HU-4: Armar paquete para firma ─────────────────────────────
export const armar_paquete = {
  description:
    "Arma el paquete con formulario, soportes y borrador de correo para enviar a firma del representante legal.",
  args: {
    caso: z.string().describe("Nombre del caso"),
  },
  async execute(args: { caso: string }, ctx: Ctx): Promise<ToolResult> {
    try {
      const casoDir = join(ctx.directory, "fixtures", "reto-01", "casos", args.caso);
      const solicitud = readJson(join(casoDir, "solicitud.json")) as Record<string, unknown>;
      const soportesExigidos = readJson(join(casoDir, "soportes-exigidos.json")) as string[];

      const soportesIndex = readJson(
        join(ctx.directory, "fixtures", "reto-01", "repositorio", "soportes", "index.json")
      ) as Array<{ tipo: string; archivo: string; vigencia_hasta: string | null; descripcion: string }>;

      const paqueteDir = join(ctx.directory, "out", args.caso, "paquete");
      mkdirSync(paqueteDir, { recursive: true });

      // Copiar formulario si existe
      const outDir = join(ctx.directory, "out", args.caso);
      for (const ext of ["xlsx", "pdf", "txt", "json"]) {
        const formPath = join(outDir, `formulario.${ext}`);
        if (existsSync(formPath)) {
          copyFileSync(formPath, join(paqueteDir, `formulario.${ext}`));
        }
      }

      // Copiar valores-portal.md si existe
      const portalPath = join(outDir, "valores-portal.md");
      if (existsSync(portalPath)) {
        copyFileSync(portalPath, join(paqueteDir, "valores-portal.md"));
      }

      // Verificar y copiar soportes
      const hoy = new Date().toISOString().split("T")[0];
      const checklist: Array<{ tipo: string; estado: string; archivo?: string; descripcion?: string; vigencia_hasta?: string | null }> = [];
      let listoParaFirma = true;

      for (const tipoExigido of soportesExigidos) {
        const soporte = soportesIndex.find((s) => s.tipo === tipoExigido);
        if (!soporte) {
          checklist.push({ tipo: tipoExigido, estado: "ausente" });
          listoParaFirma = false;
          continue;
        }

        // RN3: Verificar vigencia
        if (soporte.vigencia_hasta && soporte.vigencia_hasta < hoy) {
          checklist.push({
            tipo: tipoExigido,
            estado: "vencido",
            archivo: soporte.archivo,
            descripcion: soporte.descripcion,
            vigencia_hasta: soporte.vigencia_hasta,
          });
          listoParaFirma = false;
          continue;
        }

        // Copiar soporte
        const src = join(ctx.directory, "fixtures", "reto-01", "repositorio", "soportes", soporte.archivo);
        if (existsSync(src)) {
          copyFileSync(src, join(paqueteDir, soporte.archivo));
          checklist.push({
            tipo: tipoExigido,
            estado: "presente",
            archivo: soporte.archivo,
            descripcion: soporte.descripcion,
            vigencia_hasta: soporte.vigencia_hasta,
          });
        } else {
          checklist.push({ tipo: tipoExigido, estado: "ausente", descripcion: soporte.descripcion });
          listoParaFirma = false;
        }
      }

      // Generar checklist.md
      const checklistLines = [
        `# Checklist de soportes - ${solicitud.cliente}`,
        "",
        `Fecha: ${hoy}`,
        "",
        "| Soporte | Estado | Vigencia | Archivo |",
        "|---|---|---|---|",
      ];
      for (const item of checklist) {
        const icon = item.estado === "presente" ? "✅" : item.estado === "vencido" ? "⚠️" : "❌";
        checklistLines.push(
          `| ${item.tipo} | ${icon} ${item.estado} | ${item.vigencia_hasta ?? "N/A"} | ${item.archivo ?? "-"} |`
        );
      }
      checklistLines.push("", `**Listo para firma: ${listoParaFirma ? "SÍ ✅" : "NO ❌"}**`);
      if (!listoParaFirma) {
        const problemas = checklist.filter((c) => c.estado !== "presente");
        checklistLines.push("", "### Acciones requeridas:");
        for (const p of problemas) {
          if (p.estado === "vencido") {
            checklistLines.push(`- **${p.tipo}**: Vencido el ${p.vigencia_hasta}. Solicitar renovación.`);
          } else {
            checklistLines.push(`- **${p.tipo}**: Ausente. Obtener el documento.`);
          }
        }
      }
      writeFileSync(join(paqueteDir, "checklist.md"), checklistLines.join("\n"));

      // Generar borrador-correo.md (RN2: no incluir datos bancarios)
      const maestro = readJson(
        join(ctx.directory, "fixtures", "reto-01", "repositorio", "maestro.json")
      ) as Record<string, unknown>;
      const repLegal = maestro.representante_legal as Record<string, string>;

      const correoLines = [
        `# Borrador de correo de respuesta`,
        "",
        `**Para:** ${solicitud.de}`,
        `**De:** ${(maestro.contacto_financiero as Record<string, string>).email}`,
        `**Asunto:** RE: ${solicitud.asunto}`,
        "",
        `Estimados ${solicitud.cliente},`,
        "",
        `Adjunto encontrarán el formulario de registro como proveedor debidamente diligenciado, junto con los soportes solicitados:`,
        "",
      ];
      for (const item of checklist) {
        if (item.estado === "presente") {
          correoLines.push(`- ${item.descripcion ?? item.tipo}`);
        }
      }
      correoLines.push(
        "",
        `Quedamos atentos a cualquier información adicional que requieran.`,
        "",
        `Cordialmente,`,
        `${repLegal.nombre}`,
        `${repLegal.cargo}`,
        `${(maestro as Record<string, unknown>).razon_social}`,
      );
      writeFileSync(join(paqueteDir, "borrador-correo.md"), correoLines.join("\n"));

      const result = {
        ruta: `out/${args.caso}/paquete/`,
        listo_para_firma: listoParaFirma,
        checklist,
      };

      log(ctx, args.caso, "proveedor_armar_paquete", true,
        `Paquete armado. Listo para firma: ${listoParaFirma}`);
      return ok(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(ctx, args.caso, "proveedor_armar_paquete", false, msg);
      return fail(msg);
    }
  },
};

// ─── HU-4 cont.: Simular envío ──────────────────────────────────
export const simular_envio = {
  description:
    "Simula el envío del paquete al cliente. Requiere confirmación explícita del usuario.",
  args: {
    caso: z.string().describe("Nombre del caso"),
    confirmado: z.boolean().describe("true si el usuario confirmó el envío explícitamente"),
  },
  async execute(args: { caso: string; confirmado: boolean }, ctx: Ctx): Promise<ToolResult> {
    try {
      // RN4: Confirmación explícita
      if (!args.confirmado) {
        log(ctx, args.caso, "proveedor_simular_envio", false, "Requiere confirmación explícita");
        return fail("Requiere confirmación explícita del usuario antes de enviar. Pregunte al usuario si desea proceder.");
      }

      const outDir = join(ctx.directory, "out", args.caso);
      const paqueteDir = join(outDir, "paquete");

      if (!existsSync(paqueteDir)) {
        log(ctx, args.caso, "proveedor_simular_envio", false, "No existe paquete armado");
        return fail("No se ha armado el paquete para este caso. Ejecute armar_paquete primero.");
      }

      const casoDir = join(ctx.directory, "fixtures", "reto-01", "casos", args.caso);
      const solicitud = readJson(join(casoDir, "solicitud.json")) as Record<string, unknown>;

      const envioLines = [
        `# ENVÍO SIMULADO`,
        "",
        `**Fecha de envío:** ${new Date().toISOString()}`,
        `**Destinatario:** ${solicitud.de}`,
        `**Caso:** ${args.caso}`,
        `**Cliente:** ${solicitud.cliente}`,
        "",
        `> Este archivo confirma que el paquete fue aprobado para envío por el usuario.`,
        `> En producción, se enviaría un correo con los archivos adjuntos del directorio paquete/.`,
        "",
        `## Contenido del paquete:`,
        "",
      ];

      // Listar archivos del paquete
      const { readdirSync } = await import("fs");
      const archivos = readdirSync(paqueteDir);
      for (const archivo of archivos) {
        envioLines.push(`- ${archivo}`);
      }

      const ruta = join(outDir, "ENVIO-SIMULADO.md");
      writeFileSync(ruta, envioLines.join("\n"));

      log(ctx, args.caso, "proveedor_simular_envio", true, "Envío simulado completado");
      return ok({ ruta: `out/${args.caso}/ENVIO-SIMULADO.md` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(ctx, args.caso, "proveedor_simular_envio", false, msg);
      return fail(msg);
    }
  },
};
