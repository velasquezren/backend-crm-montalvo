import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { catalogoPublicado, contratoDeFlow, fuenteDelCatalogo, validarBorradores, validarFlow, validarManifest } from "./validar-flows-locales.mjs";

const dir = new URL("../docs/whatsapp-interacciones/flows/", import.meta.url);
const leer = (archivo) => JSON.parse(readFileSync(new URL(archivo, dir), "utf8"));
const cita = () => leer("solicitud-cita.v1.json");
const NOMBRE = "solicitud-cita.v1";
/** El componente `type` (o el n-ésimo de ese tipo) de una pantalla. */
const en = (flow, pantalla, type, n = 0) =>
  flow.screens.find((s) => s.id === pantalla).layout.children.filter((c) => c.type === type)[n];
const footer = (flow, pantalla) => en(flow, pantalla, "Footer")["on-click-action"];
const falla = (flow, mensaje) => assert.throws(() => validarFlow(flow, NOMBRE), mensaje);

test("los dos Flows y el manifest pasan, con su contrato derivado", () => {
  const flows = validarBorradores();
  assert.deepEqual(flows.map((f) => f.archivo), ["solicitud-cita.v1.json", "interes-promocion.v1.json"]);
  const { contrato } = flows[0];
  assert.equal(contrato.pantalla, "MOTIVO");
  assert.equal(contrato.proposito, "SOLICITUD_CITA");
  assert.deepEqual(Object.keys(contrato.respuestas), ["especialidad", "cuando", "horario"]);
  assert.equal(contrato.titulos.horario.INDISTINTO, "Cualquier horario");
});

test("límites oficiales de Meta: label, título de opción, Footer y SUCCESS", () => {
  const a = cita();
  en(a, "MOTIVO", "RadioButtonsGroup").label = "¿Para qué especialidad necesitas la cita?";
  falla(a, /label supera 30/);
  const b = cita();
  en(b, "MOTIVO", "RadioButtonsGroup")["data-source"][0].title = "Ginecología y obstetricia general";
  falla(b, /supera 30/);
  const c = cita();
  en(c, "PREFERENCIA", "Footer").label = "Enviar mi solicitud de cita a recepción ya";
  falla(c, /Footer supera 35/);
  const d = cita();
  d.screens[1].id = "SUCCESS";
  footer(d, "MOTIVO").next.name = "SUCCESS";
  falla(d, /reservada/);
});

test("buenas prácticas de Meta: radio con pocas opciones y no más de 10 por pantalla", () => {
  const a = cita();
  en(a, "MOTIVO", "RadioButtonsGroup").type = "Dropdown";
  en(a, "MOTIVO", "Dropdown").label = "Especialidad";
  falla(a, /va RadioButtonsGroup/);
  const b = cita();
  en(b, "PREFERENCIA", "RadioButtonsGroup")["data-source"].push(
    { id: "UNO", title: "Uno" }, { id: "DOS", title: "Dos" }, { id: "TRES", title: "Tres" }, { id: "CUATRO", title: "Cuatro" }, { id: "CINCO", title: "Cinco" },
  );
  falla(b, /más de 10 opciones/);
});

test("navegación: pantalla inexistente y datos perdidos", () => {
  const a = cita();
  footer(a, "MOTIVO").next.name = "INEXISTENTE";
  falla(a, /inexistente/);
  const b = cita();
  b.screens[1].data = { especialidad: { type: "string", __example__: "GINECOLOGIA" } };
  falla(b, /datos del próximo paso/);
});

test("referencias: campo inexistente y referencia a una pantalla posterior", () => {
  const a = cita();
  footer(a, "PREFERENCIA").payload.especialidad = "${screen.MOTIVO.form.no_existe}";
  falla(a, /Referencia rota/);
  const b = cita();
  en(b, "MOTIVO", "TextBody").text = "${screen.PREFERENCIA.form.horario}";
  falla(b, /Referencia rota/);
});

test("la respuesta: flow_version del archivo, sin valores fijos ni preguntas que no llegan", () => {
  const a = cita();
  footer(a, "PREFERENCIA").payload.flow_version = "v1";
  falla(a, /nombre del archivo/);
  const b = cita();
  footer(b, "PREFERENCIA").payload.tipo = "CITA_CONFIRMADA";
  falla(b, /solo una referencia/);
  const c = cita();
  delete footer(c, "PREFERENCIA").payload.cuando;
  falla(c, /no llega al CRM/);
});

