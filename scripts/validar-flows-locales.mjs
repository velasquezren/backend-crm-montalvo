import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/*
 * Validador de los Flows de Montalvo. NO sustituye al validador de Meta: cubre
 * los límites oficiales que estos Flows usan (referencia de componentes y de
 * Flow JSON, revisada el 2026-10-05) y las reglas propias que el validador de
 * Meta no conoce. Cada regla dice de dónde sale.
 */

/** Límites de la referencia oficial de componentes (Flow JSON 7.3). */
const META = {
  componentesPorPantalla: 50,
  texto: { TextHeading: 80, TextSubheading: 80, TextBody: 4096, TextCaption: 409 },
  /** label, mínimo y máximo de opciones. */
  eleccion: {
    RadioButtonsGroup: { label: 30, min: 1, max: 20 },
    Dropdown: { label: 20, min: 1, max: 200 },
  },
  datePickerLabel: 40,
  opcionTitulo: 30,
  opcionDescripcion: 300,
  footerLabel: 35,
  categorias: ["SIGN_UP", "SIGN_IN", "APPOINTMENT_BOOKING", "LEAD_GENERATION", "CONTACT_US", "CUSTOMER_SUPPORT", "SURVEY", "OTHER"],
};
/** Guía oficial de buenas prácticas de Flows. */
const BUENAS_PRACTICAS = { dropdownDesde: 8, opcionesPorPantalla: 10 };

const TEXTOS = Object.keys(META.texto);
const ELECCIONES = Object.keys(META.eleccion);
/*
 * Entradas admitidas. Sin texto libre (TextInput/TextArea): el CRM cifra y nunca
 * le muestra al personal un campo de texto libre, así que preguntarlo solo haría
 * escribir a la paciente para nadie. Sin CheckboxGroup: devuelve una lista y el
 * contrato del backend solo acepta un valor por campo.
 */
const ENTRADAS = [...ELECCIONES, "DatePicker"];
const COMPONENTES = ["Form", ...TEXTOS, ...ENTRADAS, "Footer"];
const SENSIBLES = /^(ci|carnet|documento|diagnostico|sintomas|pdf|telefono|direccion)$/i;
/** Lo que el Flow no puede prometer: solo hay solicitudes, no reservas. */
const PROMESAS = /\b(confirmad[ao]s?|reservad[ao]s?|garantizad[ao]s?)\b/i;
const REFERENCIA = /\$\{(?:(data|form)\.([a-z_]+)|screen\.([A-Z_]+)\.form\.([a-z_]+))\}/g;

function referencias(valor) {
  return [...JSON.stringify(valor).matchAll(REFERENCIA)].map(([, tipo, nombre, pantalla, campo]) =>
    pantalla ? { tipo: "screen", pantalla, nombre: campo } : { tipo, nombre },
  );
}

/** Aplana Form (opcional desde Flow JSON 4.0) para revisar los componentes de una pantalla. */
function componentes(lista) {
  return lista.flatMap((c) => {
    assert.ok(COMPONENTES.includes(c.type), `Componente no admitido: ${c.type}`);
    if (c.type !== "Form") return [c];
    assert.ok(Array.isArray(c.children) && c.children.length > 0, "Form vacío");
    return componentes(c.children);
  });
}

