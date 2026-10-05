import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validarFlow, validarBorradores } from "./validar-flows-locales.mjs";
const leer = () =>
  JSON.parse(
    readFileSync(
      new URL(
        "../docs/whatsapp-interacciones/flows/solicitud-cita.v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
test("valida los dos borradores aislados de producción", () =>
  assert.equal(validarBorradores(), 2));
test("rechaza enlace a pantalla inexistente", () => {
  const f = leer();
  f.screens[0].layout.children[1].children[1]["on-click-action"].next.name =
    "INEXISTENTE";
  assert.throws(() => validarFlow(f));
});
test("rechaza pérdida de datos entre pantallas", () => {
  const f = leer();
  f.screens[1].data = {};
  assert.throws(() => validarFlow(f));
});
test("rechaza una cita confirmada o endpoint agregado accidentalmente", () => {
  const f = leer();
  f.screens.at(-1).layout.children.at(-1)["on-click-action"].payload.tipo =
    "CITA_CONFIRMADA";
  assert.throws(() => validarFlow(f));
  assert.throws(() => validarFlow({ ...leer(), data_api_version: "3.0" }));
});
test("rechaza campos de identificación y referencias rotas", () => {
  const f = leer();
  f.screens[4].layout.children[1].children[0].name = "carnet";
  assert.throws(() => validarFlow(f));
  const g = leer();
  g.screens[5].layout.children[2].text = "${data.no_existe}";
  assert.throws(() => validarFlow(g));
});
