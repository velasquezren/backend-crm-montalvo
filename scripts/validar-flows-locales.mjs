import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** Validador del subconjunto de estos borradores. NO sustituye al validador de Meta. */
export function validarFlow(flow) {
  assert.equal(flow.version, "7.3");
  assert.ok(
    !flow.data_api_version && !flow.endpoint_uri,
    "Sin endpoint en esta fase",
  );
  assert.ok(Array.isArray(flow.screens) && flow.screens.length > 0);
  const ids = new Set(flow.screens.map((s) => s.id));
  assert.equal(ids.size, flow.screens.length, "IDs de pantalla únicos");
  const rutas = new Map();
  for (const s of flow.screens) {
    assert.match(s.id, /^[A-Z_]+$/);
    assert.ok(s.title.startsWith("DEMO") && s.title.length <= 30);
    assert.equal(s.layout.type, "SingleColumnLayout");
    const forms = new Set();
    const acciones = [];
    const referencias = [];
    function visitar(c) {
      assert.ok(
        [
          "Form",
          "TextHeading",
          "TextBody",
          "Dropdown",
          "DatePicker",
          "TextInput",
          "OptIn",
          "Footer",
        ].includes(c.type),
        `Componente no validado: ${c.type}`,
      );
      if (c.type === "Form") {
        assert.ok(Array.isArray(c.children));
        c.children.forEach(visitar);
      }
      if (["Dropdown", "DatePicker", "TextInput", "OptIn"].includes(c.type)) {
        assert.ok(c.name && !forms.has(c.name), "Campo repetido");
        forms.add(c.name);
        assert.equal(c.required, true);
        assert.ok(c.label && c.label.length <= 80);
        assert.ok(
          !/^(ci|carnet|diagnostico|sintomas|pdf|telefono)$/i.test(c.name),
          "No pedir datos sensibles",
        );
      }
      if (c.type === "Dropdown") {
        assert.ok(
          Array.isArray(c["data-source"]) && c["data-source"].length > 0,
        );
        const opciones = c["data-source"];
        assert.equal(new Set(opciones.map((o) => o.id)).size, opciones.length);
        opciones.forEach((o) => {
          assert.match(o.id, /^DEMO_/);
          assert.ok(o.title);
        });
      }
      if (c.type === "Footer") {
        assert.ok(c.label.length <= 35);
        acciones.push(c["on-click-action"]);
      }
      if (c.type.startsWith("Text") && c.type !== "TextInput")
        assert.ok(typeof c.text === "string" && c.text.trim());
      referencias.push(
        ...JSON.stringify(c).matchAll(/\$\{(data|form)\.([a-z_]+)\}/g),
      );
    }
    s.layout.children.forEach(visitar);
    for (const [, tipo, nombre] of referencias)
      assert.ok(
        tipo === "data"
          ? Object.hasOwn(s.data ?? {}, nombre)
          : forms.has(nombre),
        `Referencia rota ${s.id}.${nombre}`,
      );
    assert.equal(acciones.length, 1, "Un único avance por pantalla");
    const a = acciones[0];
    assert.ok(a && ["navigate", "complete"].includes(a.name));
    if (a.name === "navigate") {
      assert.ok(
        !s.terminal && a.next.type === "screen" && ids.has(a.next.name),
      );
      const destino = flow.screens.find((x) => x.id === a.next.name);
      assert.deepEqual(
        Object.keys(a.payload).sort(),
        Object.keys(destino.data ?? {}).sort(),
        "Datos del próximo paso completos",
      );
      rutas.set(s.id, a.next.name);
    } else {
      assert.equal(s.terminal, true);
      assert.equal(s.success, true);
      assert.equal(a.payload.demo, true);
      assert.ok(
        ["SOLICITUD_DE_CITA", "INTERES_PROMOCION"].includes(a.payload.tipo),
      );
    }
  }
  const visitadas = new Set();
  let id = flow.screens[0].id;
  while (id) {
    assert.ok(!visitadas.has(id), "Ciclo de navegación");
    visitadas.add(id);
    id = rutas.get(id);
  }
  assert.equal(visitadas.size, ids.size, "Pantallas inalcanzables");
  return true;
}

export function validarBorradores() {
  const dir = new URL("../docs/whatsapp-interacciones/flows/", import.meta.url);
  const manifest = JSON.parse(
    readFileSync(new URL("manifest.json", dir), "utf8"),
  );
  assert.equal(manifest.ambientes.produccion.habilitado, false);
  for (const ambiente of Object.values(manifest.ambientes)) {
    assert.equal(ambiente.wabaId, null);
    assert.deepEqual(ambiente.flowIds, {});
  }
  for (const archivo of manifest.archivos)
    validarFlow(JSON.parse(readFileSync(new URL(archivo, dir), "utf8")));
  return manifest.archivos.length;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.stdout.write(
    `${validarBorradores()} borradores válidos para el subconjunto local. Validación Meta pendiente.\n`,
  );
}