function validarComponente(c, pantalla) {
  if (TEXTOS.includes(c.type)) {
    assert.ok(typeof c.text === "string" && c.text.trim(), `${pantalla}: texto vacío`);
    assert.ok(c.text.length <= META.texto[c.type], `${pantalla}: ${c.type} supera ${META.texto[c.type]} caracteres`);
    assert.ok(!PROMESAS.test(c.text), `${pantalla}: el texto promete una cita: «${c.text}»`);
  }
  if (ENTRADAS.includes(c.type)) {
    assert.match(c.name ?? "", /^[a-z][a-z_]*$/, `${pantalla}: nombre de campo inválido`);
    assert.ok(!SENSIBLES.test(c.name), `${pantalla}: no pedir datos sensibles (${c.name})`);
    // Meta no documenta qué devuelve un campo opcional vacío: todo campo es obligatorio
    // y las opciones incluyen la salida («Cualquier horario», «Necesito orientación»).
    assert.equal(c.required, true, `${pantalla}.${c.name}: los campos son obligatorios`);
    const limite = c.type === "DatePicker" ? META.datePickerLabel : META.eleccion[c.type].label;
    assert.ok(c.label?.trim() && c.label.length <= limite, `${pantalla}.${c.name}: label supera ${limite} caracteres`);
  }
  if (ELECCIONES.includes(c.type)) {
    const { min, max } = META.eleccion[c.type];
    const opciones = c["data-source"];
    assert.ok(Array.isArray(opciones) && opciones.length >= min && opciones.length <= max, `${pantalla}.${c.name}: entre ${min} y ${max} opciones`);
    assert.equal(new Set(opciones.map((o) => o.id)).size, opciones.length, `${pantalla}.${c.name}: opciones repetidas`);
    for (const o of opciones) {
      assert.match(o.id ?? "", /^[A-Z][A-Z0-9_]*$/, `${pantalla}.${c.name}: id de opción inválido`);
      assert.ok(o.title?.trim() && o.title.length <= META.opcionTitulo, `${pantalla}.${c.name}: título «${o.title}» supera ${META.opcionTitulo}`);
      assert.ok(!o.description || o.description.length <= META.opcionDescripcion, `${pantalla}.${c.name}: descripción larga`);
      assert.ok(!PROMESAS.test(o.title), `${pantalla}.${c.name}: la opción promete una cita`);
    }
    if (c.type === "Dropdown")
      assert.ok(opciones.length >= BUENAS_PRACTICAS.dropdownDesde, `${pantalla}.${c.name}: con menos de ${BUENAS_PRACTICAS.dropdownDesde} opciones va RadioButtonsGroup`);
  }
  if (c.type === "Footer") {
    assert.ok(c.label?.trim() && c.label.length <= META.footerLabel, `${pantalla}: Footer supera ${META.footerLabel}`);
    assert.ok(!/reserv|confirm|pagar/i.test(c.label), `${pantalla}: el botón promete una reserva`);
  }
}

/**
 * Valida un Flow y devuelve su contrato de respuesta: lo que necesita el
 * catálogo del backend (`FlowAutorizado` en interacciones-integracion.ts,
 * sin el ID que asigna Meta) para aceptar exactamente esta respuesta.
 */
