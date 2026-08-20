/* ============================================================================
   Check-List CD — aplicação do coletor (PWA)
   ----------------------------------------------------------------------------
   Regra central: o coletor NUNCA depende de rede para registrar. Tudo é gravado
   no IndexedDB do aparelho e sobe para a planilha quando houver sinal.
   ========================================================================== */

const CFG = window.CONFIG_CHECKLIST;

const estado = {
  usuario: null,
  token: null,          // { valor, expiraEm }
  modelos: [],
  deviceId: null,
  execucaoAtual: null,
  sincronizando: false
};

/* ==========================================================================
   1. BANCO LOCAL (IndexedDB)
   ========================================================================== */

const BD = (() => {
  const NOME = 'checklist-cd';
  const VERSAO = 1;
  let conexao = null;

  function abrir() {
    if (conexao) return Promise.resolve(conexao);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(NOME, VERSAO);
      req.onupgradeneeded = () => {
        const bd = req.result;
        if (!bd.objectStoreNames.contains('execucoes')) {
          bd.createObjectStore('execucoes', { keyPath: 'execucaoId' });
        }
        if (!bd.objectStoreNames.contains('kv')) {
          bd.createObjectStore('kv', { keyPath: 'chave' });
        }
      };
      req.onsuccess = () => { conexao = req.result; resolve(conexao); };
      req.onerror = () => reject(req.error);
    });
  }

  async function executar(store, modo, operacao) {
    const bd = await abrir();
    return new Promise((resolve, reject) => {
      const transacao = bd.transaction(store, modo);
      const pedido = operacao(transacao.objectStore(store));
      pedido.onsuccess = () => resolve(pedido.result);
      pedido.onerror = () => reject(pedido.error);
    });
  }

  return {
    salvar: (store, objeto) => executar(store, 'readwrite', s => s.put(objeto)),
    remover: (store, chave) => executar(store, 'readwrite', s => s.delete(chave)),
    listar: (store) => executar(store, 'readonly', s => s.getAll()),
    definir: (chave, valor) => executar('kv', 'readwrite', s => s.put({ chave, valor })),
    async obter(chave) {
      const registro = await executar('kv', 'readonly', s => s.get(chave));
      return registro ? registro.valor : null;
    }
  };
})();

/* ==========================================================================
   2. COMUNICAÇÃO COM O BACKEND
   ========================================================================== */

/**
 * Content-Type text/plain é proposital: mantém a requisição "simples" para o
 * navegador, sem preflight OPTIONS — que o Apps Script não responde.
 */
async function chamarApi(acao, dados = {}) {
  const resposta = await fetch(CFG.API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ acao }, dados)),
    redirect: 'follow'
  });
  if (!resposta.ok) throw new Error('Servidor respondeu ' + resposta.status);
  const json = await resposta.json();
  if (!json.ok) throw new Error(json.erro || 'Falha no servidor.');
  return json;
}

/* ==========================================================================
   3. AUTENTICAÇÃO (Google Identity Services)
   ========================================================================== */

function aguardarGoogle(msLimite = 6000) {
  return new Promise(resolve => {
    const inicio = Date.now();
    (function tentar() {
      if (window.google && google.accounts && google.accounts.id) return resolve(true);
      if (Date.now() - inicio > msLimite) return resolve(false);
      setTimeout(tentar, 150);
    })();
  });
}

async function iniciarLoginGoogle() {
  const disponivel = await aguardarGoogle();
  if (!disponivel) {
    mostrarAviso('Sem conexão com o Google. Conecte-se à rede para entrar na primeira vez. ' +
                 'Depois desse primeiro login, o app abre e registra offline.');
    return;
  }

  google.accounts.id.initialize({
    client_id: CFG.CLIENT_ID,
    callback: aoReceberCredencial,
    auto_select: true,
    cancel_on_tap_outside: false
  });

  google.accounts.id.renderButton(document.getElementById('botao-google'), {
    theme: 'filled_blue', size: 'large', width: 320,
    text: 'signin_with', locale: 'pt-BR'
  });

  google.accounts.id.prompt(); // tenta reentrada silenciosa
}

