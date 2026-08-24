/**
 * Check-List CD — Configuração do app.
 * Os dois valores abaixo são os ÚNICOS que você precisa preencher.
 * Passo a passo: ../03_Documentacao/PASSO_A_PASSO.md
 */
window.CONFIG_CHECKLIST = {
  APP_VERSION: 'vs.2026.08.21.0014',

  // 1) OAuth Client ID criado no Google Cloud Console (tipo "Aplicativo Web").
  //    Origem JavaScript autorizada: https://aguiarluca.github.io
  CLIENT_ID: '243478988743-ktrtihcrqtsaumugbbcu3ogk8ljh42f0.apps.googleusercontent.com',

  // 2) URL /exec da implantação do Web App do Apps Script.
  //    Ao reimplantar, use "Gerenciar implantações → Nova versão" para manter esta URL.
  API_URL: 'https://script.google.com/macros/s/AKfycbzKOD3_h-1mbcdNgVyE2RuAUFMy1bL0kwuUo3d77GRm7aCdjDlCwIF71Da8Qm5JPqes/exec',

  // Teto de tamanho da foto depois da compressão (precisa bater com MAX_FOTO_KB no backend).
  MAX_FOTO_KB: 400
};
