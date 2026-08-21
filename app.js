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
  hoje: [],             // execuções de hoje conhecidas pelo servidor
  dataServidor: '',
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
    estado.hoje = retorno.hoje || [];
    estado.dataServidor = retorno.dataServidor || dataDeHoje();
    await BD.definir('modelos', retorno.modelos);
    await BD.definir('hoje', { data: estado.dataServidor, execucoes: estado.hoje });
  } catch (erro) {
    const emCache = await BD.obter('modelos');
    if (!emCache) throw erro;
    estado.modelos = emCache; // segue com a última versão baixada
  }
  await renderizarModelos();
}

/**
 * O que já foi feito hoje, juntando o que o servidor sabe com o que ainda está
 * na fila deste aparelho. Sem a segunda parte, o operador que registrou offline
 * veria o turno como disponível e faria tudo de novo.
 */
async function execucoesDeHoje() {
  const hoje = dataDeHoje();
  const doServidor = (estado.hoje || []).filter(e => !e.recusada);

  const locais = (await BD.listar('execucoes'))
    .filter(r => r.data === hoje && r.status !== 'RECUSADA')
    .map(r => ({
      modeloId: r.modeloId, turno: r.turno, email: estado.usuario.email,
      nome: r.assinaturaNome || estado.usuario.nome,
      fimEm: r.fimEm, local: true
    }));

  // O registro local pode já ter subido: descarta o que o servidor devolveu.
  const idsServidor = new Set(doServidor.map(e => e.modeloId + '|' + e.turno));
  return doServidor.concat(locais.filter(l => !idsServidor.has(l.modeloId + '|' + l.turno)));
}

/** Devolve a execução que bloqueia este turno, ou null se está liberado. */
function bloqueioDoTurno(modelo, turno, feitasHoje) {
  if (modelo.repeticao !== 'UM_POR_TURNO' && modelo.repeticao !== 'UM_POR_PESSOA_TURNO') return null;
  return feitasHoje.find(e =>
    e.modeloId === modelo.modeloId &&
    e.turno === turno &&
    (modelo.repeticao === 'UM_POR_TURNO' || e.email === estado.usuario.email)
  ) || null;
}

async function renderizarModelos() {
  const alvo = document.getElementById('lista-modelos');
  alvo.innerHTML = '';

  if (!estado.modelos.length) {
    alvo.innerHTML = '<p class="vazio">Nenhum check-list disponível para você.</p>';
    return;
  }

  const feitasHoje = estado.usuario ? await execucoesDeHoje() : [];

  estado.modelos.forEach(modelo => {
    const cartao = document.createElement('div');
    cartao.className = 'cartao-modelo';
    cartao.innerHTML = '<h3></h3><p></p><div class="turnos"></div>';
    cartao.querySelector('h3').textContent = modelo.nome;
    cartao.querySelector('p').textContent =
      [modelo.setor, modelo.descricao].filter(Boolean).join(' · ') +
      ' · ' + modelo.itens.length + ' verificações';

    const turnos = modelo.turnos.length ? modelo.turnos : ['ÚNICO'];
    const areaTurnos = cartao.querySelector('.turnos');

    turnos.forEach(turno => {
      const bloqueio = bloqueioDoTurno(modelo, turno, feitasHoje);
      areaTurnos.appendChild(montarChipTurno(modelo, turno, bloqueio));
    });

    alvo.appendChild(cartao);
  });
}

function montarChipTurno(modelo, turno, bloqueio) {
  const botao = document.createElement('button');
  botao.className = 'chip-turno';
  botao.type = 'button';

  if (!bloqueio) {
    botao.textContent = turno;
    botao.addEventListener('click', () => iniciarExecucao(modelo, turno));
    return botao;
  }

  const quem = bloqueio.local ? 'você' : (bloqueio.nome || bloqueio.email);
  const hora = bloqueio.fimEm ? formatarHora(new Date(bloqueio.fimEm)) : '';
  botao.classList.add('feito');
  botao.innerHTML = '<span class="chip-turno-nome"></span><span class="chip-turno-quem"></span>';
  botao.querySelector('.chip-turno-nome').textContent = '✓ ' + turno;
  botao.querySelector('.chip-turno-quem').textContent =
    quem + (hora ? ' · ' + hora : '') + (bloqueio.local ? ' (a enviar)' : '');

  // O ADMIN pode refazer — às vezes é necessário mesmo. Os demais só veem o aviso.
  if (estado.usuario.perfil === 'ADMIN') {
    botao.addEventListener('click', () => {
      if (confirm('O turno ' + turno + ' já foi registrado por ' + quem +
                  (hora ? ' às ' + hora : '') + '.\n\nFazer novamente?')) {
        iniciarExecucao(modelo, turno);
      }
    });
  } else {
    botao.disabled = true;
  }
  return botao;
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

  if (item.tipo === 'NUMERO')        caixa.appendChild(montarCampoNumero(item, caixa));
  else if (item.tipo === 'CONTAGEM') caixa.appendChild(montarCampoContagem(item, caixa));
  else if (item.tipo === 'SIM_NAO')  caixa.appendChild(montarCampoSimNao(item, caixa));
  else if (item.tipo === 'LISTA')    caixa.appendChild(montarCampoLista(item, caixa));
  else if (item.tipo === 'DATA')     caixa.appendChild(montarCampoData(item, caixa));
  else if (item.tipo !== 'FOTO')     caixa.appendChild(montarCampoTexto(item));

  if (exigeFoto(item)) caixa.appendChild(montarCampoFoto(item));

  caixa.appendChild(montarCampoAcaoCorretiva(item));
  return caixa;
}

/**
 * Campo numérico com botão de sinal.
 * O teclado numérico do Android não traz a tecla de menos, então o sinal é um
 * botão — que também é mais rápido de acertar com luva do que uma tecla pequena.
 * Itens com faixa inteiramente negativa (câmara congelada) já abrem em negativo.
 */