async function aoReceberCredencial(resposta) {
  try {
    const token = resposta.credential;
    const conteudo = decodificarJwt(token);
    estado.token = { valor: token, expiraEm: conteudo.exp * 1000 };
    await BD.definir('token', estado.token);

    const retorno = await chamarApi('entrar', { idToken: token, deviceId: estado.deviceId });
    estado.usuario = retorno.usuario;
    await BD.definir('usuario', retorno.usuario);

    await carregarModelos();
    irPara('tela-inicio');
    sincronizar();
  } catch (erro) {
    mostrarAviso(erro.message);
  }
}

function decodificarJwt(token) {
  const carga = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(carga))));
}

function tokenValido() {
  return estado.token && estado.token.expiraEm - Date.now() > 60000;
}

/**
 * Renovação silenciosa antes de sincronizar. Se o Google não devolver um token
 * novo, NÃO perdemos nada: a fila continua no aparelho até o próximo login.
 */
function renovarToken(msLimite = 8000) {
  return new Promise(async resolve => {
    if (tokenValido()) return resolve(true);
    if (!navigator.onLine) return resolve(false);
    if (!(await aguardarGoogle(3000))) return resolve(false);

    const encerrar = concluido => { clearTimeout(cronometro); resolve(concluido); };
    const cronometro = setTimeout(() => encerrar(false), msLimite);

    google.accounts.id.initialize({
      client_id: CFG.CLIENT_ID,
      auto_select: true,
      callback: async r => {
        const conteudo = decodificarJwt(r.credential);
        estado.token = { valor: r.credential, expiraEm: conteudo.exp * 1000 };
        await BD.definir('token', estado.token);
        encerrar(true);
      }
    });
    google.accounts.id.prompt(notificacao => {
      if (notificacao.isNotDisplayed && notificacao.isNotDisplayed()) encerrar(false);
    });
  });
}

async function sair() {
  if (window.google && google.accounts && google.accounts.id) {
    google.accounts.id.disableAutoSelect();
  }
  await BD.definir('token', null);
  await BD.definir('usuario', null);
  estado.usuario = null;
  estado.token = null;
  irPara('tela-login');
  iniciarLoginGoogle();
}

/* ==========================================================================
   4. MODELOS DE CHECK-LIST
   ========================================================================== */

async function carregarModelos() {
  try {
    const retorno = await chamarApi('carregar', { idToken: estado.token.valor });
    estado.modelos = retorno.modelos;
    await BD.definir('modelos', retorno.modelos);
  } catch (erro) {
    const emCache = await BD.obter('modelos');
    if (!emCache) throw erro;
    estado.modelos = emCache; // segue com a última versão baixada
  }
  renderizarModelos();
}

function renderizarModelos() {
  const alvo = document.getElementById('lista-modelos');
  alvo.innerHTML = '';

  if (!estado.modelos.length) {
    alvo.innerHTML = '<p class="vazio">Nenhum check-list ativo. Verifique a aba Modelos da planilha.</p>';
    return;
  }

  estado.modelos.forEach(modelo => {
    const cartao = document.createElement('div');
    cartao.className = 'cartao-modelo';
    cartao.innerHTML =
      '<h3></h3><p></p><div class="turnos"></div>';
    cartao.querySelector('h3').textContent = modelo.nome;
    cartao.querySelector('p').textContent =
      modelo.descricao + ' · ' + modelo.itens.length + ' verificações';

    const turnos = modelo.turnos.length ? modelo.turnos : ['ÚNICO'];
    const areaTurnos = cartao.querySelector('.turnos');
    turnos.forEach(turno => {
      const botao = document.createElement('button');
      botao.className = 'chip-turno';
      botao.type = 'button';
      botao.textContent = turno;
      botao.addEventListener('click', () => iniciarExecucao(modelo, turno));
      areaTurnos.appendChild(botao);
    });

    alvo.appendChild(cartao);
  });
}

/* ==========================================================================
   5. EXECUÇÃO DO CHECK-LIST
   ========================================================================== */

