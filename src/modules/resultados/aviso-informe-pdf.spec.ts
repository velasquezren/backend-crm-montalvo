import { pideElPdfDelAviso, RESPUESTA_PDF_AVISO } from './aviso-informe-pdf';

describe('pideElPdfDelAviso', () => {
  it('por el payload del CRM o, sin él, por el rótulo del botón', () => {
    expect(pideElPdfDelAviso({ id: RESPUESTA_PDF_AVISO, titulo: 'Lo que sea' })).toBe(true);
    expect(pideElPdfDelAviso({ id: 'Recibir PDF', titulo: 'Recibir PDF' })).toBe(true);
    expect(pideElPdfDelAviso({ id: 'x', titulo: '  recibir  pdf ' })).toBe(true);
  });

  it('otro botón no', () => {
    expect(pideElPdfDelAviso({ id: 'Agendar consulta', titulo: 'Agendar consulta' })).toBe(false);
    expect(pideElPdfDelAviso({ id: 'TPL_abc', titulo: 'Recibir PDF ahora' })).toBe(false);
  });
});
