/**
 * Los cupos de conexión de una cuenta MySQL de la agenda, con una fila de
 * espera CORTA. Sin fila, el pedido que llegaba con todas las conexiones en uso
 * fallaba al instante: el Directorio pide médicos, especialidades y bancos a la
 * vez al abrirse, y con dos conexiones uno de los tres salía «no disponible» al
 * azar. Con fila, espera unos cientos de milisegundos a que se libere una.
 *
 * La espera tiene tope de tiempo y de largo: si la agenda está caída o
 * saturada, se falla rápido igual que antes, sin apilar pedidos en memoria.
 */
export class CuposAgenda {
  private libres: number;
  private readonly fila: { despertar: () => void; reloj: ReturnType<typeof setTimeout> }[] = [];

  constructor(
    cupos: number,
    private readonly esperaMaximaMs: number,
    private readonly largoMaximoFila: number,
  ) {
    this.libres = cupos;
  }

  /** Un cupo, o `null` si no se liberó ninguno a tiempo. Quien lo recibe lo devuelve llamándolo. */
  async tomar(): Promise<(() => void) | null> {
    if (this.libres > 0) {
      this.libres--;
      return this.devolvedor();
    }
    if (this.fila.length >= this.largoMaximoFila) return null;
    return new Promise(resolver => {
      const turno = {
        despertar: () => {
          clearTimeout(turno.reloj);
          resolver(this.devolvedor());
        },
        reloj: setTimeout(() => {
          const i = this.fila.indexOf(turno);
          if (i >= 0) this.fila.splice(i, 1);
          resolver(null);
        }, this.esperaMaximaMs),
      };
      this.fila.push(turno);
    });
  }

  /** Devolver dos veces el mismo cupo no crea uno de más. */
  private devolvedor(): () => void {
    let devuelto = false;
    return () => {
      if (devuelto) return;
      devuelto = true;
      const siguiente = this.fila.shift();
      if (siguiente) siguiente.despertar(); // el cupo pasa directo al primero de la fila
      else this.libres++;
    };
  }
}