function iniciarExecucao(modelo, turno) {
  estado.execucaoAtual = {
    execucaoId: gerarUuid(),
    modeloId: modelo.modeloId,
    modeloNome: modelo.nome,
    turno: turno,
    data: dataDeHoje(),
    deviceId: estado.deviceId,
    inicioEm: new Date().toISOString(),
    respostas: {},
    modelo: modelo
  };

  document.getElementById('execucao-titulo').textContent = modelo.nome;
  document.getElementById('execucao-sub').textContent =
    turno + ' · ' + formatarData(new Date());
  document.getElementById('assinatura-nome').value = estado.usuario.nome;
  document.getElementById('assinatura-ok').checked = false;
  document.getElementById('execucao-erro').classList.add('oculto');

  renderizarItens(modelo);
  irPara('tela-execucao');
  window.scrollTo(0, 0);
}

function renderizarItens(modelo) {
  const alvo = document.getElementById('lista-itens');
  alvo.innerHTML = '';

  const locais = [];
  modelo.itens.forEach(item => {
    if (!locais.includes(item.local)) locais.push(item.local);
  });

  locais.forEach(local => {
    const grupo = document.createElement('section');
    grupo.className = 'grupo-local';
    const titulo = document.createElement('h2');
    titulo.textContent = local || 'Geral';
    grupo.appendChild(titulo);

    modelo.itens
      .filter(item => item.local === local)
      .forEach(item => grupo.appendChild(montarItem(item)));

    alvo.appendChild(grupo);
  });
}

function montarItem(item) {
  const caixa = document.createElement('article');
  caixa.className = 'item';
  caixa.dataset.itemId = item.itemId;

  const pergunta = document.createElement('p');
  pergunta.className = 'item-pergunta';
  pergunta.textContent = item.pergunta;
  if (item.obrigatorio) {
    const marca = document.createElement('span');
    marca.className = 'obrigatorio';
    marca.textContent = ' *';
    pergunta.appendChild(marca);
  }
  const faixa = descreverFaixa(item);
  if (faixa) {
    const info = document.createElement('span');
    info.className = 'item-faixa';
    info.textContent = faixa;
    pergunta.appendChild(info);
  }
  caixa.appendChild(pergunta);

  estado.execucaoAtual.respostas[item.itemId] = { valor: '', acaoCorretiva: '', foto: null };

  if (item.tipo === 'NUMERO') caixa.appendChild(montarCampoNumero(item, caixa));
  else if (item.tipo === 'SIM_NAO') caixa.appendChild(montarCampoSimNao(item, caixa));
  else caixa.appendChild(montarCampoTexto(item));

  if (item.exigeFoto) caixa.appendChild(montarCampoFoto(item));

  caixa.appendChild(montarCampoAcaoCorretiva(item));
  return caixa;
}

function montarCampoNumero(item, caixa) {
  const linha = document.createElement('div');
  linha.className = 'campo-numero';

  const campo = document.createElement('input');
  campo.className = 'campo';
  campo.type = 'number';
  campo.inputMode = 'decimal';
  campo.step = '0.1';
  campo.placeholder = '0,0';
  campo.addEventListener('input', () => {
    estado.execucaoAtual.respostas[item.itemId].valor = campo.value;
    atualizarConformidade(item, caixa);
  });

  linha.appendChild(campo);
  if (item.unidade) {
    const unidade = document.createElement('span');
    unidade.className = 'unidade';
    unidade.textContent = item.unidade;
    linha.appendChild(unidade);
  }
  return linha;
}

function montarCampoSimNao(item, caixa) {
  const par = document.createElement('div');
  par.className = 'par-sim-nao';

  ['SIM', 'NAO'].forEach(opcao => {
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.textContent = opcao === 'NAO' ? 'NÃO' : 'SIM';
    botao.addEventListener('click', () => {
      estado.execucaoAtual.respostas[item.itemId].valor = opcao;
      par.querySelectorAll('button').forEach(b => {
        b.classList.remove('escolhido-sim', 'escolhido-nao');
      });
      botao.classList.add(opcao === 'SIM' ? 'escolhido-sim' : 'escolhido-nao');
      atualizarConformidade(item, caixa);
    });
    par.appendChild(botao);
  });
  return par;
}