export function validarFlow(flow, nombre = "flow") {
  assert.equal(flow.version, "7.3", "Flow JSON 7.3");
  assert.ok(!flow.data_api_version && !flow.endpoint_uri && !flow.routing_model, "Sin endpoint en esta fase");
  assert.ok(Array.isArray(flow.screens) && flow.screens.length > 0, "Sin pantallas");
  assert.ok(JSON.stringify(flow).length < 10 * 1024 * 1024, "Flow JSON supera 10 MB");
  const ids = new Set(flow.screens.map((s) => s.id));
  assert.equal(ids.size, flow.screens.length, "IDs de pantalla únicos");

  const campos = new Map(); // pantalla → Map(nombre → componente)
  const rutas = new Map();
  let final;
  for (const s of flow.screens) {
    assert.match(s.id, /^[A-Z][A-Z_]*$/, `ID de pantalla inválido: ${s.id}`);
    assert.notEqual(s.id, "SUCCESS", "SUCCESS es una palabra reservada de Meta");
    assert.ok(typeof s.title === "string" && s.title.trim() && s.title.length <= 30, `${s.id}: título vacío o largo`);
    assert.ok(!PROMESAS.test(s.title), `${s.id}: el título promete una cita`);
    assert.equal(s.layout?.type, "SingleColumnLayout");
    for (const [clave, def] of Object.entries(s.data ?? {}))
      assert.ok(def?.type && Object.hasOwn(def, "__example__"), `${s.id}.data.${clave}: falta type o __example__`);

    const lista = componentes(s.layout.children);
    assert.ok(lista.length <= META.componentesPorPantalla, `${s.id}: más de ${META.componentesPorPantalla} componentes`);
    const propios = new Map();
    let opciones = 0;
    for (const c of lista) {
      validarComponente(c, s.id);
      if (ENTRADAS.includes(c.type)) {
        assert.ok(!propios.has(c.name), `${s.id}: campo repetido ${c.name}`);
        propios.set(c.name, c);
      }
      if (ELECCIONES.includes(c.type)) opciones += c["data-source"].length;
    }
    assert.ok(opciones <= BUENAS_PRACTICAS.opcionesPorPantalla, `${s.id}: más de ${BUENAS_PRACTICAS.opcionesPorPantalla} opciones en una pantalla`);
    for (const campo of s.sensitive ?? []) assert.ok(propios.has(campo), `${s.id}: sensitive nombra un campo ajeno (${campo})`);
    campos.set(s.id, propios);

    const footers = lista.filter((c) => c.type === "Footer");
    assert.equal(footers.length, 1, `${s.id}: un único Footer por pantalla`);
    const a = footers[0]["on-click-action"];
    assert.ok(a && ["navigate", "complete"].includes(a.name), `${s.id}: acción no admitida`);
    if (a.name === "navigate") {
      assert.ok(!s.terminal, `${s.id}: una pantalla final no navega`);
      assert.ok(a.next?.type === "screen" && ids.has(a.next.name), `${s.id}: navega a una pantalla inexistente`);
      const destino = flow.screens.find((x) => x.id === a.next.name);
      assert.deepEqual(Object.keys(a.payload ?? {}).sort(), Object.keys(destino.data ?? {}).sort(), `${s.id}: datos del próximo paso incompletos`);
      rutas.set(s.id, a.next.name);
    } else {
      assert.equal(s.terminal, true, `${s.id}: complete fuera de una pantalla final`);
      assert.equal(s.success, true, `${s.id}: la pantalla final debe ser de éxito`);
      assert.equal(final, undefined, "Una sola pantalla final");
      final = { pantalla: s.id, payload: a.payload ?? {} };
    }
  }
  assert.ok(final, "Falta la pantalla final con complete");

  // Un solo recorrido, sin ciclos ni pantallas sueltas; `${screen.X…}` solo mira hacia atrás.
  const orden = [];
  for (let id = flow.screens[0].id; id; id = rutas.get(id)) {
    assert.ok(!orden.includes(id), "Ciclo de navegación");
    orden.push(id);
  }
  assert.equal(orden.length, ids.size, "Pantallas inalcanzables");
  for (const s of flow.screens)
    for (const r of referencias(s.layout)) {
      if (r.tipo === "data") assert.ok(Object.hasOwn(s.data ?? {}, r.nombre), `Referencia rota ${s.id}.data.${r.nombre}`);
      else if (r.tipo === "form") assert.ok(campos.get(s.id).has(r.nombre), `Referencia rota ${s.id}.form.${r.nombre}`);
      else
        assert.ok(orden.indexOf(r.pantalla) >= 0 && orden.indexOf(r.pantalla) < orden.indexOf(s.id) && campos.get(r.pantalla).has(r.nombre),
          `Referencia rota ${s.id} → ${r.pantalla}.${r.nombre}`);
    }

  // La respuesta: flow_version fijo y cada pregunta, una sola vez, por referencia.
  const { flow_version: version, ...respuesta } = final.payload;
  assert.equal(version, nombre, "flow_version debe ser el nombre del archivo");
  const contrato = { version, pantalla: orden[0], respuestas: {}, titulos: {} };
  const usados = new Set();
  for (const [clave, valor] of Object.entries(respuesta)) {
    const [r, ...otras] = referencias(valor);
    assert.ok(r && !otras.length && typeof valor === "string" && valor === valor.trim() && /^\$\{[^}]+\}$/.test(valor), `Respuesta ${clave}: solo una referencia a un campo`);
    assert.notEqual(r.tipo, "data", `Respuesta ${clave}: debe salir de un campo, no de datos de pantalla`);
    const pantalla = r.tipo === "screen" ? r.pantalla : final.pantalla;
    const c = campos.get(pantalla).get(r.nombre);
    assert.equal(clave, r.nombre, `Respuesta ${clave}: la clave debe llamarse como su campo`);
    usados.add(`${pantalla}.${r.nombre}`);
    if (c.type === "DatePicker") (contrato.campos ??= {})[clave] = { tipo: "fecha" };
    else {
      contrato.respuestas[clave] = c["data-source"].map((o) => o.id);
      contrato.titulos[clave] = Object.fromEntries(c["data-source"].map((o) => [o.id, o.title]));
    }
  }
  for (const [pantalla, propios] of campos)
    for (const campo of propios.keys())
      assert.ok(usados.has(`${pantalla}.${campo}`), `Pregunta sin respuesta: ${pantalla}.${campo} no llega al CRM`);
  return contrato;
}