function montarCampoNumero(item, caixa) {
  const linha = document.createElement('div');
  linha.className = 'campo-numero';

  let negativo = item.maximo !== null && item.maximo < 0;

  const sinal = document.createElement('button');
  sinal.type = 'button';
  sinal.className = 'botao-sinal';
  sinal.setAttribute('aria-label', 'Alternar entre positivo e negativo');

  const campo = document.createElement('input');
  campo.className = 'campo';
  campo.type = 'text';
  campo.inputMode = 'decimal';
  campo.autocomplete = 'off';
  campo.placeholder = '0,0';

  function pintarSinal() {
    sinal.textContent = negativo ? '−' : '+';
    sinal.classList.toggle('negativo', negativo);
  }

  function registrar() {
    // Se o teclado do aparelho tiver a tecla de menos, respeita o que foi digitado.
    if (campo.value.indexOf('-') !== -1) {
      negativo = true;
      campo.value = campo.value.replace(/-/g, '');
      pintarSinal();
    }
    const digitos = campo.value.replace(/[^\d.,]/g, '').replace(',', '.');
    estado.execucaoAtual.respostas[item.itemId].valor =
      digitos === '' ? '' : (negativo ? '-' : '') + digitos;
    atualizarConformidade(item, caixa);
  }

  sinal.addEventListener('click', () => {
    negativo = !negativo;
    pintarSinal();
    registrar();
  });
  campo.addEventListener('input', registrar);
  pintarSinal();

  linha.appendChild(sinal);
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

/** Escolha entre opções cadastradas pelo administrador. */
function montarCampoLista(item, caixa) {
  const grupo = document.createElement('div');
  grupo.className = 'lista-opcoes';

  (item.opcoes || []).forEach(opcao => {
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'opcao';
    botao.textContent = opcao;
    botao.addEventListener('click', () => {
      estado.execucaoAtual.respostas[item.itemId].valor = opcao;
      grupo.querySelectorAll('.opcao').forEach(b => b.classList.remove('escolhida'));
      botao.classList.add('escolhida');
      atualizarConformidade(item, caixa);
    });
    grupo.appendChild(botao);
  });

  if (!grupo.children.length) {
    const aviso = document.createElement('p');
    aviso.className = 'rotulo';
    aviso.textContent = 'Sem opções cadastradas para esta pergunta.';
    grupo.appendChild(aviso);
  }
  return grupo;
}

/** Contagem inteira com botões grandes — pensada para contar de luva. */
function montarCampoContagem(item, caixa) {
  const linha = document.createElement('div');
  linha.className = 'campo-numero';

  const menos = document.createElement('button');
  menos.type = 'button';
  menos.className = 'botao-sinal';
  menos.textContent = '−';

  const mais = document.createElement('button');
  mais.type = 'button';
  mais.className = 'botao-sinal';
  mais.textContent = '+';

  const campo = document.createElement('input');
  campo.className = 'campo';
  campo.type = 'text';
  campo.inputMode = 'numeric';
  campo.placeholder = '0';

  function registrar() {
    campo.value = campo.value.replace(/\D/g, '');
    estado.execucaoAtual.respostas[item.itemId].valor = campo.value;
    atualizarConformidade(item, caixa);
  }

  function somar(quanto) {
    const atual = Number(campo.value || 0) + quanto;
    campo.value = String(Math.max(0, atual));
    registrar();
  }

  menos.addEventListener('click', () => somar(-1));
  mais.addEventListener('click', () => somar(1));
  campo.addEventListener('input', registrar);

  linha.appendChild(menos);
  linha.appendChild(campo);
  linha.appendChild(mais);
  if (item.unidade) {
    const unidade = document.createElement('span');
    unidade.className = 'unidade';
    unidade.textContent = item.unidade;
    linha.appendChild(unidade);
  }
  return linha;
}

function montarCampoData(item, caixa) {
  const campo = document.createElement('input');
  campo.className = 'campo';
  campo.type = 'date';
  campo.addEventListener('input', () => {
    estado.execucaoAtual.respostas[item.itemId].valor = campo.value;
    atualizarConformidade(item, caixa);
  });
  return campo;
}

/** Perguntas do tipo FOTO sempre exigem foto, mesmo sem a marcação no cadastro. */
function exigeFoto(item) {
  return item.exigeFoto || item.tipo === 'FOTO';
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
      // Na pergunta do tipo FOTO, a própria foto é a resposta.
      if (item.tipo === 'FOTO') estado.execucaoAtual.respostas[item.itemId].valor = 'REGISTRADA';
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

/**
 * Espelha avaliarConformidade() do backend. Aqui serve só para pintar a tela na
 * hora; quem decide o que vai gravado como conforme é sempre o servidor.
 */
function avaliarConformidadeLocal(item, valor) {
  if (item.tipo === 'NUMERO' || item.tipo === 'CONTAGEM') {
    const numero = Number(String(valor).replace(',', '.'));
    if (isNaN(numero)) return false;
    if (item.minimo !== null && numero < item.minimo) return false;
    if (item.maximo !== null && numero > item.maximo) return false;
    return true;
  }
  if (item.tipo === 'SIM_NAO' || item.tipo === 'LISTA') {
    if (!item.respostaEsperada) return true;
    return item.respostaEsperada.split('|').map(e => e.trim())
      .includes(String(valor).toUpperCase().trim());
  }
  if (item.tipo === 'DATA') {
    if (item.respostaEsperada !== 'FUTURA' && item.respostaEsperada !== 'PASSADA') return true;
    const data = new Date(String(valor) + 'T12:00:00');
    if (isNaN(data.getTime())) return false;
    const hoje = new Date();
    hoje.setHours(12, 0, 0, 0);
    return item.respostaEsperada === 'FUTURA' ? data >= hoje : data <= hoje;
  }
  return true;
}

function descreverFaixa(item) {
  if ((item.tipo === 'SIM_NAO' || item.tipo === 'LISTA') && item.respostaEsperada) {
    return 'Esperado: ' + item.respostaEsperada.replace(/NAO/g, 'NÃO').replace(/\|/g, ' ou ');
  }
  if (item.tipo === 'DATA') {
    if (item.respostaEsperada === 'FUTURA') return 'Não pode estar vencida';
    if (item.respostaEsperada === 'PASSADA') return 'Deve ser uma data passada';
    return '';
  }
  if (item.tipo !== 'NUMERO' && item.tipo !== 'CONTAGEM') return '';
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
  await renderizarModelos();   // o turno recém-feito já aparece bloqueado
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
    if (exigeFoto(item) && !resposta.foto) {
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
  const fila = (await BD.listar('execucoes')).filter(e => ehPendente(e));
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
  let recusadas = 0;

  for (const registro of fila) {
    try {
      const retorno = await chamarApi('sincronizar', {
        idToken: estado.token.valor,
        execucao: montarPayload(registro)
      });

      if (retorno.recusada) {
        // Recusa é resposta definitiva: insistir só travaria a fila para sempre.
        registro.status = 'RECUSADA';
        registro.erro = retorno.motivo || 'Registro recusado pelo servidor.';
        recusadas++;
      } else {
        registro.status = 'ENVIADA';
        registro.erro = '';
        enviadas++;
      }

      // Em qualquer um dos dois casos a foto não precisa mais ocupar o aparelho.
      registro.respostas.forEach(r => { r.foto = null; });
      await BD.salvar('execucoes', registro);
    } catch (erro) {
      registro.erro = erro.message;
      await BD.salvar('execucoes', registro);
      break; // erro de rede: para aqui e tenta tudo de novo depois
    }
  }

  estado.sincronizando = false;
  document.getElementById('btn-sincronizar').disabled = false;
  if (enviadas || recusadas) await carregarModelos().catch(() => {});
  await atualizarPainel();

  if (recusadas) {
    mostrarToast(recusadas + ' registro(s) recusado(s) — turno já registrado', 'falha');
  } else if (enviadas) {
    mostrarToast(enviadas + ' check-list(s) enviado(s)', 'sucesso');
  } else if (manual) {
    mostrarToast('Não foi possível enviar agora.', 'falha');
  }
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

/** Só PENDENTE volta para a fila. RECUSADA é definitivo, ENVIADA já foi. */
function ehPendente(registro) {
  return registro.status !== 'ENVIADA' && registro.status !== 'RECUSADA';
}

async function atualizarPainel() {
  const registros = await BD.listar('execucoes');
  const pendentes = registros.filter(ehPendente);

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
    if (registro.status === 'ENVIADA') {
      marca.className = 'marca enviada'; marca.textContent = 'Enviado';
    } else if (registro.status === 'RECUSADA') {
      marca.className = 'marca erro'; marca.textContent = 'Recusado';
      detalhe.textContent += ' · ' + registro.erro;
    } else if (registro.erro) {
      marca.className = 'marca erro'; marca.textContent = 'Erro';
    } else {
      marca.className = 'marca pendente'; marca.textContent = 'Pendente';
    }

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
   8b. ADMINISTRAÇÃO
   ----------------------------------------------------------------------------
   Ao contrário da execução, a área ADMIN é online-only: é usada no escritório,
   e escrita administrativa em fila offline abriria espaço para dois admins
   sobrescreverem um ao outro sem perceber.
   ========================================================================== */

const adm = { usuarios: [], modelos: [], modeloEdicao: null, itemEdicao: null, indiceItem: -1 };

async function abrirAdmin() {
  if (!navigator.onLine) return mostrarToast('A administração precisa de internet.', 'falha');
  if (!(await renovarToken())) return mostrarToast('Sessão expirada. Entre novamente.', 'falha');

  try {
    const retorno = await chamarApi('admCarregar', { idToken: estado.token.valor });
    adm.usuarios = retorno.usuarios;
    adm.modelos = retorno.modelos;
    document.getElementById('adm-sub').textContent =
      adm.usuarios.length + ' usuários · ' + adm.modelos.length + ' check-lists';
    renderizarUsuarios();
    renderizarModelosAdm();
    irPara('tela-admin');
  } catch (erro) {
    mostrarToast(erro.message, 'falha');
  }
}

function trocarAba(idPainel) {
  document.querySelectorAll('.aba').forEach(aba => {
    aba.classList.toggle('ativa', aba.dataset.painel === idPainel);
  });
  ['painel-usuarios', 'painel-modelos'].forEach(id => {
    document.getElementById(id).classList.toggle('oculto', id !== idPainel);
  });
}

/* ---------- usuários ---------- */

function renderizarUsuarios() {
  const alvo = document.getElementById('lista-usuarios');
  alvo.innerHTML = '';

  adm.usuarios.forEach(usuario => {
    const linha = criarRegistro(
      usuario.nome,
      usuario.email,
      usuario.perfil,
      usuario.ativo ? 'ativa' : 'inativa'
    );
    linha.addEventListener('click', () => abrirUsuario(usuario));
    alvo.appendChild(linha);
  });
}

function abrirUsuario(usuario) {
  const novo = !usuario;
  document.getElementById('usuario-titulo').textContent = novo ? 'Novo usuário' : usuario.nome;
  document.getElementById('usuario-email').value = novo ? '' : usuario.email;
  document.getElementById('usuario-email').disabled = !novo;   // e-mail é a chave
  document.getElementById('usuario-nome').value = novo ? '' : usuario.nome;
  document.getElementById('usuario-perfil').value = novo ? 'USER' : usuario.perfil;
  document.getElementById('usuario-ativo').checked = novo ? true : usuario.ativo;
  document.getElementById('usuario-erro').classList.add('oculto');
  irPara('tela-usuario');
}

async function salvarUsuario() {
  const erro = document.getElementById('usuario-erro');
  const dados = {
    email: document.getElementById('usuario-email').value.trim().toLowerCase(),
    nome: document.getElementById('usuario-nome').value.trim(),
    perfil: document.getElementById('usuario-perfil').value,
    ativo: document.getElementById('usuario-ativo').checked
  };

  if (!dados.email) return mostrarErro(erro, 'Informe o e-mail da conta Google.');
  if (!dados.nome) return mostrarErro(erro, 'Informe o nome.');

  const botao = document.getElementById('btn-salvar-usuario');
  botao.disabled = true;
  try {
    if (!(await renovarToken())) throw new Error('Sessão expirada. Entre novamente.');
    await chamarApi('admSalvarUsuario', { idToken: estado.token.valor, usuario: dados });
    mostrarToast('Usuário salvo', 'sucesso');
    await abrirAdmin();
    trocarAba('painel-usuarios');
  } catch (e) {
    mostrarErro(erro, e.message);
  } finally {
    botao.disabled = false;
  }
}

/* ---------- check-lists ---------- */

function renderizarModelosAdm() {
  const alvo = document.getElementById('lista-adm-modelos');
  alvo.innerHTML = '';

  adm.modelos.forEach(modelo => {
    const linha = criarRegistro(
      modelo.nome,
      (modelo.setor ? modelo.setor + ' · ' : '') + modelo.itens.length + ' perguntas · ' + modelo.turnos.join(', '),
      modelo.ativo ? 'Ativo' : 'Inativo',
      modelo.ativo ? 'ativa' : 'inativa'
    );
    linha.addEventListener('click', () => abrirModelo(modelo));
    alvo.appendChild(linha);
  });
}

function abrirModelo(modelo) {
  // Cópia de trabalho: nada vai para a planilha antes de Salvar.
  adm.modeloEdicao = modelo
    ? JSON.parse(JSON.stringify(modelo))
    : { modeloId: '', nome: '', descricao: '', setor: '', frequencia: 'DIARIA',
        turnos: ['MANHÃ'], horarios: [], repeticao: 'UM_POR_TURNO',
        responsaveis: 'TODOS', ativo: true, itens: [] };

  const m = adm.modeloEdicao;
  document.getElementById('modelo-titulo').textContent = modelo ? m.nome : 'Novo check-list';
  document.getElementById('modelo-nome').value = m.nome;
  document.getElementById('modelo-descricao').value = m.descricao;
  document.getElementById('modelo-setor').value = m.setor;
  document.getElementById('modelo-frequencia').value = m.frequencia || 'DIARIA';
  document.getElementById('modelo-turnos').value = m.turnos.join(',');
  document.getElementById('modelo-repeticao').value = m.repeticao || 'LIVRE';
  document.getElementById('modelo-ativo').checked = m.ativo;
  document.getElementById('modelo-erro').classList.add('oculto');

  renderizarHorarios();
  renderizarResponsaveis();
  renderizarItensAdm();
  irPara('tela-modelo');
}

/** Um campo de hora por turno, na mesma ordem em que os turnos foram escritos. */
function renderizarHorarios() {
  const alvo = document.getElementById('modelo-horarios');
  const turnos = document.getElementById('modelo-turnos').value
    .split(',').map(t => t.trim().toUpperCase()).filter(Boolean);

  alvo.innerHTML = '';
  if (!turnos.length) {
    alvo.innerHTML = '<p class="vazio">Informe os turnos acima.</p>';
    return;
  }

  turnos.forEach((turno, indice) => {
    const linha = document.createElement('div');
    linha.className = 'linha-horario';

    const rotulo = document.createElement('span');
    rotulo.textContent = turno;

    const campo = document.createElement('input');
    campo.type = 'time';
    campo.className = 'campo';
    campo.value = (adm.modeloEdicao.horarios || [])[indice] || '';
    campo.addEventListener('input', () => {
      const horarios = (adm.modeloEdicao.horarios || []).slice();
      horarios[indice] = campo.value;
      adm.modeloEdicao.horarios = horarios;
    });

    linha.append(rotulo, campo);
    alvo.appendChild(linha);
  });
}

/**
 * "Todos" e a lista de pessoas são o mesmo controle, não dois independentes:
 * marcar alguém individualmente já significa sair do "todos", e desmarcar o
 * último volta para "todos". Sem isso, dava para salvar um check-list sem
 * nenhum responsável — que ninguém veria.
 */
function renderizarResponsaveis() {
  const alvo = document.getElementById('modelo-responsaveis');
  const atuais = String(adm.modeloEdicao.responsaveis || 'TODOS').trim();
  const todos = !atuais || atuais.toUpperCase() === 'TODOS';
  const escolhidos = todos ? [] : atuais.split(',').map(e => e.trim().toLowerCase());

  alvo.innerHTML = '';

  alvo.appendChild(criarMarcavel('Todos os usuários', todos, () => {
    adm.modeloEdicao.responsaveis = 'TODOS';
    renderizarResponsaveis();
  }));

  adm.usuarios.filter(u => u.ativo).forEach(usuario => {
    alvo.appendChild(criarMarcavel(
      usuario.nome + ' — ' + usuario.email,
      escolhidos.includes(usuario.email),
      marcado => {
        const lista = new Set(escolhidos);
        if (marcado) lista.add(usuario.email); else lista.delete(usuario.email);
        adm.modeloEdicao.responsaveis = [...lista].join(',') || 'TODOS';
        renderizarResponsaveis();
      }));
  });
}

function renderizarItensAdm() {
  const alvo = document.getElementById('lista-itens-adm');
  alvo.innerHTML = '';
  const itens = adm.modeloEdicao.itens;

  if (!itens.length) {
    alvo.innerHTML = '<p class="vazio">Nenhuma pergunta ainda. Toque em "Adicionar pergunta".</p>';
    return;
  }

  itens.forEach((item, indice) => {
    const linha = document.createElement('div');
    linha.className = 'registro';

    const texto = document.createElement('div');
    texto.className = 'registro-texto';
    const titulo = document.createElement('strong');
    titulo.textContent = item.pergunta || '(sem pergunta)';
    const detalhe = document.createElement('small');
    detalhe.textContent = (item.local || 'Geral') + ' · ' + rotuloTipo(item.tipo) +
      (item.obrigatorio ? ' · obrigatória' : '') + (exigeFoto(item) ? ' · com foto' : '');
    texto.appendChild(titulo);
    texto.appendChild(detalhe);
    texto.addEventListener('click', () => abrirItem(item, indice));

    const acoes = document.createElement('div');
    acoes.className = 'registro-acoes';
    acoes.appendChild(botaoAcao('↑', 'Mover para cima', () => moverItem(indice, -1), indice === 0));
    acoes.appendChild(botaoAcao('↓', 'Mover para baixo', () => moverItem(indice, 1), indice === itens.length - 1));
    acoes.appendChild(botaoAcao('✕', 'Remover', () => removerItem(indice), false, true));

    linha.appendChild(texto);
    linha.appendChild(acoes);
    alvo.appendChild(linha);
  });
}

function moverItem(indice, direcao) {
  const itens = adm.modeloEdicao.itens;
  const destino = indice + direcao;
  if (destino < 0 || destino >= itens.length) return;
  [itens[indice], itens[destino]] = [itens[destino], itens[indice]];
  renderizarItensAdm();
}

function removerItem(indice) {
  const item = adm.modeloEdicao.itens[indice];
  if (!confirm('Remover a pergunta "' + (item.pergunta || 'sem título') + '"?\n\n' +
               'Os registros já feitos não são afetados.')) return;
  adm.modeloEdicao.itens.splice(indice, 1);
  renderizarItensAdm();
}

async function salvarModelo() {
  const erro = document.getElementById('modelo-erro');
  const m = adm.modeloEdicao;

  m.nome = document.getElementById('modelo-nome').value.trim();
  m.descricao = document.getElementById('modelo-descricao').value.trim();
  m.setor = document.getElementById('modelo-setor').value.trim();
  m.frequencia = document.getElementById('modelo-frequencia').value;
  m.turnos = document.getElementById('modelo-turnos').value
    .split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  m.repeticao = document.getElementById('modelo-repeticao').value;
  m.horarios = (m.horarios || []).slice(0, m.turnos.length);
  m.ativo = document.getElementById('modelo-ativo').checked;

  if (!m.nome) return mostrarErro(erro, 'Informe o nome do check-list.');
  if (!m.turnos.length) return mostrarErro(erro, 'Informe ao menos um turno.');
  if (!m.itens.length) return mostrarErro(erro, 'Adicione ao menos uma pergunta.');

  const semPergunta = m.itens.find(i => !String(i.pergunta || '').trim());
  if (semPergunta) return mostrarErro(erro, 'Há uma pergunta sem texto. Abra e complete.');

  const botao = document.getElementById('btn-salvar-modelo');
  botao.disabled = true;
  botao.textContent = 'Salvando...';

  try {
    if (!(await renovarToken())) throw new Error('Sessão expirada. Entre novamente.');

    // Cabeçalho primeiro: um check-list novo só ganha ID aqui.
    const retorno = await chamarApi('admSalvarModelo', {
      idToken: estado.token.valor,
      modelo: {
        modeloId: m.modeloId, nome: m.nome, descricao: m.descricao, setor: m.setor,
        frequencia: m.frequencia, turnos: m.turnos.join(','),
        horarios: (m.horarios || []).map(h => h || '').join(','),
        repeticao: m.repeticao,
        responsaveis: m.responsaveis, ativo: m.ativo
      }
    });

    await chamarApi('admSalvarItens', {
      idToken: estado.token.valor,
      modeloId: retorno.modeloId,
      itens: m.itens
    });

    mostrarToast('Check-list salvo', 'sucesso');
    await abrirAdmin();
    trocarAba('painel-modelos');
    await carregarModelos();   // o operador deste aparelho já vê a mudança
  } catch (e) {
    mostrarErro(erro, e.message);
  } finally {
    botao.disabled = false;
    botao.textContent = 'Salvar check-list';
  }
}

/* ---------- perguntas ---------- */

function abrirItem(item, indice) {
  adm.indiceItem = indice;
  adm.itemEdicao = item
    ? JSON.parse(JSON.stringify(item))
    : { itemId: '', local: 'Geral', pergunta: '', tipo: 'NUMERO', unidade: '',
        minimo: null, maximo: null, respostaEsperada: '', opcoes: [],
        obrigatorio: true, exigeFoto: false, ativo: true };

  const i = adm.itemEdicao;
  document.getElementById('item-titulo').textContent = item ? 'Editar pergunta' : 'Nova pergunta';
  document.getElementById('item-pergunta').value = i.pergunta;
  document.getElementById('item-local').value = i.local;
  document.getElementById('item-tipo').value = i.tipo;
  document.getElementById('item-unidade').value = i.unidade;
  document.getElementById('item-minimo').value = i.minimo === null ? '' : i.minimo;
  document.getElementById('item-maximo').value = i.maximo === null ? '' : i.maximo;
  document.getElementById('item-opcoes').value = (i.opcoes || []).join('\n');
  document.getElementById('item-obrigatorio').checked = i.obrigatorio;
  document.getElementById('item-exige-foto').checked = i.exigeFoto;
  document.getElementById('item-esperada-simnao').value =
    ['SIM', 'NAO', ''].includes(i.respostaEsperada) ? i.respostaEsperada : 'SIM';
  document.getElementById('item-esperada-lista').value =
    i.tipo === 'LISTA' ? i.respostaEsperada : '';
  document.getElementById('item-regra-data').value =
    ['FUTURA', 'PASSADA'].includes(i.respostaEsperada) ? i.respostaEsperada : '';
  document.getElementById('item-erro').classList.add('oculto');

  // Sugere as áreas já usadas neste check-list.
  const lista = document.getElementById('locais-usados');
  lista.innerHTML = '';
  [...new Set(adm.modeloEdicao.itens.map(x => x.local).filter(Boolean))].forEach(local => {
    const opcao = document.createElement('option');
    opcao.value = local;
    lista.appendChild(opcao);
  });

  alternarCamposDoTipo();
  irPara('tela-item');
}

/** Mostra só os campos que fazem sentido para o tipo escolhido. */
function alternarCamposDoTipo() {
  const tipo = document.getElementById('item-tipo').value;
  const mostrar = (id, condicao) =>
    document.getElementById(id).classList.toggle('oculto', !condicao);

  mostrar('campos-numero', tipo === 'NUMERO' || tipo === 'CONTAGEM');
  mostrar('campos-simnao', tipo === 'SIM_NAO');
  mostrar('campos-lista', tipo === 'LISTA');
  mostrar('campos-data', tipo === 'DATA');
  // No tipo FOTO a foto é a resposta: a marcação seria redundante.
  mostrar('rotulo-exige-foto', tipo !== 'FOTO');
}

function salvarItem() {
  const erro = document.getElementById('item-erro');
  const i = adm.itemEdicao;

  i.pergunta = document.getElementById('item-pergunta').value.trim();
  i.local = document.getElementById('item-local').value.trim() || 'Geral';
  i.tipo = document.getElementById('item-tipo').value;
  i.obrigatorio = document.getElementById('item-obrigatorio').checked;
  i.exigeFoto = i.tipo === 'FOTO' ? true : document.getElementById('item-exige-foto').checked;

  if (!i.pergunta) return mostrarErro(erro, 'Escreva a pergunta.');

  const numero = valor => valor.trim() === '' ? null : Number(valor);
  i.unidade = '';
  i.minimo = null;
  i.maximo = null;
  i.respostaEsperada = '';
  i.opcoes = [];

  if (i.tipo === 'NUMERO' || i.tipo === 'CONTAGEM') {
    i.unidade = document.getElementById('item-unidade').value.trim();
    i.minimo = numero(document.getElementById('item-minimo').value);
    i.maximo = numero(document.getElementById('item-maximo').value);
    if (i.minimo !== null && i.maximo !== null && i.minimo > i.maximo) {
      return mostrarErro(erro, 'O mínimo não pode ser maior que o máximo.');
    }
  } else if (i.tipo === 'SIM_NAO') {
    i.respostaEsperada = document.getElementById('item-esperada-simnao').value;
  } else if (i.tipo === 'LISTA') {
    i.opcoes = document.getElementById('item-opcoes').value
      .split('\n').map(o => o.trim()).filter(Boolean);
    if (i.opcoes.length < 2) return mostrarErro(erro, 'Cadastre ao menos duas opções.');
    i.respostaEsperada = document.getElementById('item-esperada-lista').value.trim().toUpperCase();

    const validas = i.opcoes.map(o => o.toUpperCase());
    const invalida = i.respostaEsperada.split('|').map(e => e.trim()).filter(Boolean)
      .find(e => !validas.includes(e));
    if (invalida) return mostrarErro(erro, '"' + invalida + '" não está entre as opções cadastradas.');
  } else if (i.tipo === 'DATA') {
    i.respostaEsperada = document.getElementById('item-regra-data').value;
  }

  if (adm.indiceItem >= 0) adm.modeloEdicao.itens[adm.indiceItem] = i;
  else adm.modeloEdicao.itens.push(i);

  renderizarItensAdm();
  irPara('tela-modelo');
}

/* ---------- peças reutilizadas ---------- */

function criarRegistro(titulo, detalhe, marca, classeMarca) {
  const linha = document.createElement('div');
  linha.className = 'registro clicavel';

  const texto = document.createElement('div');
  texto.className = 'registro-texto';
  const forte = document.createElement('strong');
  forte.textContent = titulo;
  const pequeno = document.createElement('small');
  pequeno.textContent = detalhe;
  texto.appendChild(forte);
  texto.appendChild(pequeno);
  linha.appendChild(texto);

  if (marca) {
    const etiqueta = document.createElement('span');
    etiqueta.className = 'marca ' + (classeMarca || '');
    etiqueta.textContent = marca;
    linha.appendChild(etiqueta);
  }
  return linha;
}

function criarMarcavel(texto, marcado, aoMudar) {
  const rotulo = document.createElement('label');
  rotulo.className = 'marcavel';
  const caixa = document.createElement('input');
  caixa.type = 'checkbox';
  caixa.checked = marcado;
  caixa.addEventListener('change', () => aoMudar(caixa.checked));
  const span = document.createElement('span');
  span.textContent = texto;
  rotulo.appendChild(caixa);
  rotulo.appendChild(span);
  return rotulo;
}

function botaoAcao(simbolo, descricao, aoClicar, desabilitado, perigo) {
  const botao = document.createElement('button');
  botao.type = 'button';
  botao.className = 'botao-acao' + (perigo ? ' perigo' : '');
  botao.textContent = simbolo;
  botao.setAttribute('aria-label', descricao);
  botao.disabled = !!desabilitado;
  botao.addEventListener('click', aoClicar);
  return botao;
}

function rotuloTipo(tipo) {
  return {
    NUMERO: 'número', SIM_NAO: 'sim/não', LISTA: 'lista',
    CONTAGEM: 'contagem', TEXTO: 'texto', FOTO: 'foto', DATA: 'data'
  }[tipo] || tipo;
}

function mostrarErro(elemento, mensagem) {
  elemento.textContent = mensagem;
  elemento.classList.remove('oculto');
  elemento.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ==========================================================================
   8c. PAINEL DO DIA
   ========================================================================== */

async function abrirPainel() {
  if (!navigator.onLine) return mostrarToast('O painel do dia precisa de internet.', 'falha');
  if (!(await renovarToken())) return mostrarToast('Sessão expirada. Entre novamente.', 'falha');

  try {
    await carregarModelos();
    document.getElementById('painel-data').textContent =
      new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });
    renderizarPainelDoDia(await execucoesDeHoje());
    irPara('tela-painel');
  } catch (erro) {
    mostrarToast(erro.message, 'falha');
  }
}

function renderizarPainelDoDia(feitasHoje) {
  const linhas = [];
  const agora = formatarHora(new Date());

  estado.modelos.forEach(modelo => {
    (modelo.turnos.length ? modelo.turnos : ['ÚNICO']).forEach((turno, indice) => {
      const feita = feitasHoje.find(e => e.modeloId === modelo.modeloId && e.turno === turno);
      const limite = (modelo.horarios || [])[indice] || '';
      linhas.push({
        modelo: modelo.nome,
        setor: modelo.setor,
        turno: turno,
        limite: limite,
        feita: feita || null,
        atrasada: !feita && limite && agora > limite
      });
    });
  });

  const feitas = linhas.filter(l => l.feita).length;
  const atrasadas = linhas.filter(l => l.atrasada).length;

  document.getElementById('painel-numeros').innerHTML = '';
  document.getElementById('painel-numeros').append(
    cartaoNumero('Realizados', feitas + ' de ' + linhas.length, 'bom'),
    cartaoNumero('Pendentes', String(linhas.length - feitas), linhas.length - feitas ? 'atencao' : 'bom'),
    cartaoNumero('Atrasados', String(atrasadas), atrasadas ? 'ruim' : 'bom')
  );

  const alvo = document.getElementById('painel-lista');
  alvo.innerHTML = '';
  if (!linhas.length) {
    alvo.innerHTML = '<p class="vazio">Nenhum check-list ativo.</p>';
    return;
  }

  // Atrasados no topo, depois pendentes, e o que já foi feito por último —
  // a ordem da lista é a ordem de quem precisa de atenção.
  const prioridade = l => l.atrasada ? 0 : (l.feita ? 2 : 1);
  linhas.sort((a, b) => prioridade(a) - prioridade(b));

  linhas.forEach(linha => {
    const detalhe = linha.feita
      ? (linha.feita.nome || linha.feita.email) +
        (linha.feita.fimEm ? ' · ' + formatarHora(new Date(linha.feita.fimEm)) : '') +
        (linha.feita.naoConformidades ? ' · ' + linha.feita.naoConformidades + ' não conf.' : '')
      : (linha.limite ? 'Limite ' + linha.limite : 'Sem horário limite');

    const marca = linha.feita
      ? (linha.feita.naoConformidades ? 'Não conforme' : 'Feito')
      : (linha.atrasada ? 'Atrasado' : 'Pendente');

    const classe = linha.feita
      ? (linha.feita.naoConformidades ? 'erro' : 'enviada')
      : (linha.atrasada ? 'erro' : 'pendente');

    alvo.appendChild(criarRegistro(
      linha.modelo + ' · ' + linha.turno,
      [linha.setor, detalhe].filter(Boolean).join(' · '),
      marca, classe));
  });
}

/* ==========================================================================
   8d. INDICADORES
   ========================================================================== */

async function abrirDashboard(dias) {
  if (!navigator.onLine) return mostrarToast('Os indicadores precisam de internet.', 'falha');
  if (!(await renovarToken())) return mostrarToast('Sessão expirada. Entre novamente.', 'falha');

  irPara('tela-dashboard');
  document.getElementById('dash-carregando').classList.remove('oculto');
  document.getElementById('dash-conteudo').classList.add('oculto');

  try {
    const resumo = await chamarApi('admResumo', { idToken: estado.token.valor, dias: dias });
    renderizarDashboard(resumo);
    document.getElementById('dash-carregando').classList.add('oculto');
    document.getElementById('dash-conteudo').classList.remove('oculto');
  } catch (erro) {
    document.getElementById('dash-carregando').textContent = erro.message;
  }
}

function renderizarDashboard(resumo) {
  const g = resumo.geral;
  document.getElementById('dash-periodo-rotulo').textContent = 'Últimos ' + resumo.dias + ' dias';

  const numeros = document.getElementById('dash-numeros');
  numeros.innerHTML = '';
  numeros.append(
    cartaoNumero('Conformidade', g.percentualConformidade + '%',
      g.percentualConformidade >= 95 ? 'bom' : g.percentualConformidade >= 85 ? 'atencao' : 'ruim'),
    cartaoNumero('Check-lists', String(g.execucoes)),
    cartaoNumero('Não conformes', String(g.naoConformes), g.naoConformes ? 'atencao' : 'bom'),
    cartaoNumero('Duração média', g.duracaoMediaMin + ' min'),
    cartaoNumero('Pontualidade',
      g.pontualidade.percentual === null ? '—' : g.pontualidade.percentual + '%',
      g.pontualidade.percentual === null ? '' :
        g.pontualidade.percentual >= 90 ? 'bom' : 'atencao'),
    cartaoNumero('Preenchidos em < 1 min', String(g.execucoesRelampago),
      g.execucoesRelampago ? 'ruim' : 'bom')
  );

  // Séries numéricas
  const seletor = document.getElementById('dash-serie-seletor');
  seletor.innerHTML = '';
  resumo.series.forEach((serie, indice) => {
    const opcao = document.createElement('option');
    opcao.value = String(indice);
    opcao.textContent = serie.rotulo;
    seletor.appendChild(opcao);
  });
  seletor.classList.toggle('oculto', !resumo.series.length);
  seletor.onchange = () => desenharSerie(resumo.series[Number(seletor.value)]);
  desenharSerie(resumo.series[0]);

  desenharBarras('dash-aderencia', resumo.aderencia.map(a => ({
    rotulo: a.nome,
    valor: a.percentual,
    texto: a.realizado + '/' + a.esperado + ' · ' + a.percentual + '%',
    estado: a.percentual >= 95 ? 'bom' : a.percentual >= 70 ? 'atencao' : 'ruim'
  })), 100);

  const maiorLocal = Math.max(1, ...resumo.naoConformidadesPorLocal.map(n => n.total));
  desenharBarras('dash-nc-local', resumo.naoConformidadesPorLocal.map(n => ({
    rotulo: n.rotulo, valor: n.total, texto: String(n.total), estado: 'ruim'
  })), maiorLocal);

  const maiorItem = Math.max(1, ...resumo.reincidencia.map(n => n.total));
  desenharBarras('dash-reincidencia', resumo.reincidencia.map(n => ({
    rotulo: n.rotulo, valor: n.total, texto: String(n.total), estado: 'ruim'
  })), maiorItem);

  const operadores = document.getElementById('dash-operadores');
  operadores.innerHTML = '';
  if (!resumo.operadores.length) {
    operadores.innerHTML = '<p class="vazio">Sem registros no período.</p>';
  }
  resumo.operadores.forEach(o => {
    operadores.appendChild(criarRegistro(
      o.nome,
      o.execucoes + ' check-list(s) · ' + o.naoConformidades + ' não conformidade(s)',
      String(o.execucoes), 'ativa'));
  });
}

/** Gráfico de barras horizontais — legível no celular, sem biblioteca externa. */
function desenharBarras(idAlvo, dados, maximo) {
  const alvo = document.getElementById(idAlvo);
  alvo.innerHTML = '';

  if (!dados.length) {
    alvo.innerHTML = '<p class="vazio">Sem dados no período.</p>';
    return;
  }

  dados.forEach(dado => {
    const linha = document.createElement('div');
    linha.className = 'barra-linha';

    const topo = document.createElement('div');
    topo.className = 'barra-topo';
    const rotulo = document.createElement('span');
    rotulo.textContent = dado.rotulo;
    const texto = document.createElement('strong');
    texto.textContent = dado.texto;
    topo.append(rotulo, texto);

    const trilho = document.createElement('div');
    trilho.className = 'barra-trilho';
    const preenchida = document.createElement('div');
    preenchida.className = 'barra ' + (dado.estado || '');
    preenchida.style.width = Math.min(100, dado.valor / maximo * 100) + '%';
    trilho.appendChild(preenchida);

    linha.append(topo, trilho);
    alvo.appendChild(linha);
  });
}

/**
 * Série temporal em SVG puro. A faixa aceitável entra como uma banda de fundo:
 * é o que faz o gráfico responder "está dentro do padrão?" sem ler eixo.
 */
function desenharSerie(serie) {
  const alvo = document.getElementById('dash-serie');
  alvo.innerHTML = '';
  if (!serie || !serie.pontos.length) {
    alvo.innerHTML = '<p class="vazio">Nenhuma medição com faixa definida no período.</p>';
    return;
  }

  const larg = 640, alt = 240, margem = { topo: 16, dir: 12, baixo: 34, esq: 46 };
  const areaL = larg - margem.esq - margem.dir;
  const areaA = alt - margem.topo - margem.baixo;

  const valores = serie.pontos.map(p => p.media)
    .concat(serie.faixaMinima !== null ? [serie.faixaMinima] : [])
    .concat(serie.faixaMaxima !== null ? [serie.faixaMaxima] : []);
  let min = Math.min(...valores), max = Math.max(...valores);
  const folga = (max - min) * 0.15 || 1;
  min -= folga; max += folga;

  const x = i => margem.esq + (serie.pontos.length === 1
    ? areaL / 2
    : i / (serie.pontos.length - 1) * areaL);
  const y = v => margem.topo + areaA - (v - min) / (max - min) * areaA;

  const partes = [];

  if (serie.faixaMinima !== null && serie.faixaMaxima !== null) {
    const topo = y(serie.faixaMaxima);
    partes.push('<rect x="' + margem.esq + '" y="' + topo + '" width="' + areaL +
      '" height="' + (y(serie.faixaMinima) - topo) + '" class="faixa-ok"/>');
  }

  partes.push('<line x1="' + margem.esq + '" y1="' + (margem.topo + areaA) +
    '" x2="' + (larg - margem.dir) + '" y2="' + (margem.topo + areaA) + '" class="eixo"/>');

  [min + folga, max - folga].forEach(valor => {
    partes.push('<text x="' + (margem.esq - 8) + '" y="' + (y(valor) + 4) +
      '" class="eixo-texto" text-anchor="end">' + Math.round(valor * 10) / 10 + '</text>');
  });

  const caminho = serie.pontos.map((p, i) => (i ? 'L' : 'M') + x(i) + ' ' + y(p.media)).join(' ');
  partes.push('<path d="' + caminho + '" class="linha-serie"/>');

  serie.pontos.forEach((p, i) => {
    const fora = (serie.faixaMinima !== null && p.media < serie.faixaMinima) ||
                 (serie.faixaMaxima !== null && p.media > serie.faixaMaxima);
    partes.push('<circle cx="' + x(i) + '" cy="' + y(p.media) + '" r="4" class="ponto' +
      (fora ? ' fora' : '') + '"><title>' + p.dia + ': ' + p.media + ' ' +
      serie.unidade + ' (' + p.leituras + ' leituras)</title></circle>');
  });

  [0, serie.pontos.length - 1].forEach(i => {
    if (i < 0) return;
    partes.push('<text x="' + x(i) + '" y="' + (alt - 10) + '" class="eixo-texto" text-anchor="' +
      (i === 0 ? 'start' : 'end') + '">' + serie.pontos[i].dia.slice(5).split('-').reverse().join('/') +
      '</text>');
  });

  alvo.innerHTML = '<svg viewBox="0 0 ' + larg + ' ' + alt + '" class="svg-serie" ' +
    'role="img" aria-label="Medições de ' + serie.rotulo + '">' + partes.join('') + '</svg>' +
    '<p class="dica">Faixa aceitável: ' +
    (serie.faixaMinima !== null ? serie.faixaMinima : '—') + ' a ' +
    (serie.faixaMaxima !== null ? serie.faixaMaxima : '—') + ' ' + serie.unidade + '</p>';
}

function cartaoNumero(rotulo, valor, estadoCor) {
  const cartao = document.createElement('div');
  cartao.className = 'cartao-numero ' + (estadoCor || '');
  const forte = document.createElement('strong');
  forte.textContent = valor;
  const span = document.createElement('span');
  span.textContent = rotulo;
  cartao.append(forte, span);
  return cartao;
}

/* ==========================================================================
   9. NAVEGAÇÃO E UTILITÁRIOS
   ========================================================================== */

function irPara(idTela) {
  document.querySelectorAll('.tela').forEach(tela => tela.classList.remove('ativa'));
  document.getElementById(idTela).classList.add('ativa');
  window.scrollTo(0, 0);

  if (idTela === 'tela-inicio' && estado.usuario) {
    document.getElementById('cabecalho-usuario').textContent =
      estado.usuario.nome + (estado.usuario.perfil === 'ADMIN' ? ' · admin' : '');
    // Os botões somem para quem não é ADMIN, mas quem protege é o servidor.
    document.getElementById('area-admin')
      .classList.toggle('oculto', estado.usuario.perfil !== 'ADMIN');
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

/** HH:MM em 24h — no mesmo formato do horário limite, para poder comparar. */
function formatarHora(data) {
  return String(data.getHours()).padStart(2, '0') + ':' +
         String(data.getMinutes()).padStart(2, '0');
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

  // O que foi feito hoje só vale se o cache for de hoje mesmo.
  const hojeEmCache = await BD.obter('hoje');
  estado.hoje = (hojeEmCache && hojeEmCache.data === dataDeHoje()) ? hojeEmCache.execucoes : [];

  document.getElementById('btn-sincronizar').addEventListener('click', () => sincronizar(true));
  document.getElementById('btn-sair').addEventListener('click', sair);
  document.getElementById('btn-voltar').addEventListener('click', () => {
    if (confirm('Sair sem concluir? As respostas deste check-list serão perdidas.')) {
      estado.execucaoAtual = null;
      irPara('tela-inicio');
    }
  });
  document.getElementById('btn-concluir').addEventListener('click', concluirExecucao);

  // --- administração ---
  document.getElementById('btn-admin').addEventListener('click', abrirAdmin);
  document.getElementById('btn-adm-voltar').addEventListener('click', () => irPara('tela-inicio'));
  document.querySelectorAll('.aba').forEach(aba => {
    aba.addEventListener('click', () => trocarAba(aba.dataset.painel));
  });

  document.getElementById('btn-novo-usuario').addEventListener('click', () => abrirUsuario(null));
  document.getElementById('btn-usuario-voltar').addEventListener('click', () => irPara('tela-admin'));
  document.getElementById('btn-salvar-usuario').addEventListener('click', salvarUsuario);

  document.getElementById('btn-novo-modelo').addEventListener('click', () => abrirModelo(null));
  document.getElementById('btn-modelo-voltar').addEventListener('click', () => irPara('tela-admin'));
  document.getElementById('btn-salvar-modelo').addEventListener('click', salvarModelo);
  document.getElementById('btn-nova-pergunta').addEventListener('click', () => abrirItem(null, -1));

  document.getElementById('btn-item-voltar').addEventListener('click', () => irPara('tela-modelo'));
  document.getElementById('btn-salvar-item').addEventListener('click', salvarItem);
  document.getElementById('item-tipo').addEventListener('change', alternarCamposDoTipo);
  document.getElementById('modelo-turnos').addEventListener('input', renderizarHorarios);

  // --- painel do dia e indicadores ---
  document.getElementById('btn-painel').addEventListener('click', abrirPainel);
  document.getElementById('btn-painel-voltar').addEventListener('click', () => irPara('tela-inicio'));
  document.getElementById('btn-painel-atualizar').addEventListener('click', abrirPainel);

  document.getElementById('btn-dashboard').addEventListener('click', () => abrirDashboard(30));
  document.getElementById('btn-dash-voltar').addEventListener('click', () => irPara('tela-inicio'));
  document.querySelectorAll('.aba-periodo').forEach(aba => {
    aba.addEventListener('click', () => {
      document.querySelectorAll('.aba-periodo').forEach(a => a.classList.remove('ativa'));
      aba.classList.add('ativa');
      abrirDashboard(Number(aba.dataset.dias));
    });
  });

  window.addEventListener('online', () => { atualizarFaixaConexao(); sincronizar(); });
  window.addEventListener('offline', atualizarFaixaConexao);
  atualizarFaixaConexao();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app funciona sem SW */ });
  }

  // Sessão já existente: entra direto, mesmo sem rede.
  if (estado.usuario) {
    await renderizarModelos();
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