function montarCampoTexto(item) {
  const campo = document.createElement('textarea');
  campo.className = 'campo';
  campo.rows = 3;
  campo.placeholder = 'Digite aqui';
  campo.addEventListener('input', () => {
    estado.execucaoAtual.respostas[item.itemId].valor = campo.value;
  });
  return campo;
}

function montarCampoFoto(item) {
  const area = document.createElement('div');
  area.className = 'area-foto';

  const entrada = document.createElement('input');
  entrada.type = 'file';
  entrada.accept = 'image/*';
  entrada.capture = 'environment';
  entrada.className = 'oculto';

  const botao = document.createElement('button');
  botao.type = 'button';
  botao.className = 'botao pequeno';
  botao.textContent = 'Tirar foto';
  botao.addEventListener('click', () => entrada.click());

  const miniatura = document.createElement('img');
  miniatura.className = 'miniatura oculto';
  miniatura.alt = 'Foto registrada';

  entrada.addEventListener('change', async () => {
    if (!entrada.files || !entrada.files[0]) return;
    botao.disabled = true;
    botao.textContent = 'Processando...';
    try {
      const foto = await comprimirImagem(entrada.files[0]);
      estado.execucaoAtual.respostas[item.itemId].foto = foto;
      miniatura.src = 'data:' + foto.mimeType + ';base64,' + foto.dadosBase64;
      miniatura.classList.remove('oculto');
      botao.textContent = 'Refazer foto';
    } catch (erro) {
      mostrarToast(erro.message, 'falha');
      botao.textContent = 'Tirar foto';
    } finally {
      botao.disabled = false;
    }
  });

  area.appendChild(botao);
  area.appendChild(entrada);
  area.appendChild(miniatura);
  return area;
}

function montarCampoAcaoCorretiva(item) {
  const bloco = document.createElement('div');
  bloco.className = 'bloco-acao oculto';

  const rotulo = document.createElement('label');
  rotulo.className = 'rotulo';
  rotulo.textContent = 'Fora do padrão — descreva a ação corretiva tomada *';

  const campo = document.createElement('textarea');
  campo.className = 'campo';
  campo.rows = 2;
  campo.placeholder = 'Ex.: acionada a manutenção, produto transferido para a câmara 2';
  campo.addEventListener('input', () => {
    estado.execucaoAtual.respostas[item.itemId].acaoCorretiva = campo.value;
  });

  bloco.appendChild(rotulo);
  bloco.appendChild(campo);
  return bloco;
}

/** Destaque visual imediato: o operador vê que reprovou antes de sair da câmara. */
function atualizarConformidade(item, caixa) {
  const resposta = estado.execucaoAtual.respostas[item.itemId];
  const conforme = resposta.valor === '' || avaliarConformidadeLocal(item, resposta.valor);
  caixa.classList.toggle('nao-conforme', !conforme);
  caixa.querySelector('.bloco-acao').classList.toggle('oculto', conforme);
}

function avaliarConformidadeLocal(item, valor) {
  if (item.tipo === 'NUMERO') {
    const numero = Number(String(valor).replace(',', '.'));
    if (isNaN(numero)) return false;
    if (item.minimo !== null && numero < item.minimo) return false;
    if (item.maximo !== null && numero > item.maximo) return false;
    return true;
  }
  if (item.tipo === 'SIM_NAO') {
    if (!item.respostaEsperada) return true;
    return String(valor).toUpperCase() === item.respostaEsperada;
  }
  return true;
}