/** El contrato completo del catálogo: el que se deriva del JSON más lo que decide Montalvo. */
export function contratoDeFlow(flow, nombre, declarado) {
  const derivado = validarFlow(flow, nombre);
  assert.equal(declarado.version, derivado.version, `${nombre}: versión del manifest distinta`);
  assert.equal(declarado.pantalla, derivado.pantalla, `${nombre}: pantalla inicial del manifest distinta`);
  assert.ok(declarado.proposito === undefined || declarado.proposito === "SOLICITUD_CITA", `${nombre}: propósito desconocido`);
  const claves = [...Object.keys(derivado.respuestas), ...Object.keys(derivado.campos ?? {})].sort();
  // Sin etiqueta el backend no le muestra el dato al personal: todas la llevan.
  assert.deepEqual(Object.keys(declarado.etiquetas ?? {}).sort(), claves, `${nombre}: cada respuesta necesita su etiqueta`);
  if (declarado.proposito === "SOLICITUD_CITA") {
    const final = flow.screens.find((s) => s.terminal);
    assert.ok(/no reserva/i.test(JSON.stringify(final.layout)), `${nombre}: la pantalla final debe decir que no reserva la cita`);
  }
  return { ...derivado, ...(declarado.proposito ? { proposito: declarado.proposito } : {}), etiquetas: declarado.etiquetas };
}

export function validarManifest(manifest) {
  assert.equal(manifest.jsonVersion, "7.3");
  assert.equal(manifest.ambientes.produccion.habilitado, false, "Producción deshabilitada");
  for (const [nombre, ambiente] of Object.entries(manifest.ambientes)) {
    /* Un ambiente apagado no apunta a nada remoto. Uno encendido (con autorización
       de René: hoy solo la WABA de prueba) declara su WABA y los Flows PUBLICADOS
       en ella; de ahí sale el catálogo que el CRM puede enviar. */
    if (ambiente.habilitado !== true) {
      assert.equal(ambiente.wabaId, null, `${nombre}: ningún WABA hasta que se autorice`);
      assert.deepEqual(ambiente.flowIds, {}, `${nombre}: ningún Flow remoto hasta que se autorice`);
      continue;
    }
    assert.match(ambiente.wabaId ?? "", /^\d+$/, `${nombre}: WABA del ambiente`);
    for (const [archivo, id] of Object.entries(ambiente.flowIds)) {
      assert.ok(manifest.archivos.includes(archivo), `${nombre}: ${archivo} no está en el manifest`);
      assert.match(id, /^\d+$/, `${nombre}: ID publicado de ${archivo}`);
    }
  }
  assert.deepEqual(Object.keys(manifest.flows).sort(), [...manifest.archivos].sort(), "Cada archivo con su entrada en flows");
  for (const [archivo, f] of Object.entries(manifest.flows)) {
    assert.match(f.nombreMeta, /^montalvo_[a-z0-9_]+$/, `${archivo}: nombre en Meta`);
    assert.ok(f.categorias.length > 0 && f.categorias.every((c) => META.categorias.includes(c)), `${archivo}: categoría de Meta inválida`);
    assert.ok(Array.isArray(f.pendientes), `${archivo}: pendientes`);
    // Un borrador en Meta no se envía a nadie. Publicar es otra autorización: este
    // archivo no lo registra hasta que se decida, y entonces se cambia esta regla.
    if (f.borradorMeta) {
      assert.match(f.borradorMeta.wabaId ?? "", /^\d+$/, `${archivo}: WABA del borrador`);
      assert.match(f.borradorMeta.flowId ?? "", /^\d+$/, `${archivo}: ID del borrador`);
      assert.equal(f.borradorMeta.estado, "DRAFT", `${archivo}: solo borradores; publicar no está autorizado`);
    }
  }
}