test("sin texto libre, sin datos sensibles y todo obligatorio", () => {
  const a = cita();
  a.screens[0].layout.children.splice(1, 0, { type: "TextInput", name: "nombre", label: "Nombre", required: true });
  falla(a, /no admitido: TextInput/);
  const b = cita();
  en(b, "MOTIVO", "RadioButtonsGroup").name = "diagnostico";
  falla(b, /datos sensibles/);
  const c = cita();
  en(c, "PREFERENCIA", "RadioButtonsGroup", 1).required = false;
  falla(c, /obligatorios/);
});

test("no promete una cita: ni el texto, ni el botón, ni la falta del aviso", () => {
  const a = cita();
  en(a, "PREFERENCIA", "TextCaption").text = "Tu cita quedará reservada.";
  falla(a, /promete/);
  const b = cita();
  en(b, "PREFERENCIA", "Footer").label = "Reservar cita";
  falla(b, /promete una reserva/);
  const c = cita();
  en(c, "PREFERENCIA", "TextCaption").text = "Recepción te escribirá por este chat.";
  const contrato = leer("manifest.json").flows["solicitud-cita.v1.json"].contrato;
  assert.throws(() => contratoDeFlow(c, NOMBRE, contrato), /no reserva/);
});

test("sin endpoint: Flow estático en esta fase", () => {
  falla({ ...cita(), data_api_version: "3.0" }, /Sin endpoint/);
  falla({ ...cita(), version: "6.0" }, /7\.3/);
});

test("el contrato del manifest coincide con el JSON y cada respuesta lleva etiqueta", () => {
  const contrato = leer("manifest.json").flows["solicitud-cita.v1.json"].contrato;
  assert.throws(() => contratoDeFlow(cita(), NOMBRE, { ...contrato, pantalla: "PREFERENCIA" }), /pantalla inicial/);
  const { horario, ...sinHorario } = contrato.etiquetas;
  assert.ok(horario);
  assert.throws(() => contratoDeFlow(cita(), NOMBRE, { ...contrato, etiquetas: sinHorario }), /etiqueta/);
});

test("el manifest no apunta a ningún activo remoto ni habilita producción", () => {
  const m = leer("manifest.json");
  assert.throws(() => validarManifest({ ...m, ambientes: { ...m.ambientes, desarrollo: { wabaId: "123", flowIds: {} } } }), /WABA/);
  assert.throws(() => validarManifest({ ...m, ambientes: { ...m.ambientes, produccion: { ...m.ambientes.produccion, habilitado: true } } }), /Producción/);
  const flows = structuredClone(m.flows);
  flows["solicitud-cita.v1.json"].categorias = ["CITAS"];
  assert.throws(() => validarManifest({ ...m, flows }), /categoría/);
  const publicado = structuredClone(m.flows);
  publicado["solicitud-cita.v1.json"].borradorMeta.estado = "PUBLISHED";
  assert.throws(() => validarManifest({ ...m, flows: publicado }), /solo borradores/);
});

test("un ambiente encendido declara su WABA y Flows publicados; de ahí sale el catálogo que el CRM envía", () => {
  const m = leer("manifest.json");
  const prueba = { wabaId: "1699047341353103", flowIds: { "solicitud-cita.v1.json": "777" }, habilitado: true };
  const conPrueba = { ...m, ambientes: { ...m.ambientes, prueba } };
  validarManifest(conPrueba);
  assert.throws(() => validarManifest({ ...m, ambientes: { ...m.ambientes, prueba: { ...prueba, wabaId: null } } }), /WABA/);
  assert.throws(() => validarManifest({ ...m, ambientes: { ...m.ambientes, prueba: { ...prueba, flowIds: { "otro.json": "1" } } } }), /no está en el manifest/);
  assert.throws(() => validarManifest({ ...m, ambientes: { ...m.ambientes, prueba: { ...prueba, flowIds: { "solicitud-cita.v1.json": "abc" } } } }), /ID publicado/);
  /* Producción sigue apagada aunque otro ambiente esté encendido. */
  assert.throws(() => validarManifest({ ...conPrueba, ambientes: { ...conPrueba.ambientes, produccion: { ...m.ambientes.produccion, habilitado: true } } }), /Producción/);

  const catalogo = catalogoPublicado(conPrueba, validarBorradores());
  assert.deepEqual(catalogo.map((f) => [f.id, f.wabaId, f.proposito, f.pantalla]), [["777", "1699047341353103", "SOLICITUD_CITA", "MOTIVO"]]);
  assert.match(fuenteDelCatalogo(catalogo), /FLOWS_PUBLICADOS: readonly FlowPublicado\[\] = \[/);
  /* Un ambiente apagado no aporta nada al catálogo. */
  assert.deepEqual(catalogoPublicado(m, validarBorradores()), []);
});