function descreverFaixa(item) {
  if (item.tipo === 'SIM_NAO' && item.respostaEsperada) {
    return 'Esperado: ' + (item.respostaEsperada === 'NAO' ? 'NÃO' : item.respostaEsperada);
  }
  if (item.tipo !== 'NUMERO') return '';
  const unidade = item.unidade ? ' ' + item.unidade : '';
  if (item.minimo !== null && item.maximo !== null) return 'Faixa: ' + item.minimo + ' a ' + item.maximo + unidade;
  if (item.minimo !== null) return 'Mínimo: ' + item.minimo + unidade;
  if (item.maximo !== null) return 'Máximo: ' + item.maximo + unidade;
  return '';
}

/* ==========================================================================
   6. CONCLUSÃO E FILA OFFLINE
   ========================================================================== */

async function concluirExecucao() {
  const execucao = estado.execucaoAtual;
  const problema = validarExecucao(execucao);

  const areaErro = document.getElementById('execucao-erro');
  if (problema) {
    areaErro.textContent = problema.mensagem;
    areaErro.classList.remove('oculto');
    const alvo = problema.itemId
      ? document.querySelector('[data-item-id="' + problema.itemId + '"]')
      : null;
    if (alvo) alvo.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  areaErro.classList.add('oculto');

  const registro = {
    execucaoId: execucao.execucaoId,
    modeloId: execucao.modeloId,
    modeloNome: execucao.modeloNome,
    data: execucao.data,
    turno: execucao.turno,
    deviceId: execucao.deviceId,
    inicioEm: execucao.inicioEm,
    fimEm: new Date().toISOString(),
    assinaturaNome: document.getElementById('assinatura-nome').value.trim(),
    assinaturaEm: new Date().toISOString(),
    status: 'PENDENTE',
    erro: '',
    respostas: execucao.modelo.itens.map(item => ({
      respostaId: gerarUuid(),
      itemId: item.itemId,
      valor: estado.execucaoAtual.respostas[item.itemId].valor,
      acaoCorretiva: estado.execucaoAtual.respostas[item.itemId].acaoCorretiva,
      foto: estado.execucaoAtual.respostas[item.itemId].foto,
      registradoEm: new Date().toISOString()
    }))
  };

  await BD.salvar('execucoes', registro);
  estado.execucaoAtual = null;

  mostrarToast('Check-list salvo no aparelho', 'sucesso');
  irPara('tela-inicio');
  await atualizarPainel();
  sincronizar();
}

/** Devolve o primeiro problema encontrado, ou null se estiver tudo certo. */
function validarExecucao(execucao) {
  for (const item of execucao.modelo.itens) {
    const resposta = execucao.respostas[item.itemId];
    const ondeEsta = ' (' + (item.local || 'Geral') + ')';

    if (item.obrigatorio && String(resposta.valor).trim() === '') {
      return { mensagem: 'Responda: ' + item.pergunta + ondeEsta, itemId: item.itemId };
    }
    if (resposta.valor !== '' && !avaliarConformidadeLocal(item, resposta.valor)
        && !String(resposta.acaoCorretiva).trim()) {
      return { mensagem: 'Descreva a ação corretiva de: ' + item.pergunta + ondeEsta, itemId: item.itemId };
    }
    if (item.exigeFoto && !resposta.foto) {
      return { mensagem: 'Falta a foto de: ' + item.pergunta + ondeEsta, itemId: item.itemId };
    }
  }

  if (!document.getElementById('assinatura-nome').value.trim()) {
    return { mensagem: 'Informe o nome do responsável.', itemId: null };
  }
  if (!document.getElementById('assinatura-ok').checked) {
    return { mensagem: 'Marque a confirmação do responsável para concluir.', itemId: null };
  }
  return null;
}

/* ==========================================================================
   7. SINCRONIZAÇÃO
   ========================================================================== */

async function sincronizar(manual = false) {
  if (estado.sincronizando) return;
  const fila = (await BD.listar('execucoes')).filter(e => e.status !== 'ENVIADA');
  if (!fila.length) { await atualizarPainel(); return; }

  if (!navigator.onLine) {
    if (manual) mostrarToast('Sem conexão. Os registros continuam salvos.', 'falha');
    return;
  }
  if (!(await renovarToken())) {
    if (manual) mostrarToast('Sessão expirada. Entre novamente para enviar.', 'falha');
    return;
  }

  estado.sincronizando = true;
  document.getElementById('btn-sincronizar').disabled = true;

  let enviadas = 0;
  for (const registro of fila) {
    try {
      await chamarApi('sincronizar', {
        idToken: estado.token.valor,
        execucao: montarPayload(registro)
      });
      // Guarda o comprovante sem as fotos: libera espaço no aparelho.
      registro.status = 'ENVIADA';
      registro.erro = '';
      registro.respostas.forEach(r => { r.foto = null; });
      await BD.salvar('execucoes', registro);
      enviadas++;
    } catch (erro) {
      registro.erro = erro.message;
      await BD.salvar('execucoes', registro);
      break; // erro de rede: para aqui e tenta tudo de novo depois
    }
  }

  estado.sincronizando = false;
  document.getElementById('btn-sincronizar').disabled = false;
  await atualizarPainel();

  if (enviadas) mostrarToast(enviadas + ' check-list(s) enviado(s)', 'sucesso');
  else if (manual) mostrarToast('Não foi possível enviar agora.', 'falha');
}

function montarPayload(registro) {
  return {
    execucaoId: registro.execucaoId,
    modeloId: registro.modeloId,
    data: registro.data,
    turno: registro.turno,
    deviceId: registro.deviceId,
    inicioEm: registro.inicioEm,
    fimEm: registro.fimEm,
    assinaturaNome: registro.assinaturaNome,
    assinaturaEm: registro.assinaturaEm,
    respostas: registro.respostas
  };
}

async function atualizarPainel() {
  const registros = await BD.listar('execucoes');
  const pendentes = registros.filter(r => r.status !== 'ENVIADA');

  const painel = document.getElementById('painel-sync');
  const titulo = document.getElementById('sync-titulo');
  const detalhe = document.getElementById('sync-detalhe');

  if (pendentes.length) {
    painel.classList.add('pendente');
    titulo.textContent = pendentes.length + ' aguardando envio';
    detalhe.textContent = pendentes[0].erro || 'Serão enviados quando houver sinal';
  } else {
    painel.classList.remove('pendente');
    titulo.textContent = 'Tudo sincronizado';
    detalhe.textContent = 'Nenhum registro pendente';
  }

  renderizarHistorico(registros);
}

function renderizarHistorico(registros) {
  const alvo = document.getElementById('lista-historico');
  alvo.innerHTML = '';

  const recentes = registros
    .sort((a, b) => String(b.fimEm).localeCompare(String(a.fimEm)))
    .slice(0, 15);

  if (!recentes.length) {
    alvo.innerHTML = '<p class="vazio">Nenhum check-list registrado ainda.</p>';
    return;
  }

  recentes.forEach(registro => {
    const linha = document.createElement('div');
    linha.className = 'linha-historico';

    const texto = document.createElement('div');
    const nome = document.createElement('strong');
    nome.textContent = registro.modeloNome;
    const detalhe = document.createElement('small');
    detalhe.textContent = registro.turno + ' · ' + formatarData(new Date(registro.fimEm));
    texto.appendChild(nome);
    texto.appendChild(detalhe);

    const marca = document.createElement('span');
    if (registro.status === 'ENVIADA') { marca.className = 'marca enviada'; marca.textContent = 'Enviado'; }
    else if (registro.erro) { marca.className = 'marca erro'; marca.textContent = 'Erro'; }
    else { marca.className = 'marca pendente'; marca.textContent = 'Pendente'; }

    linha.appendChild(texto);
    linha.appendChild(marca);
    alvo.appendChild(linha);
  });
}

/* ==========================================================================
   8. FOTOS
   ========================================================================== */

/** Reduz a imagem até caber no limite. Sem isso, os 15 GB do Drive acabam rápido. */
async function comprimirImagem(arquivo) {
  const limiteBytes = CFG.MAX_FOTO_KB * 1024;
  const bitmap = await createImageBitmap(arquivo);

  let ladoMaximo = 1280;
  let qualidade = 0.7;

  for (let tentativa = 0; tentativa < 6; tentativa++) {
    const escala = Math.min(1, ladoMaximo / Math.max(bitmap.width, bitmap.height));
    const tela = document.createElement('canvas');
    tela.width = Math.round(bitmap.width * escala);
    tela.height = Math.round(bitmap.height * escala);
    tela.getContext('2d').drawImage(bitmap, 0, 0, tela.width, tela.height);

    const dataUrl = tela.toDataURL('image/jpeg', qualidade);
    const base64 = dataUrl.split(',')[1];
    if (base64.length * 3 / 4 <= limiteBytes) {
      bitmap.close();
      return { dadosBase64: base64, mimeType: 'image/jpeg', nome: arquivo.name || 'foto.jpg' };
    }

    if (qualidade > 0.35) qualidade -= 0.12; else ladoMaximo = Math.round(ladoMaximo * 0.75);
  }

  bitmap.close();
  throw new Error('Não foi possível reduzir a foto. Tente enquadrar só o display.');
}

/* ==========================================================================
   9. NAVEGAÇÃO E UTILITÁRIOS
   ========================================================================== */

function irPara(idTela) {
  document.querySelectorAll('.tela').forEach(tela => tela.classList.remove('ativa'));
  document.getElementById(idTela).classList.add('ativa');
  if (idTela === 'tela-inicio' && estado.usuario) {
    document.getElementById('cabecalho-usuario').textContent = estado.usuario.nome;
  }
}

function mostrarToast(mensagem, tipo) {
  const toast = document.getElementById('toast');
  toast.textContent = mensagem;
  toast.className = 'toast ' + (tipo || '');
  setTimeout(() => toast.classList.add('oculto'), 4000);
}

function mostrarAviso(mensagem) {
  const aviso = document.getElementById('login-aviso');
  aviso.textContent = mensagem;
  aviso.classList.remove('oculto');
}

function gerarUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function dataDeHoje() {
  const agora = new Date();
  const mes = String(agora.getMonth() + 1).padStart(2, '0');
  const dia = String(agora.getDate()).padStart(2, '0');
  return agora.getFullYear() + '-' + mes + '-' + dia;
}

function formatarData(data) {
  return data.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

function atualizarFaixaConexao() {
  document.getElementById('faixa-conexao').classList.toggle('oculto', navigator.onLine);
}

/* ==========================================================================
   10. INICIALIZAÇÃO
   ========================================================================== */

async function iniciar() {
  document.getElementById('rotulo-versao').textContent = CFG.APP_VERSION;

  estado.deviceId = await BD.obter('deviceId');
  if (!estado.deviceId) {
    estado.deviceId = gerarUuid();
    await BD.definir('deviceId', estado.deviceId);
  }

  estado.usuario = await BD.obter('usuario');
  estado.token = await BD.obter('token');
  estado.modelos = (await BD.obter('modelos')) || [];

  document.getElementById('btn-sincronizar').addEventListener('click', () => sincronizar(true));
  document.getElementById('btn-sair').addEventListener('click', sair);
  document.getElementById('btn-voltar').addEventListener('click', () => {
    if (confirm('Sair sem concluir? As respostas deste check-list serão perdidas.')) {
      estado.execucaoAtual = null;
      irPara('tela-inicio');
    }
  });
  document.getElementById('btn-concluir').addEventListener('click', concluirExecucao);

  window.addEventListener('online', () => { atualizarFaixaConexao(); sincronizar(); });
  window.addEventListener('offline', atualizarFaixaConexao);
  atualizarFaixaConexao();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app funciona sem SW */ });
  }

  // Sessão já existente: entra direto, mesmo sem rede.
  if (estado.usuario) {
    renderizarModelos();
    irPara('tela-inicio');
    await atualizarPainel();
    if (navigator.onLine) {
      renovarToken().then(async ok => {
        if (!ok) return;
        try { await carregarModelos(); } catch (e) { /* mantém o cache */ }
        sincronizar();
      });
    }
  } else {
    iniciarLoginGoogle();
  }
}

iniciar();