const DIR_FLOWS = new URL("../docs/whatsapp-interacciones/flows/", import.meta.url);
const leerFlow = (archivo) => JSON.parse(readFileSync(new URL(archivo, DIR_FLOWS), "utf8"));
const CATALOGO = new URL("../src/modules/conversaciones/flows-publicados.ts", import.meta.url);

/**
 * Lo que el CRM puede enviar: cada Flow PUBLICADO en un ambiente encendido, con
 * su contrato (derivado del JSON) y la WABA donde vive. El backend no lee docs/
 * en tiempo de ejecución: este catálogo se genera a TypeScript y el build
 * comprueba que el archivo coincide con el manifest.
 */
export function catalogoPublicado(manifest, flows) {
  return Object.values(manifest.ambientes)
    .filter((a) => a.habilitado === true)
    .flatMap((a) => Object.entries(a.flowIds).map(([archivo, id]) => ({ id, wabaId: a.wabaId, ...flows.find((f) => f.archivo === archivo).contrato })));
}

export function fuenteDelCatalogo(catalogo) {
  return (
    "// GENERADO por `npm run flows:generar` desde docs/whatsapp-interacciones/flows/manifest.json.\n" +
    "// No se edita a mano: `npm run check:flows` (parte del build) falla si no coincide.\n" +
    "import type { FlowPublicado } from './interacciones-integracion';\n\n" +
    `export const FLOWS_PUBLICADOS: readonly FlowPublicado[] = ${JSON.stringify(catalogo, null, 2)};\n`
  );
}

export function validarBorradores() {
  const manifest = leerFlow("manifest.json");
  validarManifest(manifest);
  return manifest.archivos.map((archivo) => ({
    archivo,
    contrato: contratoDeFlow(leerFlow(archivo), archivo.replace(/\.json$/, ""), manifest.flows[archivo].contrato),
    pendientes: manifest.flows[archivo].pendientes,
    borradorMeta: manifest.flows[archivo].borradorMeta,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flows = validarBorradores();
  const catalogo = catalogoPublicado(leerFlow("manifest.json"), flows);
  const fuente = fuenteDelCatalogo(catalogo);
  if (process.argv.includes("--generar")) writeFileSync(CATALOGO, fuente);
  else assert.equal(readFileSync(CATALOGO, "utf8"), fuente, "flows-publicados.ts no coincide con el manifest: corre `npm run flows:generar`");
  if (process.argv.includes("--contrato")) process.stdout.write(`${JSON.stringify(flows, null, 2)}\n`);
  else
    process.stdout.write(
      `${flows.length} Flows válidos localmente (límites de Meta 7.3 + reglas Montalvo).\n` +
        flows.map((f) => `  ${f.archivo}: ${f.borradorMeta ? `borrador en Meta ${f.borradorMeta.flowId} (WABA ${f.borradorMeta.wabaId}), sin publicar` : "sin crear en Meta"}\n`).join("") +
        catalogo.map((f) => `  PUBLICADO ${f.version}: Flow ${f.id} en la WABA ${f.wabaId} (el CRM lo envía por sus líneas)\n`).join("") +
        flows.flatMap((f) => f.pendientes.map((p) => `  pendiente ${f.archivo}: ${p}\n`)).join(""),
    );
}
