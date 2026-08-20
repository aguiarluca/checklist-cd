/**
 * Check-List CD — Configuração do app.
 * Os dois valores abaixo são os ÚNICOS que você precisa preencher.
 * Passo a passo: ../03_Documentacao/PASSO_A_PASSO.md
 */
window.CONFIG_CHECKLIST = {
  APP_VERSION: 'vs.2026.08.20.0003',

  // 1) OAuth Client ID criado no Google Cloud Console (tipo "Aplicativo Web").
  //    Origem JavaScript autorizada: https://aguiarluca.github.io
  CLIENT_ID: '243478988743-ktrtihcrqtsaumugbbcu3ogk8ljh42f0.apps.googleusercontent.com',

  // 2) URL /exec da implantação do Web App do Apps Script.  ⚠ AINDA FALTA PREENCHER
  API_URL: 'COLE_AQUI_A_URL_DO_APPS_SCRIPT/exec',

  // Teto de tamanho da foto depois da compressão (precisa bater com MAX_FOTO_KB no backend).
  MAX_FOTO_KB: 400
};
