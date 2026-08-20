const DATASTONE_BASE = "https://api.datastone.com.br/v1";

// Janela em que faz sentido esperar o webhook antes de desistir.
const JANELA_ESPERA_S = 900; // 15 min
// Retencao curta: o payload traz CPF de socios/administradores.
const RETENCAO_RESULTADO_S = 3600; // 1 h
// O registro (id_processamento, tipo, chave) nao tem dado pessoal, entao vive muito
// mais que o resultado. Um disparo pago nunca deve virar "id desconhecido" so porque
// o mapa sumiu: sem o registro, o credito e perdido em silencio.
const RETENCAO_REGISTRO_S = 7 * 24 * 3600; // 7 dias
// Espacamento entre chamadas a API (evita rate limit ~10 chamadas e bloqueio anti-abuso).
const PACING_MS = 11000;
// HTTP APIs do API Gateway encerram a integracao em no maximo 30 s. Reservamos no
// maximo 15 s para ainda haver tempo para a chamada externa devolver uma resposta.
// Acima disso a vaga e RECUSADA (nao reservada) e o cliente recebe a instrucao de esperar.
const TETO_FILA_MS = 15000;
// Retencao do log de disparos e de chegadas de webhook. So metadado (id, tipo, instante),
// sem dado pessoal, entao acompanha o registro e nao o resultado.
const RETENCAO_LOG_S = 7 * 24 * 3600;
// Teto de tamanho da resposta de listar_filtros: acima disso estoura o contexto do cliente.
const LIMITE_RESPOSTA_CHARS = 60000;

const SENIORIDADES_VALIDAS = ["Júnior", "Pleno", "Sênior", "Decisores"];
const CAMPOS_CNPJ_PROIBIDOS = ["cnpj", "cnpjs", "id_empresa", "ids_empresa"];
// Campos que datastone_buscar_empresa aceita direto na raiz dos argumentos e tambem
// dentro de filtros_empresa; o servidor mescla os dois antes de chamar a API.
const CAMPOS_EMPRESA = [
  "nome_empresa",
  "setores",
  "estados",
  "localizacoes",
  "especialidades",
  "setores_cnae",
  "faixa_receita",
  "atividades_cnae",
];

const TOOL_DEFINITIONS = [
  {
    name: "datastone_consultar_empresa",
    description:
      "Consulta SINCRONA de dados cadastrais de empresa por CNPJ (razao social, socios, administradores, faturamento, telefones, e-mails, CNAE). Retorna na hora. " +
      "BASE CADASTRAL (Receita): NAO tem cargos executivos (diretor/gerente). Para cargos use datastone_buscar_pessoas. " +
      "CARTEIRA: B2C (secao 'Consulta' da API) — carteira SEPARADA do B2B. Se o saldo B2C estiver zerado esta ferramenta responde insufficient_credits " +
      "mesmo com centenas de creditos B2B sobrando. Confira antes com datastone_saldo (custo 0). " +
      "ALTERNATIVA SEM B2C: para chegar aos dados da empresa gastando so B2B, resolva o id_empresa com datastone_buscar_empresa {document:'<cnpj>'} e enriqueca com datastone_enrich_iniciar. " +
      "CUSTO: 1 credito B2C por consulta que retorne resultado; erro ou vazio nao debita.",
    inputSchema: {
      type: "object",
      properties: {
        cnpj: { type: "string", description: "CNPJ, apenas numeros (14 digitos)." },
        fields: { type: "string", description: "Opcional. Campos separados por virgula." },
      },
      required: ["cnpj"],
    },
  },
  {
    name: "datastone_buscar_empresa",
    description:
      "Busca EMPRESAS por nome/setor/regiao/porte, ou resolve um CNPJ conhecido em id_empresa via 'document'. CARTEIRA: B2B. " +
      "RESOLVER CNPJ -> id_empresa: passe document='<cnpj com ou sem formatacao>' (ou url_linkedin='<url do perfil>') como parametro de PRIMEIRO NIVEL, nunca dentro de filtros_empresa. " +
      "Esse e o UNICO caminho confiavel de CNPJ para id_empresa, e o id resultante e a entrada de datastone_enrich_iniciar. Com document os demais filtros sao ignorados e a resposta traz id_empresa direto. " +
      "Use SEMPRE que tiver o CNPJ: casar por nome_empresa e heuristico e ja trouxe a empresa errada (busca por 'Engeseg' devolveu pessoas de uma empresa de Engenharia Civil). " +
      "O lookup por document nao debitou credito nas medicoes (saldo B2B igual antes e depois, com e sem resultado); ainda assim confira com datastone_saldo em lotes grandes. " +
      "Quando nao ha empresa para o documento, a API responde 404 — e ha CNPJ valido que simplesmente nao esta na base B2B. " +
      "ATENCAO — a resposta mistura DUAS bases: registros da Receita trazem cnpj + faixa_faturamento + tem_telefone/tem_email, com id_empresa e slug null; " +
      "registros do LinkedIn trazem id_empresa + slug, com cnpj null. Na grande maioria dos casos os dois NAO aparecem juntos (42 registros conferidos, nenhum cruzado), " +
      "mas registros FUNDIDOS EXISTEM — contraexemplo confirmado: 'Ceabs Servicos S.A.', cnpj 14117458000130 E id_empresa 47374982 no mesmo registro. " +
      "O servidor marca esses casos com _registro_fundido. Trate a fusao como PISTA, nao como verdade: no caso conhecido a MESMA empresa voltou tambem como " +
      "registro so-LinkedIn (outro id_empresa, outro slug) e a versao fundida trazia faixa_funcionarios '2-10' para uma empresa de 100+ — a fusao grudou o CNPJ " +
      "num perfil duplicado e magro. Ou seja: esta ferramenta nao e um conversor confiavel de CNPJ para id_empresa. Quando a fusao nao aparece, o unico caminho " +
      "e casar pelo nome_empresa, que tambem e heuristico — confira antes de gastar credito. " +
      "Retorna localizacao, setor, faixa_funcionarios, faixa_faturamento, tem_telefone, tem_email, tem_linkedin, mais cnpj OU id_empresa/slug conforme a base. " +
      "CUSTO (carteira B2B): cobra por COMBINACAO NOVA DE FILTROS, nao por chamada — repetir a mesma busca nao cobra de novo enquanto a chave de cache valer. " +
      "Passe chave_cache ao paginar para garantir a gratuidade. total=0 e erro nao debitam. " +
      "O servidor ordena as listas de filtro alfabeticamente antes de enviar, entao [\"a\",\"b\"] e [\"b\",\"a\"] contam como a MESMA busca e nao geram cobranca dupla.",
    inputSchema: {
      type: "object",
      properties: {
        document: {
          type: "string",
          description:
            "CNPJ conhecido, com ou sem formatacao. Vai no PRIMEIRO NIVEL do corpo (nao em filtros_empresa) e devolve o id_empresa daquele CNPJ. " +
            "Quando presente, todos os outros filtros sao ignorados. 404 = nao existe empresa para esse documento.",
        },
        url_linkedin: {
          type: "string",
          description:
            "URL do perfil da empresa no LinkedIn. Funciona como 'document': resolve o id_empresa e ignora os demais filtros.",
        },
        pagina: { type: "number", description: "Obrigatorio na API; default 1." },
        por_pagina: { type: "number", description: "Obrigatorio na API; maximo 50 (default 50)." },
        chave_cache: {
          type: "string",
          description:
            "Reaproveita a busca anterior e torna a chamada GRATIS. Passe sempre ao paginar. Vale 7 dias.",
        },
        nome_empresa: {
          type: "array",
          items: { type: "string" },
          description:
            'Busca parcial tokenizada. Hifen QUEBRA a busca — use espaco. Ex.: ["Guima Conseco"], nao ["Guima-Conseco"]. ' +
            "Heuristico: se voce tem o CNPJ, prefira 'document'.",
        },
        setores: {
          type: "array",
          items: { type: "string" },
          description: "Setores padrao LinkedIn, em portugues. Valores reais: datastone_listar_filtros com campo='setores'.",
        },
        estados: {
          type: "array",
          items: { type: "string" },
          description: "Siglas (ex.: [\"SP\",\"BA\"]). Nao combine com localizacoes.",
        },
        localizacoes: {
          type: "array",
          items: { type: "string" },
          description: 'Formato "Cidade, UF". Nao combine com estados.',
        },
        especialidades: {
          type: "array",
          items: { type: "string" },
          description: 'Nichos livres, ex.: ["Drogaria","Medicamentos"].',
        },
        setores_cnae: {
          type: "array",
          items: { type: "string" },
          description: 'Macro-setor, ex.: ["COMÉRCIO"], ["INDÚSTRIA"].',
        },
        faixa_receita: {
          type: "object",
          description:
            '{"receita_minima":N,"receita_maxima":N}. Limiar quebrado: minima >= 500000000 zera o resultado. Prefira faixa larga e filtre faixa_faturamento localmente.',
        },
        filtros_empresa: {
          type: "object",
          description:
            "Opcional. Mesmos campos acima em forma de objeto. Pode coexistir com os atalhos — o servidor faz o merge.",
        },
        forcar_campos_quebrados: {
          type: "boolean",
          description:
            "Libera campos sabidamente quebrados (atividades_cnae sempre retorna 0; receita_minima >= 500000000 zera).",
        },
      },
      required: [],
    },
  },
  {
    name: "datastone_buscar_pessoas",
    description:
      "Busca DECISORES e cargos (diretores, gerentes, C-level) na base de pessoas (LinkedIn). E a unica forma de achar cargos executivos. CARTEIRA: B2B. " +
      "IMPORTANTE: esta base NAO aceita filtro por CNPJ — a chave e o NOME da empresa (busca parcial tokenizada; use espaco, nao hifen). " +
      "O nome e heuristico e ERRA: buscar 'Engeseg' devolveu 9 pessoas de uma empresa de Engenharia Civil, nao da ENGESEG Seguranca. " +
      "Para amarrar o resultado a um CNPJ especifico, rode datastone_buscar_empresa com document='<cnpj>' antes, pegue o nome exato daquela empresa e confira setor/localizacao dos resultados — " +
      "nao existe caminho por id: os registros com cnpj vem da base da Receita e os com id_empresa vem do LinkedIn, e quase nunca aparecem juntos " +
      "(existem registros fundidos raros, marcados com _registro_fundido, mas eles podem apontar para um perfil duplicado da empresa — nao confie sem conferir). " +
      "ATENCAO — VINCULOS ENCERRADOS: a base lista como cargo atual gente que ja saiu da empresa (casos reais com 17 anos de defasagem). " +
      "O sinal definitivo e experiencia_profissional[].final != null, mas ele so aparece no payload do enriquecimento, ou seja, depois de gastar. " +
      "Sinal gratuito, confira antes de enriquecer: se o campo 'cargo' menciona OUTRA empresa (ex.: 'Disoc Manager @ Didi/99'), a pessoa ja saiu — descarte. " +
      "Retorna apenas os booleanos tem_email/tem_telefone/tem_linkedin; para liberar o contato use datastone_enriquecer_pessoa. " +
      "CUSTO (carteira B2B): cobra por COMBINACAO NOVA DE FILTROS, nao por chamada — repetir a mesma busca nao cobra de novo enquanto a chave de cache valer. " +
      "Passe chave_cache ao paginar. total=0 e erro nao debitam. O servidor ordena as listas de filtro antes de enviar, entao a ordem dos valores nao gera busca nova.",
    inputSchema: {
      type: "object",
      properties: {
        pagina: { type: "number", description: "Obrigatorio na API; default 1." },
        por_pagina: { type: "number", description: "Obrigatorio na API; maximo 50 (default 50)." },
        chave_cache: {
          type: "string",
          description:
            "Reaproveita a busca anterior e torna a chamada GRATIS. Passe sempre ao paginar. Vale 7 dias.",
        },
        nome_empresa: {
          type: "array",
          items: { type: "string" },
          description: 'Atalho para filtros_empresa.nome_empresa. Ex.: ["Guima Conseco"].',
        },
        niveis_senioridade: {
          type: "array",
          items: { type: "string" },
          description: 'Atalho para filtros_pessoa.niveis_senioridade. Valores: "Júnior", "Pleno", "Sênior", "Decisores".',
        },
        cargos: {
          type: "array",
          items: { type: "string" },
          description: "Atalho para filtros_pessoa.cargos. Valores aceitos: veja datastone_listar_filtros.",
        },
        filtros_empresa: {
          type: "object",
          description:
            "nome_empresa, setores (padrao LinkedIn, em portugues), estados (siglas) e/ou localizacoes ('Cidade, UF' — somam-se, estreitando o resultado). NAO aceita cnpj/id_empresa.",
        },
        filtros_pessoa: {
          type: "object",
          description:
            "cargos, niveis_senioridade, departamentos, nome, tem_email, tem_telefone, tem_linkedin.",
        },
        vinculo_ativo: {
          type: "boolean",
          description:
            "Repassa filtros_pessoa.vinculo_ativo a API para tentar excluir vinculos encerrados. Suporte NAO confirmado: se a API ignorar, a resposta avisa. Use o sinal do campo 'cargo' como conferencia.",
        },
        forcar_campos_quebrados: {
          type: "boolean",
          description:
            "Libera campos sabidamente quebrados (atividades_cnae sempre retorna 0; receita_minima >= 500000000 zera).",
        },
      },
      required: [],
    },
  },
  {
    name: "datastone_enriquecer_pessoa",
    description:
      "Libera o CONTATO de uma pessoa encontrada em datastone_buscar_pessoas (e-mail com status_email, telefone, URL do LinkedIn). CARTEIRA: B2B. " +
      "Aceita id_pessoa (caminho direto), email, cpf ou url_linkedin. E ASSINCRONO: entrega por webhook hospedado neste servidor. " +
      "Retorna id_processamento; recupere com datastone_enrich_resultado. " +
      "CUSTO: 1 credito da carteira B2B por pessoa. Passe tem_email/tem_linkedin vindos da busca — a ferramenta so recusa o alvo quando AMBOS sao false. " +
      "tem_telefone e ignorado na decisao: ele subnotifica (28 pessoas marcadas tem_telefone=false, 4 de 5 enriquecidas voltaram com telefone). " +
      "Antes de gastar, confira se o campo 'cargo' da busca menciona outra empresa — nesse caso a pessoa ja saiu e o credito seria desperdicado.",
    inputSchema: {
      type: "object",
      properties: {
        id_pessoa: { type: "number", description: "ID vindo de datastone_buscar_pessoas." },
        email: { type: "string" },
        cpf: { type: "string" },
        url_linkedin: { type: "string" },
        tem_email: { type: "boolean", description: "Copie da busca. Confiavel: false significa mesmo sem e-mail." },
        tem_telefone: { type: "boolean", description: "Aceito por compatibilidade e IGNORADO na decisao — subnotifica." },
        tem_linkedin: { type: "boolean", description: "Copie da busca. Usado junto com tem_email para evitar gasto inutil." },
        forcar: { type: "boolean", description: "Ignora a protecao contra desperdicio." },
      },
      required: [],
    },
  },
  {
    name: "datastone_enrich_iniciar",
    description:
      "Inicia o ENRIQUECIMENTO COMPLETO de uma EMPRESA (razao social, faixa de faturamento, site, contatos corporativos, LinkedIn, geolocalizacao, CPF real dos socios). CARTEIRA: B2B. " +
      "ENTRADA PREFERIDA: id_empresa, vindo de datastone_buscar_empresa. Se voce passar so cnpj, o servidor resolve o id_empresa sozinho (via document) antes de disparar, " +
      "que e a forma documentada de amarrar os dois lados. " +
      "AVISO MEDIDO: mesmo com o id_empresa correto o payload pode voltar com detalhes_contato: null e sucesso 1 / falhou 0 — cobrado, sem estorno automatico. " +
      "Verificado no CNPJ 14117458000130 com o id_empresa 47374982 resolvido por document: a API confirmou tipo_entrada 'company_id' e ainda assim nao devolveu contato. " +
      "Ou seja, o vazio nao vem de erro de chamada. Confira o saldo com datastone_saldo antes e depois, e nao repita o mesmo alvo esperando resultado diferente. " +
      "E ASSINCRONO e entrega EXCLUSIVAMENTE por webhook — este servidor hospeda o receptor, o cliente nao precisa de porta nem tunel. " +
      "Retorna id_processamento; recupere com datastone_enrich_resultado. " +
      "CUSTO: 1 credito B2B por disparo aceito. A resolucao interna do CNPJ nao debitou credito nas medicoes, entao passar cnpj sai igual a passar id_empresa. " +
      "Rejeicao de preflight do webhook e 404 na resolucao nao debitam o enrich.",
    inputSchema: {
      type: "object",
      properties: {
        id_empresa: {
          type: "number",
          description:
            "PREFERIDO. ID interno da empresa, de datastone_buscar_empresa (por filtros ou por document).",
        },
        cnpj: {
          type: "string",
          description:
            "CNPJ com ou sem formatacao. Sem id_empresa, o servidor o converte internamente antes de disparar.",
        },
        url_linkedin: { type: "string", description: "URL do LinkedIn da empresa. Tambem serve para resolver o id_empresa." },
        nao_resolver: {
          type: "boolean",
          description:
            "Desliga a resolucao automatica de CNPJ para id_empresa e dispara com o CNPJ cru (comportamento antigo, que voltou vazio nos testes).",
        },
      },
      required: [],
    },
  },
  {
    name: "datastone_enrich_empresas_lote",
    description:
      "Enriquece VARIAS empresas numa unica chamada (POST /b2b/companies/enrich/bulk). CARTEIRA: B2B, 1 credito POR EMPRESA aceita. " +
      "Mesma entrega assincrona por webhook das demais: devolve um id_processamento e o resultado sai em datastone_enrich_resultado. " +
      "Cada item aceita id_empresa (preferido), cnpj ou url_linkedin; itens so com cnpj sao resolvidos para id_empresa antes do disparo. " +
      "ATENCAO — o formato do corpo em lote nao esta detalhado na documentacao publica: se a API recusar (HTTP 400), nada e debitado, e o caminho seguro e " +
      "chamar datastone_enrich_iniciar uma vez por empresa. Confira o saldo com datastone_saldo antes e depois do lote. " +
      "O resultado traz 'falhou': registros que falham sao estornados automaticamente.",
    inputSchema: {
      type: "object",
      properties: {
        empresas: {
          type: "array",
          description:
            'Lista de alvos. Ex.: [{"id_empresa":44235793},{"cnpj":"64545866000160"}]. Maximo 50 por chamada.',
          items: {
            type: "object",
            properties: {
              id_empresa: { type: "number" },
              cnpj: { type: "string" },
              url_linkedin: { type: "string" },
            },
          },
        },
        nao_resolver: {
          type: "boolean",
          description: "Nao converte os CNPJs em id_empresa antes de enviar.",
        },
      },
      required: ["empresas"],
    },
  },
  {
    name: "datastone_saldo",
    description:
      "Mostra o SALDO por produto/carteira da conta (GET /balance): B2B, B2C (Consulta) e Data Reveal sao carteiras SEPARADAS. " +
      "Chame ANTES e DEPOIS de qualquer lote: e a unica forma de saber quanto foi realmente cobrado e de qual carteira, sem conferir extrato. " +
      "Um insufficient_credits em datastone_consultar_empresa com saldo B2B alto significa que a carteira B2C e que esta zerada. " +
      "CUSTO: 0 creditos.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "datastone_testar_api",
    description:
      "Health check da integracao (GET /apitest/): valida a API Key e o IP de origem sem consultar nenhum dado. " +
      "Use antes de disparar um lote — separa 'credencial/IP errados' de 'sem saldo' e de 'filtro sem resultado'. " +
      "CUSTO: 0 creditos.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "datastone_enrich_resultado",
    description:
      "Recupera o resultado de um enriquecimento assincrono (empresa ou pessoa) entregue por webhook. " +
      "Passe id_processamento (preferido) ou a chave usada no disparo (cnpj / id_empresa / id_pessoa). " +
      "Responde 'concluido', 'aguardando' com expira_em, ou 'expirado' — nunca fica em aguardando eterno. " +
      "No 'concluido' vem tambem _cobranca com sucesso/falhou: 'falhou' foi estornado automaticamente, 'sucesso' ficou cobrado. " +
      "CUSTO: gratis (leitura local).",
    inputSchema: {
      type: "object",
      properties: {
        id_processamento: { type: "string", description: "Preferido. Devolvido pelo disparo." },
        cnpj: { type: "string", description: "Alternativa para enrich de empresa." },
        id_empresa: { type: "number", description: "Alternativa para enrich de empresa disparado por id." },
        id_pessoa: { type: "number", description: "Alternativa para enrich de pessoa." },
      },
      required: [],
    },
  },
  {
    name: "datastone_listar_filtros",
    description:
      "Lista os filtros salvos na conta (GET /v1/b2b/filter/). Revela os VALORES REAIS aceitos em cargos, setores e niveis_senioridade. " +
      "Devolve tambem a traducao dos campos em ingles para os nomes em portugues usados nas outras ferramentas. " +
      "A resposta completa passa de 1,7 milhao de caracteres e estoura o contexto — SEMPRE peca um recorte com 'campo' e, de preferencia, 'contem'. " +
      "Sendo gratis, e aqui que voce valida valores antes de gastar credito. " +
      "CUSTO: gratis.",
    inputSchema: {
      type: "object",
      properties: {
        campo: {
          type: "string",
          description:
            'Recorte por campo, ex.: "cargos", "setores", "niveis_senioridade", "departamentos", "especialidades". Sem ele a resposta vem truncada.',
        },
        contem: {
          type: "string",
          description:
            'Filtra os valores do campo por substring, sem diferenciar maiuscula nem acento. Ex.: campo="cargos", contem="operações".',
        },
        limite: { type: "number", description: "Maximo de valores devolvidos (default 200)." },
      },
      required: [],
    },
  },
];

const TOOLS = {
  async datastone_consultar_empresa(args, env) {
    const cnpj = onlyDigits(args.cnpj);
    if (cnpj.length !== 14) return { erro: "CNPJ invalido (14 digitos)." };

    const query = { cnpj };
    if (args.fields) query.fields = args.fields;

    const r = await chamarApi(env, { metodo: "GET", caminho: "/companies/", query });
    if (!r.ok) return r.erro;
    return r.dados;
  },

  async datastone_buscar_empresa(args, env) {
    // Pedido 3.1: 'document' e 'url_linkedin' sao campos de PRIMEIRO NIVEL do corpo.
    // Dentro de filtros_empresa a API nao os reconhece e responde 400 "e necessario
    // preencher pelo menos um filtro" — erro que parece corpo vazio, mas e campo fora
    // de lugar. Este e o unico caminho documentado de CNPJ para id_empresa.
    if (args.document !== undefined || args.url_linkedin !== undefined) {
      const r = await resolverEmpresa(env, {
        document: args.document,
        url_linkedin: args.url_linkedin,
      });
      if (!r.ok) return r.erro;

      const saida = {
        id_empresa: r.id_empresa,
        document: r.document || null,
        url_linkedin: args.url_linkedin || null,
        _bruto: r.dados,
      };
      saida._proximo_passo =
        r.id_empresa === null
          ? "A API respondeu sem company_id. Confira o formato do documento; se persistir, esse CNPJ pode nao estar na base B2B."
          : "id_empresa resolvido a partir do documento — este e o vinculo confiavel, diferente do casamento por nome. " +
            "Use-o em datastone_enrich_iniciar {id_empresa: " +
            r.id_empresa +
            "} para os dados da empresa (carteira B2B, sem tocar no B2C). " +
            "Para decisores, a base de pessoas so aceita NOME: pegue a razao social do enriquecimento e confira setor/localizacao dos resultados antes de gastar.";
      if (temFiltrosDeBusca(args)) {
        saida._aviso =
          "Os demais filtros foram ignorados: com 'document' ou 'url_linkedin' a API faz lookup direto, nao busca por filtros.";
      }
      return saida;
    }

    // Bug 1: atalho + objeto chegando juntos quebravam o merge. Aqui os dois convivem —
    // o objeto e a base, os atalhos entram por cima, e so o objeto vai para a API.
    const filtros = comoObjeto(args.filtros_empresa);
    if (filtros === null) {
      return { erro: "filtros_empresa nao e um objeto JSON valido." };
    }
    for (const campo of CAMPOS_EMPRESA) {
      if (args[campo] !== undefined) filtros[campo] = mesclarFiltro(filtros[campo], args[campo]);
    }

    const proibido = CAMPOS_CNPJ_PROIBIDOS.find((c) => c in filtros);
    if (proibido) {
      return {
        erro:
          "filtros_empresa nao aceita '" +
          proibido +
          "'. Para resolver um CNPJ, passe document='<cnpj>' no PRIMEIRO NIVEL dos argumentos (fora de filtros_empresa) — " +
          "essa mesma ferramenta faz o lookup e devolve o id_empresa, na carteira B2B. " +
          "datastone_consultar_empresa tambem resolve por CNPJ, mas consome a carteira B2C.",
      };
    }

    const quebrado = checarCamposQuebrados(filtros, args.forcar_campos_quebrados);
    if (quebrado) return quebrado;

    if (!Object.keys(filtros).length) {
      return {
        erro:
          "E necessario pelo menos um filtro. O mais util para resolver um CNPJ: nome_empresa + estados.",
      };
    }

    const porPagina = Number(args.por_pagina) || 50;
    if (porPagina > 50) {
      return { erro: "por_pagina maximo e 50 (valores acima, como 100, retornam HTTP 400)." };
    }

    // Bug 5: os filtros iam espalhados na RAIZ do corpo (nome_empresa, estados... soltos).
    // A API nao reconhece esses nomes fora de filtros_empresa e responde 400
    // "E necessario preencher pelo menos um filtro" — que soa como corpo vazio, mas e
    // campo desconhecido. O contrato aqui e o mesmo de /b2b/persons/: paginacao e
    // chave_cache na raiz, filtros SEMPRE aninhados em filtros_empresa.
    const corpo = {
      pagina: Number(args.pagina) || 1,
      por_pagina: porPagina,
    };
    if (args.chave_cache) corpo.chave_cache = String(args.chave_cache);
    // A cobranca e por combinacao nova de filtros: ["a","b"] e ["b","a"] descrevem o
    // mesmo conjunto, mas em ordens diferentes a API as trata como buscas distintas e
    // cobra duas vezes. Ordenar aqui torna o cache deterministico sem exigir disciplina
    // de quem chama.
    corpo.filtros_empresa = ordenarFiltros(filtros);

    const r = await chamarApi(env, {
      metodo: "POST",
      caminho: "/b2b/companies/", // COM barra final
      corpo,
      gratis: Boolean(args.chave_cache),
    });
    if (!r.ok) return r.erro;

    const dados = r.dados || {};
    const saida = Object.assign({}, dados);

    if (dados.chave_cache) {
      saida.chave_cache = dados.chave_cache;
      saida._como_paginar =
        "Passe chave_cache: '" +
        dados.chave_cache +
        "' nas proximas paginas — assim elas nao debitam credito. A chave vale 7 dias.";
    }
    if (filtros.estados && filtros.localizacoes) {
      saida._aviso_filtros =
        "Voce combinou 'estados' e 'localizacoes': eles se somam e podem estreitar demais. Se vier total 0, use so um.";
    }
    if (dados.total === 0) {
      saida._nota =
        "total 0 nao debitou credito. Se filtrou por nome, troque hifen por espaco, remova sufixos societarios (LTDA, S/A, ME) ou use so a primeira palavra.";
    }
    const cruzamento = marcarRegistrosFundidos(dados);
    saida._proximo_passo =
      "Os registros vem de duas bases: quem tem cnpj vem da Receita (id_empresa geralmente null); quem tem id_empresa/slug vem do LinkedIn (cnpj geralmente null). " +
      (cruzamento.fundidos
        ? "NESTA RESPOSTA ha " +
          cruzamento.fundidos +
          " registro(s) FUNDIDO(S), com cnpj E id_empresa preenchidos (veja _registro_fundido). Isso e a excecao, nao a regra, e ja apareceu errado: " +
          "em caso real a versao fundida trazia porte de empresa pequena para uma empresa grande, e a mesma empresa voltou tambem como registro so-LinkedIn com outro id. " +
          "Antes de usar esse id_empresa, confira se ele nao e um perfil duplicado — compare com os outros registros de nome parecido nesta mesma resposta. "
        : "Nesta resposta nenhum registro traz os dois preenchidos, entao aqui nao da para converter CNPJ em id_empresa. (Registros fundidos existem, mas sao raros.) ") +
      (cruzamento.duplicatas
        ? "Atencao tambem a " +
          cruzamento.duplicatas +
          " registro(s) marcado(s) com _nome_duplicado: a mesma empresa aparece mais de uma vez, com dados divergentes. "
        : "") +
      "Para buscar decisores, leve o nome_empresa do registro (nao o cnpj, nao o id_empresa) para datastone_buscar_pessoas — a base de pessoas e indexada por nome. " +
      "Se precisa garantir o CNPJ certo, case os nomes com cuidado: a correspondencia por nome e heuristica.";
    return saida;
  },

  async datastone_buscar_pessoas(args, env) {
    // Bug 1: atalho + objeto chegando juntos quebravam o merge. Aqui os dois convivem.
    const filtrosEmpresa = comoObjeto(args.filtros_empresa);
    const filtrosPessoa = comoObjeto(args.filtros_pessoa);
    if (filtrosEmpresa === null) return { erro: "filtros_empresa nao e um objeto JSON valido." };
    if (filtrosPessoa === null) return { erro: "filtros_pessoa nao e um objeto JSON valido." };

    if (args.nome_empresa !== undefined) {
      filtrosEmpresa.nome_empresa = mesclarFiltro(filtrosEmpresa.nome_empresa, args.nome_empresa);
    }
    if (args.niveis_senioridade !== undefined) {
      filtrosPessoa.niveis_senioridade = mesclarFiltro(
        filtrosPessoa.niveis_senioridade,
        args.niveis_senioridade,
      );
    }
    if (args.cargos !== undefined) {
      filtrosPessoa.cargos = mesclarFiltro(filtrosPessoa.cargos, args.cargos);
    }
    if (args.vinculo_ativo !== undefined) filtrosPessoa.vinculo_ativo = args.vinculo_ativo;

    // Validacoes locais: falham antes de gastar credito ou tomar erro generico da API.
    const proibido = CAMPOS_CNPJ_PROIBIDOS.find((c) => c in filtrosEmpresa);
    if (proibido) {
      return {
        erro:
          "A base de pessoas nao aceita filtro por '" +
          proibido +
          "'. Ela e indexada pelo NOME da empresa. Use filtros_empresa.nome_empresa " +
          '(ex.: ["Guima Conseco"] com espaco — com hifen retorna 0). ' +
          "Se voce so tem o CNPJ: rode datastone_buscar_empresa, ache o registro daquele CNPJ e use dali o nome_empresa exato. " +
          "Na maioria das vezes esse registro vem sem id_empresa (base da Receita). Se por acaso vier com id_empresa preenchido (registro fundido, marcado com " +
          "_registro_fundido), ainda assim use o NOME aqui: a base de pessoas nao aceita id_empresa, e o id do registro fundido pode ser de um perfil duplicado da empresa.",
      };
    }

    // 'estados' + 'localizacoes' juntos e aceito pela API (HTTP 200, verificado),
    // mas restringe o resultado a interseccao das duas condicoes.
    const avisoGeo =
      filtrosEmpresa.estados && filtrosEmpresa.localizacoes
        ? "Voce combinou 'estados' e 'localizacoes': a API aceita, mas os dois se somam e podem estreitar demais o resultado. Se vier total 0, tente so um deles."
        : null;

    const quebrado = checarCamposQuebrados(filtrosEmpresa, args.forcar_campos_quebrados);
    if (quebrado) return quebrado;

    if (filtrosPessoa.niveis_senioridade) {
      const invalidos = [].concat(filtrosPessoa.niveis_senioridade).filter(
        (n) => SENIORIDADES_VALIDAS.indexOf(n) === -1,
      );
      if (invalidos.length) {
        return {
          erro:
            "niveis_senioridade invalido(s): " +
            JSON.stringify(invalidos) +
            ". Valores aceitos: " +
            JSON.stringify(SENIORIDADES_VALIDAS) +
            " (acentos incluidos).",
        };
      }
    }

    const temFiltro =
      Object.keys(filtrosEmpresa).length > 0 || Object.keys(filtrosPessoa).length > 0;
    if (!temFiltro) {
      return {
        erro:
          "E necessario pelo menos um filtro. O mais util: nome_empresa + niveis_senioridade ['Decisores'].",
      };
    }

    const porPagina = Number(args.por_pagina) || 50;
    if (porPagina > 50) {
      return { erro: "por_pagina maximo e 50 (valores acima, como 100, retornam HTTP 400)." };
    }

    const corpo = {
      pagina: Number(args.pagina) || 1,
      por_pagina: porPagina,
    };
    if (args.chave_cache) corpo.chave_cache = String(args.chave_cache);
    // Ordena as listas: a cobranca e por combinacao nova de filtros, e a ordem dos
    // valores nao muda o conjunto — mas muda a chave de cache da API.
    if (Object.keys(filtrosEmpresa).length) corpo.filtros_empresa = ordenarFiltros(filtrosEmpresa);
    if (Object.keys(filtrosPessoa).length) corpo.filtros_pessoa = ordenarFiltros(filtrosPessoa);

    const r = await chamarApi(env, {
      metodo: "POST",
      caminho: "/b2b/persons/", // COM barra final
      corpo,
      gratis: Boolean(args.chave_cache),
    });
    if (!r.ok) return r.erro;

    const dados = r.dados;
    const saida = Object.assign({}, dados);
    if (dados && dados.chave_cache) {
      saida.chave_cache = dados.chave_cache;
      saida._como_paginar =
        "Passe chave_cache: '" +
        dados.chave_cache +
        "' nas proximas paginas — assim elas nao debitam credito. A chave vale 7 dias.";
    }
    if (dados && dados.total === 0) {
      saida._nota =
        "total 0 nao debitou credito. Se filtrou por nome, tente a grafia com espaco em vez de hifen, ou um trecho menor do nome.";
    }
    if (avisoGeo) saida._aviso_filtros = avisoGeo;

    // Bug 4: a base lista vinculo encerrado como cargo atual. A API nao expoe data de
    // saida na busca, mas quando o cargo cita outra empresa a pessoa ja saiu — isso da
    // para detectar de graca, antes de gastar credito.
    const marcados = marcarVinculoSuspeito(saida, filtrosEmpresa.nome_empresa);
    if (marcados > 0) {
      saida._aviso_vinculo_encerrado =
        marcados +
        " registro(s) receberam _suspeita_saiu: o campo 'cargo' cita outra empresa, entao o vinculo com a empresa buscada provavelmente acabou. NAO enriqueca esses — o credito seria perdido.";
    }
    if (args.vinculo_ativo !== undefined) {
      saida._nota_vinculo_ativo =
        "vinculo_ativo foi repassado a API, mas o suporte a esse filtro nao e confirmado. Se registros com cargo em outra empresa continuarem aparecendo, a API ignorou o filtro.";
    }
    saida._proximo_passo =
      "Esta busca so revela tem_email/tem_telefone/tem_linkedin. Para obter o contato em si, chame datastone_enriquecer_pessoa com o id_pessoa (1 credito por pessoa). " +
      "Antes disso, descarte quem tiver _suspeita_saiu. A confirmacao definitiva (experiencia_profissional[].final != null) so vem no payload do enrich, ou seja, depois de pagar.";
    return saida;
  },

  async datastone_enriquecer_pessoa(args, env, workerOrigin) {
    const contato = {};
    if (args.id_pessoa) contato.id_pessoa = Number(args.id_pessoa);
    if (args.email) contato.email = args.email;
    if (args.cpf) contato.cpf = onlyDigits(args.cpf);
    if (args.url_linkedin) contato.url_linkedin = args.url_linkedin;

    if (!Object.keys(contato).length) {
      return {
        erro:
          "Informe pelo menos um identificador: id_pessoa (preferido, vem de datastone_buscar_pessoas), email, cpf ou url_linkedin.",
      };
    }

    if (!args.forcar && args.tem_email === false && args.tem_linkedin === false) {
      return {
        erro:
          "Chamada bloqueada para nao desperdicar credito: esta pessoa tem tem_email=false e tem_linkedin=false, " +
          "entao o enriquecimento debitaria 1 credito sem devolver contato utilizavel. " +
          "(tem_telefone nao entra nesta decisao: ele subnotifica.) " +
          "Se ainda assim quiser prosseguir, passe forcar: true.",
      };
    }

    // Bug 3: tem_telefone subnotifica (28 alvos marcados false, 4 de 5 enriquecidos
    // voltaram com telefone), entao ele nao entra na decisao nem gera aviso de ausencia.
    // Ja tem_email=false se confirmou fiel: todos os alvos assim voltaram com emails: [].
    const aviso =
      args.tem_telefone === false
        ? "tem_telefone=false foi ignorado: esse booleano subnotifica e telefone costuma vir mesmo assim. Nao descarte o alvo por causa dele."
        : undefined;

    return await dispararEnrich(env, workerOrigin, {
      caminho: "/b2b/persons/enrich", // SEM barra final
      tipo: "pessoa",
      chave: String(contato.id_pessoa || contato.email || contato.cpf || contato.url_linkedin),
      corpo: { contato },
      aviso,
    });
  },

  async datastone_enrich_iniciar(args, env, workerOrigin) {
    // Pedido 3.2: o fluxo B2B documentado junta os dois lados pelo id_empresa, e os
    // disparos feitos so com CNPJ voltaram com detalhes_contato: null gastando credito
    // sem estorno (sucesso: 1, falhou: 0). Aqui o id_empresa e a entrada principal e o
    // CNPJ e convertido antes do disparo.
    const cnpj = args.cnpj !== undefined ? onlyDigits(args.cnpj) : "";
    if (args.cnpj !== undefined && cnpj.length !== 14) {
      return { erro: "CNPJ invalido (14 digitos)." };
    }
    if (!cnpj && !args.id_empresa && !args.url_linkedin) {
      return {
        erro:
          "Informe id_empresa (preferido, vem de datastone_buscar_empresa), cnpj ou url_linkedin.",
      };
    }

    const contato = {};
    let notaResolucao;

    if (args.id_empresa) {
      contato.id_empresa = Number(args.id_empresa);
    } else if (!args.nao_resolver && (cnpj || args.url_linkedin)) {
      const r = await resolverEmpresa(env, { document: cnpj, url_linkedin: args.url_linkedin });
      if (!r.ok) {
        return Object.assign({}, r.erro, {
          _contexto:
            "Falhou ANTES do enrich, entao nenhum credito de enriquecimento foi debitado. " +
            "A resolucao de CNPJ para id_empresa e o passo que faz o enrich voltar preenchido. " +
            "Para disparar assim mesmo com o CNPJ cru (que nos testes voltou vazio), passe nao_resolver: true.",
        });
      }
      if (r.id_empresa === null) {
        return {
          erro:
            "A API nao devolveu company_id para esse documento — sem id_empresa o enrich voltaria vazio e o credito seria perdido. " +
            "Confira o CNPJ ou passe nao_resolver: true para insistir com o CNPJ cru.",
          _bruto: r.dados,
        };
      }
      contato.id_empresa = r.id_empresa;
      notaResolucao =
        "O CNPJ " + (cnpj || args.url_linkedin) + " foi resolvido no id_empresa " + r.id_empresa +
        " antes do disparo — o enrich foi feito por id, nao por CNPJ.";
    }

    // O CNPJ segue junto so quando nao houve resolucao: com id_empresa em maos, mandar
    // os dois e o cenario que voltou vazio nos testes.
    if (cnpj && !contato.id_empresa) contato.cnpj = cnpj;
    if (args.url_linkedin && !contato.id_empresa) contato.url_linkedin = args.url_linkedin;

    const saida = await dispararEnrich(env, workerOrigin, {
      caminho: "/b2b/companies/enrich", // SEM barra final
      tipo: "empresa",
      // A chave de recuperacao continua sendo o CNPJ quando ele existe: e por ele que o
      // cliente vai perguntar depois em datastone_enrich_resultado.
      chave: cnpj || String(contato.id_empresa || args.url_linkedin),
      corpo: { contato },
    });
    if (notaResolucao && saida && !saida.erro) saida._resolucao = notaResolucao;
    return saida;
  },

  async datastone_enrich_empresas_lote(args, env, workerOrigin) {
    const lista = Array.isArray(args.empresas) ? args.empresas : null;
    if (!lista || !lista.length) {
      return { erro: 'Informe "empresas" como lista nao vazia, ex.: [{"id_empresa":44235793}].' };
    }
    if (lista.length > 50) {
      return { erro: "Maximo 50 empresas por lote (recebido " + lista.length + ")." };
    }

    // Cada resolucao e uma chamada a API e consome uma vaga da fila de pacing
    // (PACING_MS entre chamadas, com teto de espera TETO_FILA_MS). Resolver um lote
    // inteiro estouraria o teto e as ultimas seriam RECUSADAS — cairiam no CNPJ cru,
    // que e justamente o caminho que volta vazio cobrando credito. Melhor barrar aqui:
    // resolver com datastone_buscar_empresa e de graca, este lote nao e.
    const precisamResolver = lista.filter(
      (i) => i && typeof i === "object" && !i.id_empresa && (i.cnpj || i.url_linkedin),
    );
    const orcamento = Math.floor(TETO_FILA_MS / PACING_MS); // vagas que cabem na fila
    if (!args.nao_resolver && precisamResolver.length > orcamento) {
      return {
        erro:
          precisamResolver.length +
          " itens vieram sem id_empresa, mas so " +
          orcamento +
          " cabem na fila de pacing por lote — os demais seriam recusados e disparariam com o CNPJ cru, que volta vazio cobrando credito.",
        _como_resolver:
          "Rode datastone_buscar_empresa {document:'<cnpj>'} para cada um (nao debitou credito nas medicoes) e monte o lote so com id_empresa. " +
          "Ou mande em lotes de ate " +
          orcamento +
          " CNPJs. Ou passe nao_resolver: true para assumir o risco do CNPJ cru.",
      };
    }

    const contatos = [];
    const resolvidos = [];
    const naoResolvidos = [];
    for (const item of lista) {
      if (!item || typeof item !== "object") continue;
      if (item.id_empresa) {
        contatos.push({ id_empresa: Number(item.id_empresa) });
        continue;
      }
      const doc = item.cnpj !== undefined ? onlyDigits(item.cnpj) : "";
      if (!args.nao_resolver && (doc || item.url_linkedin)) {
        const r = await resolverEmpresa(env, { document: doc, url_linkedin: item.url_linkedin });
        if (r.ok && r.id_empresa !== null) {
          contatos.push({ id_empresa: r.id_empresa });
          resolvidos.push((doc || item.url_linkedin) + " -> " + r.id_empresa);
          continue;
        }
        // Nao resolveu (404, fila cheia, etc): registra em vez de degradar em silencio.
        naoResolvidos.push({
          alvo: doc || item.url_linkedin,
          motivo: (r.erro && r.erro.erro) || "sem company_id na resposta",
        });
      }
      if (doc) contatos.push({ cnpj: doc });
      else if (item.url_linkedin) contatos.push({ url_linkedin: item.url_linkedin });
    }

    if (!contatos.length) {
      return { erro: "Nenhum item utilizavel: cada empresa precisa de id_empresa, cnpj ou url_linkedin." };
    }

    const saida = await dispararEnrich(env, workerOrigin, {
      caminho: "/b2b/companies/enrich/bulk", // SEM barra final, como os demais /enrich
      tipo: "empresa-lote",
      chave: "lote:" + contatos.length + ":" + Date.now(),
      corpo: { contatos },
    });
    if (saida && saida.erro) {
      saida._contexto =
        "Se o erro for HTTP 400, o formato do corpo em lote provavelmente difere do esperado " +
        '(este servidor envia {"contatos":[...]}) — nada foi debitado. ' +
        "Caia para datastone_enrich_iniciar uma empresa por vez.";
      return saida;
    }
    saida._empresas_no_lote = contatos.length;
    saida._custo_estimado = contatos.length + " creditos B2B (1 por empresa). Confira com datastone_saldo.";
    if (resolvidos.length) saida._resolucao = resolvidos;
    return saida;
  },

  async datastone_saldo(args, env) {
    const r = await chamarApi(env, { metodo: "GET", caminho: "/balance", gratis: true });
    if (!r.ok) return r.erro;
    return {
      saldo: r.dados,
      _leitura:
        "As carteiras sao SEPARADAS: B2B alimenta buscar_empresa/buscar_pessoas/enriquecer_pessoa/enrich_iniciar; " +
        "B2C (Consulta) alimenta datastone_consultar_empresa; Data Reveal e outro produto. " +
        "insufficient_credits sempre se refere a carteira daquela ferramenta, nao ao total da conta.",
      _custo: "Esta chamada nao debitou credito.",
    };
  },

  async datastone_testar_api(args, env) {
    const r = await chamarApi(env, { metodo: "GET", caminho: "/apitest/", gratis: true });
    if (!r.ok) {
      return Object.assign({}, r.erro, {
        _leitura:
          "Falha aqui e de credencial ou de IP de origem, nunca de saldo nem de filtro — este endpoint nao consulta dado nenhum.",
      });
    }
    return {
      ok: true,
      resposta: r.dados,
      _leitura: "API Key e IP de origem validados. Custo 0. Se um lote falhar depois disso, o problema e saldo ou filtro.",
    };
  },

  async datastone_enrich_resultado(args, env) {
    let idProc = args.id_processamento ? String(args.id_processamento) : "";

    if (!idProc) {
      const chave = args.cnpj
        ? onlyDigits(args.cnpj)
        : args.id_empresa
          ? String(args.id_empresa)
          : args.id_pessoa
            ? String(args.id_pessoa)
            : "";
      if (!chave) {
        return {
          erro: "Informe id_processamento (preferido), cnpj, id_empresa ou id_pessoa.",
        };
      }
      const tipo = args.cnpj || args.id_empresa ? "empresa" : "pessoa";
      idProc = (await env.PAYLOADS.get("alias:" + tipo + ":" + chave)) || "";
      if (!idProc) {
        return {
          status: "desconhecido",
          erro:
            "Nenhum enriquecimento registrado para essa chave neste servidor. " +
            "Ou nunca foi disparado, ou o registro ja expirou (retencao de " +
            RETENCAO_REGISTRO_S / 86400 +
            " dias para o registro, " +
            RETENCAO_RESULTADO_S / 60 +
            " min para o resultado). Dispare novamente.",
        };
      }
    }

    // Um payload pode ter chegado por chave alternativa mesmo sem o id_processamento
    // do disparo bater (Bug 2): antes de declarar desconhecido, tenta o desvio.
    const desvio = args.cnpj
      ? "alias:empresa:" + onlyDigits(args.cnpj)
      : args.id_empresa
        ? "alias:empresa:" + String(args.id_empresa)
        : args.id_pessoa
          ? "alias:pessoa:" + String(args.id_pessoa)
          : null;

    let resultado = await env.PAYLOADS.get("res:" + idProc);
    let idAchado = idProc;
    let porDesvio = false;

    // O payload pode ter chegado com um id_processamento diferente do devolvido no
    // disparo. Nesse caso ele foi indexado pela chave alternativa (id_pessoa/cnpj).
    if (!resultado && desvio) {
      const idAlt = await env.PAYLOADS.get(desvio);
      if (idAlt && idAlt !== idProc) {
        const alt = await env.PAYLOADS.get("res:" + idAlt);
        if (alt) {
          resultado = alt;
          idAchado = idAlt;
          porDesvio = true;
        }
      }
    }

    if (resultado) {
      const payload = JSON.parse(resultado);
      const saida = {
        status: "concluido",
        id_processamento: idAchado,
        dados: payload,
        _cobranca: resumirCobranca(payload),
        _retencao:
          "Este payload contem dado pessoal (CPF) e e descartado " +
          RETENCAO_RESULTADO_S / 60 +
          " min apos a chegada.",
      };
      if (porDesvio) {
        saida._nota =
          "Recuperado pela chave alternativa: o webhook chegou com id_processamento '" +
          idAchado +
          "', diferente do '" +
          idProc +
          "' devolvido no disparo. O credito nao se perdeu.";
      }
      return saida;
    }

    const pendenteBruto = await env.PAYLOADS.get("pend:" + idProc);
    if (!pendenteBruto) {
      return {
        status: "desconhecido",
        id_processamento: idProc,
        erro:
          "id_processamento nao registrado neste servidor. O registro vive " +
          RETENCAO_REGISTRO_S / 86400 +
          " dias em KV, entao isso indica que o disparo nunca foi confirmado ou que o id veio de outro servidor.",
        dica: desvio
          ? "Nenhum payload chegou pela chave alternativa tambem."
          : "Tente de novo passando cnpj ou id_pessoa: se o webhook chegou com outro id_processamento, ele foi gravado por essa chave.",
      };
    }

    const pendente = JSON.parse(pendenteBruto);
    const restanteS = Math.floor((pendente.expira_em_ms - Date.now()) / 1000);

    // Os dois instantes separam as duas falhas que antes se confundiam.
    const cronologia = {
      disparado_em: pendente.disparado_em_ms
        ? new Date(pendente.disparado_em_ms).toISOString()
        : null,
      esperando_ha_s: pendente.disparado_em_ms
        ? Math.round((Date.now() - pendente.disparado_em_ms) / 1000)
        : null,
      webhook_chegou: Boolean(pendente.recebido_em_ms),
      recebido_em: pendente.recebido_em_ms
        ? new Date(pendente.recebido_em_ms).toISOString()
        : null,
    };

    if (restanteS <= 0) {
      return {
        status: "expirado",
        id_processamento: idProc,
        erro:
          "O webhook nao chegou dentro da janela de " +
          JANELA_ESPERA_S / 60 +
          " min. O credito desse disparo foi consumido sem retorno. Nao adianta continuar consultando.",
        expirou_em: new Date(pendente.expira_em_ms).toISOString(),
        cronologia,
        _diagnostico: pendente.recebido_em_ms
          ? "ATENCAO: um webhook CHEGOU para este disparo, mas o resultado nao esta mais em KV — " +
            "provavelmente venceu a retencao de " +
            RETENCAO_RESULTADO_S / 60 +
            " min. A falha foi deste servidor, nao da Data Stone."
          : "Nenhum webhook chegou para este token em momento algum: a falha esta do lado da Data Stone (ou o Worker estava inacessivel). Veja /diagnostico.",
      };
    }

    return {
      status: "aguardando",
      id_processamento: idProc,
      tipo: pendente.tipo,
      chave: pendente.chave,
      expira_em: new Date(pendente.expira_em_ms).toISOString(),
      cronologia,
      segundos_restantes: restanteS,
      mensagem:
        "Webhook ainda nao chegou. Tente de novo em alguns segundos; desista se passar de expira_em.",
    };
  },

  async datastone_listar_filtros(args, env) {
    const r = await chamarApi(env, { metodo: "GET", caminho: "/b2b/filter/", gratis: true });
    if (!r.ok) return r.erro;

    // A resposta crua passa de 1,7 milhao de caracteres e estoura o contexto do cliente.
    // Com 'campo' devolvemos so o recorte; sem ele, um indice do que da para pedir.
    if (args.campo) {
      const limite = Math.max(1, Number(args.limite) || 200);
      const alvos = APELIDOS_FILTRO[args.campo] || [args.campo];
      const valores = coletarValores(r.dados, alvos);

      if (!valores.length) {
        return {
          campo: args.campo,
          erro: "Campo nao encontrado na resposta.",
          campos_disponiveis: listarChaves(r.dados),
        };
      }

      const busca = normalizar(args.contem);
      const filtrados = busca ? valores.filter((v) => normalizar(v).indexOf(busca) !== -1) : valores;

      return {
        campo: args.campo,
        contem: args.contem || null,
        total_no_campo: valores.length,
        total_apos_filtro: filtrados.length,
        exibindo: Math.min(filtrados.length, limite),
        valores: filtrados.slice(0, limite),
        _nota:
          filtrados.length > limite
            ? "Truncado. Refine com 'contem' ou aumente 'limite'."
            : "Use estes valores literalmente (acentos incluidos) nos filtros das outras ferramentas.",
      };
    }

    return {
      _leia_primeiro:
        "Resposta completa omitida: ela passa de 1,7 milhao de caracteres e estoura o contexto. " +
        "Chame de novo com campo=\"cargos\" (ou \"setores\", \"niveis_senioridade\", \"departamentos\") e, se possivel, contem=\"<substring>\".",
      campos_disponiveis: listarChaves(r.dados),
      niveis_senioridade: SENIORIDADES_VALIDAS,
      _traducao_dos_campos: {
        company_filters: "filtros_empresa",
        person_filters: "filtros_pessoa",
        roles: "cargos",
        seniority_levels: "niveis_senioridade",
        cache_key: "chave_cache",
        has_email: "tem_email",
        has_phone: "tem_telefone",
        has_linkedin: "tem_linkedin",
      },
      _nota:
        "As listas salvas vem com os nomes em ingles. Use a traducao acima e reaproveite os valores de 'roles' como 'cargos' em datastone_buscar_pessoas.",
    };
  },
};

// ---------------------------------------------------------------------------
// Enrich assincrono: dispara com url_webhook deste proprio servidor.
// ---------------------------------------------------------------------------
async function dispararEnrich(env, workerOrigin, { caminho, tipo, chave, corpo, aviso }) {
  const token = crypto.randomUUID();
  const urlWebhook = workerOrigin + "/webhooks/datastone/" + token;
  const expiraEmMs = Date.now() + JANELA_ESPERA_S * 1000;

  // Bug 2: o registro e gravado ANTES da chamada paga. Se ele so nascesse depois, um
  // timeout ou reinicio entre o debito e a gravacao deixaria o credito sem rastro —
  // foi assim que 3 enriquecimentos viraram "id_processamento nao registrado".
  // O token vive na URL do webhook, entao esta gravacao ja basta para o payload voltar.
  const disparadoEmMs = Date.now();
  const registroInicial = {
    id_processamento: null,
    tipo,
    chave,
    expira_em_ms: expiraEmMs,
    disparado_em_ms: disparadoEmMs,
  };
  await Promise.all([
    env.PAYLOADS.put("tok:" + token, JSON.stringify(registroInicial), {
      expirationTtl: RETENCAO_REGISTRO_S,
    }),
    env.PAYLOADS.put("pend:" + token, JSON.stringify(registroInicial), {
      expirationTtl: RETENCAO_REGISTRO_S,
    }),
    // Log do disparo: gravado ANTES da chamada paga, com instante. E o lado "saiu daqui"
    // do par que permite separar "a Data Stone nunca mandou" de "chegou e o servidor perdeu".
    registrarLog(env, "disparo", {
      token,
      tipo,
      chave,
      caminho,
      disparado_em_ms: disparadoEmMs,
    }),
  ]);

  const r = await chamarApi(env, {
    metodo: "POST",
    caminho,
    corpo: Object.assign({}, corpo, { url_webhook: urlWebhook }),
  });
  if (!r.ok) {
    // Erro nao debita credito: limpa o registro provisorio para nao poluir as buscas.
    await Promise.all([
      env.PAYLOADS.delete("tok:" + token),
      env.PAYLOADS.delete("pend:" + token),
      // O log do disparo FICA, marcado como recusado: sem ele o /diagnostico mostraria
      // um disparo sem desfecho, que e justamente o sintoma de credito perdido.
      registrarLog(env, "disparo-recusado", {
        token,
        tipo,
        chave,
        disparado_em_ms: disparadoEmMs,
        erro: r.erro && r.erro.erro,
      }),
    ]);
    return r.erro;
  }

  const ack = r.dados || {};

  // Guarda de dinheiro: sem url_webhook aceita, o credito sai e o payload se perde.
  if (ack.url_webhook === null || ack.url_webhook === "") {
    return {
      erro:
        "A API confirmou o disparo com url_webhook null — o resultado seria descartado e o credito perdido. " +
        "Nao ha endpoint de resgate para esse enrich. Verifique se " +
        urlWebhook +
        " esta acessivel publicamente antes de tentar de novo.",
      ack,
    };
  }

  const idProc = String(
    ack.id_processamento || ack.processing_id || ack.id || token,
  );

  const registro = {
    id_processamento: idProc,
    tipo,
    chave,
    expira_em_ms: expiraEmMs,
    token,
    disparado_em_ms: disparadoEmMs,
  };
  // Registro sem dado pessoal: guardado por 7 dias, nao pela janela de 15 min. Assim
  // uma consulta tardia responde "expirado" (informacao util) em vez de "desconhecido".
  await Promise.all([
    env.PAYLOADS.put("tok:" + token, JSON.stringify(registro), {
      expirationTtl: RETENCAO_REGISTRO_S,
    }),
    env.PAYLOADS.put("pend:" + idProc, JSON.stringify(registro), {
      expirationTtl: RETENCAO_REGISTRO_S,
    }),
    env.PAYLOADS.put("alias:" + tipo + ":" + chave, idProc, {
      expirationTtl: RETENCAO_REGISTRO_S,
    }),
    env.PAYLOADS.delete("res:" + idProc),
  ]);
  if (idProc !== token) await env.PAYLOADS.delete("pend:" + token);

  const saida = {
    status: "processando",
    id_processamento: idProc,
    tipo,
    chave,
    expira_em: new Date(expiraEmMs).toISOString(),
    mensagem:
      "Disparado. O resultado chega por webhook neste servidor. Use datastone_enrich_resultado com id_processamento '" +
      idProc +
      "'. Se passar de expira_em, desista — nao existe endpoint de resgate.",
  };
  if (aviso) saida.aviso = aviso;
  return saida;
}

// ---------------------------------------------------------------------------
// Camada HTTP para a API, com pacing e repasse do erro cru.
// ---------------------------------------------------------------------------
async function chamarApi(env, { metodo, caminho, corpo, query, gratis }) {
  if (!gratis) {
    const recusa = await reservarVaga(env);
    // Fila cheia: devolve erro ANTES de gastar credito, em vez de deixar o cliente pendurado.
    if (recusa) return { ok: false, erro: recusa };
  }

  const url = new URL(DATASTONE_BASE + caminho);
  if (query) {
    for (const k of Object.keys(query)) url.searchParams.set(k, query[k]);
  }

  const headers = {
    Authorization: "Token " + env.DATASTONE_TOKEN, // nao e Bearer (401) nem X-API-Key (403)
    Accept: "application/json",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  };
  const init = { method: metodo, headers };
  if (corpo !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(corpo);
  }

  const resp = await fetch(url.toString(), init);
  const bruto = await resp.text();
  let dados = null;
  try {
    dados = JSON.parse(bruto);
  } catch (e) {
    dados = null;
  }

  if (resp.ok && dados !== null) return { ok: true, dados };

  const erro = { erro: "HTTP " + resp.status, corpo: dados !== null ? dados : bruto.slice(0, 800) };

  if (dados === null) {
    erro.erro = "Resposta nao-JSON (HTTP " + resp.status + ")";
    erro.dica =
      "A API devolveu HTML — quase sempre URL errada. Confira o prefixo /v1 e a barra final: " +
      "/b2b/persons/ COM barra, /b2b/companies/enrich e /b2b/persons/enrich SEM barra.";
  } else if (resp.status === 429 || /bloquead|suspeita/i.test(bruto)) {
    erro.dica =
      "Rate limit (espere 45 s) ou bloqueio anti-abuso por rajada (dura ~5 min). O servidor ja espaca as chamadas em " +
      PACING_MS / 1000 +
      " s; reduza o ritmo das chamadas em lote.";
  } else if (/webhook/i.test(bruto)) {
    erro.dica =
      "Rejeicao no preflight do webhook — nao debitou credito. O receptor deste servidor responde 2xx em GET/HEAD/OPTIONS/PUT/PATCH/POST; se o erro persistir, o Worker pode estar inacessivel publicamente.";
  }

  return { ok: false, erro };
}

// ---------------------------------------------------------------------------
// Fila interna de saida.
//
// Na AWS a reserva atomica da vaga e feita por DynamoDB (compare-and-set), em vez
// do Durable Object do Cloudflare. Cada invocacao recebe um instante exclusivo e a
// rajada nao chega junto a API da Data Stone.
// ---------------------------------------------------------------------------
async function reservarVaga(env) {
  try {
    if (!env.PACING) return await pacearEmKv(env);
    const dados = await env.PACING.reservar(PACING_MS, TETO_FILA_MS);
    if (dados.recusado) {
      return {
        erro:
          "Fila de saida cheia: a proxima vaga so abre em " +
          Math.ceil(dados.espera_ms / 1000) +
          " s, acima do teto de " +
          TETO_FILA_MS / 1000 +
          " s. Nada foi enviado a API e nenhum credito foi debitado. " +
          "O servidor espaca as chamadas em " +
          PACING_MS / 1000 +
          " s para nao tomar bloqueio anti-abuso — reduza o paralelismo e repita em alguns segundos.",
      };
    }
    if (dados.espera_ms > 0) {
      await new Promise((r) => setTimeout(r, dados.espera_ms));
    }
    return null;
  } catch (e) {
    // Falha de DynamoDB nao pode liberar uma rajada que gastaria creditos. A chamada
    // e recusada antes da API externa para o cliente tentar novamente.
    return {
      erro:
        "Nao foi possivel reservar uma vaga na fila de saida. Nada foi enviado a API e nenhum credito foi debitado; tente novamente em alguns segundos.",
    };
  }
}

// Espacamento legado em KV. Mantido so como rede de seguranca do reservarVaga.
async function pacearEmKv(env) {
  try {
    const ultimo = Number(await env.PAYLOADS.get("pace:ultimo")) || 0;
    const espera = Math.min(PACING_MS - (Date.now() - ultimo), PACING_MS);
    if (espera > 0) await new Promise((r) => setTimeout(r, espera));
    await env.PAYLOADS.put("pace:ultimo", String(Date.now()), { expirationTtl: 60 });
  } catch (e) {
    // Pacing nunca deve derrubar a chamada.
  }
  return null;
}

// ---------------------------------------------------------------------------

export const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const workerOrigin = (env.PUBLIC_BASE_URL || url.protocol + "//" + url.host).replace(/\/$/, "");

    // Discovery de OAuth: este servidor nao exige auth.
    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/oauth-protected-resource"
    ) {
      return new Response(JSON.stringify({}), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Receptor de webhook em rota nao-adivinhavel (token opaco por disparo).
    // Precisa responder 2xx em QUALQUER metodo: a Data Stone valida o endpoint
    // antes de enfileirar usando um metodo diferente de POST, e um 501 reprova o enrich.
    if (url.pathname.startsWith("/webhooks/datastone/")) {
      const token = url.pathname.slice("/webhooks/datastone/".length).replace(/\/$/, "");

      if (request.method === "HEAD") return new Response(null, { status: 200 });
      if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
        await guardarWebhook(env, token, request);
      }
      return new Response("ok", { status: 200 });
    }

    // O webhook e publico por necessidade da Data Stone. As rotas MCP e de
    // diagnostico, por outro lado, podem gastar creditos e ficam protegidas quando
    // MCP_API_TOKEN esta configurado no segredo AWS.
    if (env.MCP_API_TOKEN && request.headers.get("authorization") !== "Bearer " + env.MCP_API_TOKEN) {
      return json({ error: "unauthorized" }, 401);
    }

    // Diagnostico: pareia disparos com chegadas para responder a pergunta que o log
    // solto nao responde — "a Data Stone nao mandou" ou "chegou e o servidor perdeu?".
    if (url.pathname === "/diagnostico") {
      return json(await montarDiagnostico(env));
    }

    if (request.method !== "POST") {
      return new Response("MCP server ativo.", { status: 200 });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }

    const id = body.id;
    const method = body.method;
    const params = body.params;

    if (method === "initialize") {
      return json({
        jsonrpc: "2.0",
        id: id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "datastone-hub", version: "2.0.0" },
        },
      });
    }

    if (method === "tools/list") {
      return json({ jsonrpc: "2.0", id: id, result: { tools: TOOL_DEFINITIONS } });
    }

    if (method === "tools/call") {
      const impl = TOOLS[params && params.name];
      if (!impl) {
        return json({
          jsonrpc: "2.0",
          id: id,
          error: {
            code: -32601,
            message: "Tool nao encontrada: " + (params && params.name),
          },
        });
      }
      try {
        const result = await impl((params && params.arguments) || {}, env, workerOrigin);
        return json({
          jsonrpc: "2.0",
          id: id,
          result: { content: [{ type: "text", text: serializarComTeto(result, params.name) }] },
        });
      } catch (err) {
        return json({
          jsonrpc: "2.0",
          id: id,
          error: { code: -32603, message: String(err) },
        });
      }
    }

    return json({
      jsonrpc: "2.0",
      id: id,
      error: { code: -32601, message: "Metodo nao suportado" },
    });
  },
};

export default worker;

// Bug 2: payload orfao nunca e descartado. Um crédito ja foi pago para produzir este
// corpo — se o token nao resolver, ele e gravado por toda chave que der para extrair
// (id_processamento, id_pessoa, cnpj), e enrich_resultado alcanca por qualquer uma delas.
async function guardarWebhook(env, token, request) {
  const bruto = await request.text();
  let payload = null;
  try {
    payload = JSON.parse(bruto);
  } catch (e) {
    payload = null;
  }

  // Corpo vazio e preflight/ping: nao ha nada a guardar e nao vale poluir o log.
  if (!bruto.trim()) return;

  const recebidoEmMs = Date.now();

  // Corpo nao-JSON (ou JSON escalar) com conteudo: um credito ja foi pago por isso.
  // Guardar cru e feio, mas descartar e perder dinheiro — fica recuperavel pelo token.
  if (!payload || typeof payload !== "object") {
    await Promise.all([
      env.PAYLOADS.put("res:" + token, JSON.stringify({ _corpo_cru: bruto.slice(0, 20000) }), {
        expirationTtl: RETENCAO_RESULTADO_S,
      }),
      registrarLog(env, "webhook-nao-json", {
        token,
        recebido_em_ms: recebidoEmMs,
        amostra: bruto.slice(0, 200),
      }),
    ]);
    return;
  }

  const registroBruto = await env.PAYLOADS.get("tok:" + token);
  const registro = registroBruto ? JSON.parse(registroBruto) : null;

  // Ids sob os quais o resultado passa a ser encontravel.
  const ids = new Set([token]);
  if (registro && registro.id_processamento) ids.add(String(registro.id_processamento));
  const idNoPayload = buscarProfundo(payload, "id_processamento");
  if (idNoPayload) ids.add(String(idNoPayload));

  // Chaves alternativas: as do disparo e as que vierem no proprio corpo.
  const aliases = new Set();
  if (registro && registro.tipo && registro.chave) {
    aliases.add("alias:" + registro.tipo + ":" + registro.chave);
  }
  const idPessoa = buscarProfundo(payload, "id_pessoa");
  if (idPessoa) aliases.add("alias:pessoa:" + String(idPessoa));
  const cnpj = onlyDigits(buscarProfundo(payload, "cnpj"));
  if (cnpj.length === 14) aliases.add("alias:empresa:" + cnpj);
  // Enrich de empresa agora dispara por id_empresa: sem este alias o payload de um
  // disparo feito so com o id ficaria alcancavel apenas pelo id_processamento.
  const idEmpresa = buscarProfundo(payload, "id_empresa") || buscarProfundo(payload, "company_id");
  if (idEmpresa) aliases.add("alias:empresa:" + String(idEmpresa));
  // As outras chaves com que o disparo pode ter sido feito. Sem elas, um payload orfao
  // disparado por email/cpf/linkedin so seria alcancavel pelo token, que o cliente nunca ve.
  const email = buscarProfundo(payload, "email");
  if (email) aliases.add("alias:pessoa:" + String(email).toLowerCase());
  const cpf = onlyDigits(buscarProfundo(payload, "cpf"));
  if (cpf.length === 11) aliases.add("alias:pessoa:" + cpf);
  const linkedin = buscarProfundo(payload, "url_linkedin");
  if (linkedin) aliases.add("alias:pessoa:" + String(linkedin));

  // O id canonico para o qual os aliases apontam: o do registro, senao o do payload.
  const idCanonico = String(
    (registro && registro.id_processamento) || idNoPayload || token,
  );

  const corpo = JSON.stringify(payload);
  const gravacoes = [];
  for (const id of ids) {
    gravacoes.push(
      env.PAYLOADS.put("res:" + id, corpo, { expirationTtl: RETENCAO_RESULTADO_S }),
    );
  }
  for (const alias of aliases) {
    gravacoes.push(
      env.PAYLOADS.put(alias, idCanonico, { expirationTtl: RETENCAO_REGISTRO_S }),
    );
  }

  // Marca a chegada no registro: e o lado "voltou" do par disparo/chegada. Com os dois
  // instantes, "nao veio nada" e "veio e o servidor nao ligou ao disparo" deixam de se
  // confundir — e a demora real da Data Stone fica medida, nao estimada.
  const orfao = !registro;
  if (registro) {
    registro.recebido_em_ms = recebidoEmMs;
    gravacoes.push(
      env.PAYLOADS.put("tok:" + token, JSON.stringify(registro), {
        expirationTtl: RETENCAO_REGISTRO_S,
      }),
      env.PAYLOADS.put("pend:" + idCanonico, JSON.stringify(registro), {
        expirationTtl: RETENCAO_REGISTRO_S,
      }),
    );
  }

  gravacoes.push(
    registrarLog(env, orfao ? "webhook-orfao" : "webhook", {
      token,
      recebido_em_ms: recebidoEmMs,
      id_canonico: idCanonico,
      disparado_em_ms: registro ? registro.disparado_em_ms : null,
      demora_s:
        registro && registro.disparado_em_ms
          ? Math.round((recebidoEmMs - registro.disparado_em_ms) / 1000)
          : null,
      indexado_por: [...aliases],
    }),
  );

  await Promise.all(gravacoes);
}

// ---------------------------------------------------------------------------
// Log de metadados (sem dado pessoal), em KV, ordenavel por chave: o timestamp vem
// primeiro e em milissegundos, entao list() com prefixo ja devolve em ordem cronologica.
// ---------------------------------------------------------------------------
// Le o log e cruza disparo x chegada por token. Um disparo sem chegada correspondente e
// credito que saiu e nao voltou — e essa e a linha que separa as duas culpas.
async function montarDiagnostico(env) {
  const lista = await env.PAYLOADS.list({ prefix: "log:", limit: 1000 });
  const eventos = [];
  for (const chave of lista.keys) {
    const bruto = await env.PAYLOADS.get(chave.name);
    if (bruto) eventos.push(JSON.parse(bruto));
  }

  const porToken = new Map();
  for (const ev of eventos) {
    if (!ev.token) continue;
    const atual = porToken.get(ev.token) || { token: ev.token };
    if (ev.evento === "disparo" || ev.evento === "disparo-recusado") {
      atual.disparo = ev;
    } else {
      atual.chegada = ev;
    }
    porToken.set(ev.token, atual);
  }

  const agora = Date.now();
  const semRetorno = [];
  const respondidos = [];
  const orfaos = [];

  for (const par of porToken.values()) {
    if (par.chegada && !par.disparo) {
      orfaos.push({ token: par.token, recebido_em: iso(par.chegada.recebido_em_ms) });
      continue;
    }
    if (!par.disparo) continue;
    if (par.disparo.evento === "disparo-recusado") continue; // nao debitou

    const base = {
      token: par.token,
      tipo: par.disparo.tipo,
      chave: par.disparo.chave,
      disparado_em: iso(par.disparo.disparado_em_ms),
    };
    if (par.chegada) {
      respondidos.push(
        Object.assign(base, {
          recebido_em: iso(par.chegada.recebido_em_ms),
          demora_s: par.chegada.demora_s,
        }),
      );
    } else {
      const esperandoS = Math.round((agora - par.disparo.disparado_em_ms) / 1000);
      semRetorno.push(
        Object.assign(base, {
          esperando_ha_s: esperandoS,
          ainda_na_janela: esperandoS < JANELA_ESPERA_S,
        }),
      );
    }
  }

  const demoras = respondidos.map((r) => r.demora_s).filter((d) => typeof d === "number");
  return {
    gerado_em: new Date(agora).toISOString(),
    resumo: {
      disparos_com_retorno: respondidos.length,
      disparos_sem_retorno: semRetorno.length,
      webhooks_orfaos: orfaos.length,
      demora_mediana_s: demoras.length ? mediana(demoras) : null,
      demora_maxima_s: demoras.length ? Math.max(...demoras) : null,
    },
    _como_ler:
      "disparos_sem_retorno com ainda_na_janela=false sao creditos que sairam e nao voltaram: " +
      "nenhum webhook chegou para aquele token, entao a falha e da Data Stone (ou o Worker estava inacessivel). " +
      "webhooks_orfaos e o contrario: chegou payload sem disparo correspondente registrado — falha deste servidor, " +
      "mas o payload foi guardado assim mesmo e da para resgatar por id_pessoa/cnpj em datastone_enrich_resultado.",
    disparos_sem_retorno: semRetorno.sort((a, b) => b.esperando_ha_s - a.esperando_ha_s).slice(0, 50),
    webhooks_orfaos: orfaos.slice(0, 50),
    ultimos_respondidos: respondidos.slice(-20),
    _truncado: lista.list_complete === false,
  };
}

function iso(ms) {
  return ms ? new Date(Number(ms)).toISOString() : null;
}

function mediana(ns) {
  const s = [...ns].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

async function registrarLog(env, evento, dados) {
  try {
    const ts = Number(dados.recebido_em_ms || dados.disparado_em_ms) || Date.now();
    const chave = "log:" + String(ts).padStart(15, "0") + ":" + evento;
    await env.PAYLOADS.put(chave, JSON.stringify(Object.assign({ evento }, dados)), {
      expirationTtl: RETENCAO_LOG_S,
    });
  } catch (e) {
    // Log e diagnostico: nunca pode derrubar um disparo pago nem a gravacao de um payload.
  }
}

// Procura a primeira ocorrencia de uma chave em qualquer nivel do payload.
function buscarProfundo(no, chave, profundidade = 0) {
  if (profundidade > 6 || no === null || typeof no !== "object") return null;
  if (Array.isArray(no)) {
    for (const item of no) {
      const achado = buscarProfundo(item, chave, profundidade + 1);
      if (achado) return achado;
    }
    return null;
  }
  if (no[chave] !== undefined && no[chave] !== null && no[chave] !== "") return no[chave];
  for (const k of Object.keys(no)) {
    const achado = buscarProfundo(no[k], chave, profundidade + 1);
    if (achado) return achado;
  }
  return null;
}

function onlyDigits(v) {
  return String(v || "").replace(/[^0-9]/g, "");
}

// Rede de seguranca: nenhuma ferramenta pode devolver algo que estoure o contexto do
// cliente. Uma resposta cortada com instrucao e melhor que uma conversa inutilizada.
function serializarComTeto(result, nomeFerramenta) {
  const texto = JSON.stringify(result, null, 2);
  if (texto.length <= LIMITE_RESPOSTA_CHARS) return texto;
  return JSON.stringify(
    {
      erro:
        "Resposta grande demais (" +
        texto.length +
        " caracteres) e foi cortada para nao estourar o contexto.",
      dica:
        nomeFerramenta === "datastone_listar_filtros"
          ? "Chame de novo com campo=\"cargos\" e contem=\"<substring>\"."
          : "Reduza por_pagina ou estreite os filtros.",
      trecho: texto.slice(0, 4000),
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Normalizacao de entrada. Alguns clientes MCP serializam objetos e listas
// aninhados como string; sem coagir, Object.assign espalha a string em indices
// numericos e a API responde 400/internal_error (Bug 1).
// ---------------------------------------------------------------------------
function comoObjeto(v) {
  if (v === undefined || v === null || v === "") return {};
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return p && typeof p === "object" && !Array.isArray(p) ? p : null;
    } catch (e) {
      return null;
    }
  }
  if (typeof v !== "object" || Array.isArray(v)) return null;
  return Object.assign({}, v);
}

// Atalho e objeto podem trazer o mesmo campo: os dois se somam, sem duplicar.
// Campos-objeto (faixa_receita) nao somam — o atalho substitui.
function mesclarFiltro(doObjeto, doAtalho) {
  if (ehObjetoSimples(doAtalho) || ehObjetoSimples(doObjeto)) {
    return doAtalho !== undefined && doAtalho !== null ? doAtalho : doObjeto;
  }
  const a = doObjeto === undefined || doObjeto === null ? [] : [].concat(doObjeto);
  const b = doAtalho === undefined || doAtalho === null ? [] : [].concat(doAtalho);
  if (!a.length) return doAtalho;
  const vistos = new Set(a.map((x) => String(x)));
  return a.concat(b.filter((x) => !vistos.has(String(x))));
}

function ehObjetoSimples(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Bloqueio dos dois campos comprovadamente quebrados na API, compartilhado pelas
// duas buscas. Mesma semantica de escape em ambas: forcar_campos_quebrados.
function checarCamposQuebrados(filtros, forcar) {
  if (forcar) return null;
  if (filtros.atividades_cnae) {
    return {
      erro:
        "'atividades_cnae' retorna total 0 para qualquer codigo — inclusive o 6201500 que a documentacao oficial usa de exemplo. " +
        "A base B2B e indexada por setor LinkedIn, nao por CNAE. Use 'setores' (ou 'setores_cnae' para o macro-setor). " +
        "Para ignorar este bloqueio passe forcar_campos_quebrados: true.",
    };
  }
  const receitaMin = filtros.faixa_receita && filtros.faixa_receita.receita_minima;
  if (receitaMin && Number(receitaMin) >= 500000000) {
    return {
      erro:
        "faixa_receita.receita_minima >= 500000000 zera o resultado (limiar quebrado na API; 100000000 funciona). " +
        "Prefira uma faixa larga e filtre 'faixa_faturamento' localmente, ou passe forcar_campos_quebrados: true.",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolve um CNPJ (ou URL do LinkedIn) no id_empresa da base B2B.
// 'document' e campo de PRIMEIRO NIVEL do corpo de POST /b2b/companies/ — dentro de
// filtros_empresa a API responde 400 "e necessario preencher pelo menos um filtro",
// que parece corpo vazio mas e campo fora de lugar. Este e o unico caminho documentado
// de CNPJ para id_empresa, e sem ele o vinculo entre empresa e decisor fica so no nome,
// que e heuristico e ja trouxe a empresa errada.
// ---------------------------------------------------------------------------
async function resolverEmpresa(env, { document, url_linkedin }) {
  const corpo = {};
  const doc = document !== undefined && document !== null ? onlyDigits(document) : "";
  if (doc) {
    if (doc.length !== 14) {
      return {
        ok: false,
        erro: { erro: "CNPJ invalido em 'document': " + doc.length + " digitos, esperado 14." },
      };
    }
    corpo.document = doc; // a API aceita com ou sem formatacao; enviamos so digitos
  }
  if (url_linkedin) corpo.url_linkedin = String(url_linkedin);
  if (!Object.keys(corpo).length) {
    return { ok: false, erro: { erro: "Informe document (CNPJ) ou url_linkedin." } };
  }

  const r = await chamarApi(env, { metodo: "POST", caminho: "/b2b/companies/", corpo });
  if (!r.ok) {
    const erro = r.erro || {};
    if (String(erro.erro || "").indexOf("404") !== -1) {
      erro.dica =
        "404 aqui significa que nao existe empresa na base B2B para esse " +
        (doc ? "CNPJ" : "perfil do LinkedIn") +
        ". Nao debitou credito. Confira o documento ou tente pelo nome_empresa (heuristico).";
    }
    return { ok: false, erro };
  }

  const id = buscarProfundo(r.dados, "company_id") || buscarProfundo(r.dados, "id_empresa");
  return {
    ok: true,
    id_empresa: id === null || id === undefined ? null : Number(id),
    document: doc || null,
    dados: r.dados,
  };
}

// ---------------------------------------------------------------------------
// Repassa 'sucesso'/'falhou' do payload: registros que falham sao estornados
// automaticamente, entao esses dois numeros dizem o que ficou cobrado sem precisar
// conferir extrato. O caso que motivou: sucesso 1 / falhou 0 com detalhes_contato null
// — cobrado, sem estorno e sem dado. Sem esse resumo isso passava despercebido.
// ---------------------------------------------------------------------------
function resumirCobranca(payload) {
  const sucesso = buscarProfundo(payload, "sucesso");
  const falhou = buscarProfundo(payload, "falhou");
  if (sucesso === null && falhou === null) return undefined;

  const n = (v) => (v === null || v === undefined ? 0 : Number(v));
  const resumo = {
    sucesso: n(sucesso),
    falhou: n(falhou),
    _leitura:
      "'falhou' foi estornado automaticamente; 'sucesso' ficou cobrado. Confira o saldo com datastone_saldo (custo 0).",
  };

  // Cobrado e vazio e o pior desfecho: nao gera estorno e nao aparece como erro.
  const vazio =
    buscarProfundo(payload, "detalhes_contato") === null &&
    buscarProfundo(payload, "emails") === null &&
    buscarProfundo(payload, "telefones") === null;
  if (n(sucesso) > 0 && vazio) {
    const entrada = buscarProfundo(payload, "tipo_entrada");
    resumo._alerta =
      "sucesso > 0 mas o payload veio sem contato — cobrado sem retorno e SEM estorno automatico" +
      (entrada ? " (a API recebeu tipo_entrada '" + entrada + "')" : "") +
      ". Isso NAO e erro de chamada: ja aconteceu com o id_empresa correto, resolvido por document. " +
      "Ou a empresa nao tem dado enriquecivel, ou a falha e do lado da Data Stone — em ambos os casos vale reclamar o estorno. " +
      "Nao repita o mesmo alvo esperando resultado diferente.";
  }
  return resumo;
}

// Havia filtros de busca junto com 'document'? Serve so para avisar que foram ignorados.
function temFiltrosDeBusca(args) {
  if (ehObjetoSimples(args.filtros_empresa) && Object.keys(args.filtros_empresa).length) return true;
  return CAMPOS_EMPRESA.some((c) => args[c] !== undefined);
}

// A cobranca da busca e por combinacao nova de filtros, e a chave de cache da API leva
// em conta a ORDEM dos valores: ["a","b"] e ["b","a"] sao o mesmo conjunto mas viram
// duas buscas cobradas. Ordenar no servidor deixa o cache deterministico sem depender
// de quem chama manter a ordem estavel entre execucoes.
function ordenarFiltros(filtros) {
  const saida = {};
  for (const k of Object.keys(filtros).sort()) {
    const v = filtros[k];
    // Ordem lexicografica de codepoint: estavel entre execucoes, ao contrario de
    // localeCompare, que depende do locale do runtime.
    saida[k] = Array.isArray(v)
      ? v.slice().sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0))
      : v;
  }
  return saida;
}

// A API nao padroniza o nome do array de resultados; aceita os tres que ja apareceram.
function listaDeResultados(dados, alternativo) {
  if (!dados) return null;
  if (Array.isArray(dados.resultados)) return dados.resultados;
  if (Array.isArray(dados.dados)) return dados.dados;
  if (alternativo && Array.isArray(dados[alternativo])) return dados[alternativo];
  return null;
}

// ---------------------------------------------------------------------------
// Bug 6: a descricao antiga afirmava que cnpj e id_empresa NUNCA vinham juntos
// (42/42 conferidos). Falso: 'Ceabs Servicos S.A.' voltou com cnpj 14117458000130 E
// id_empresa 47374982. E o registro fundido nao e confiavel — no mesmo retorno a
// mesma empresa apareceu de novo so pelo LinkedIn (id 44529221, slug 'ceabs',
// 201-500 funcionarios) enquanto a versao fundida dizia 2-10. A ponte entre as bases
// existe, mas pode grudar o CNPJ no perfil duplicado e magro. Marcar os dois casos
// e de graca e evita gastar credito em cima do id errado.
// ---------------------------------------------------------------------------
function marcarRegistrosFundidos(dados) {
  const lista = listaDeResultados(dados, "empresas");
  if (!lista) return { fundidos: 0, duplicatas: 0 };

  let fundidos = 0;
  const porNome = new Map();

  for (const empresa of lista) {
    if (!empresa || typeof empresa !== "object") continue;

    if (preenchido(empresa.cnpj) && preenchido(empresa.id_empresa)) {
      empresa._registro_fundido =
        "Este registro traz cnpj E id_empresa juntos — cruzamento raro entre a base da Receita e a do LinkedIn. " +
        "Nao trate como confirmacao: ja houve caso em que a fusao ligou o CNPJ a um perfil duplicado da empresa e o porte veio errado. " +
        "Confira nome e localizacao contra os outros registros antes de usar este id_empresa.";
      fundidos++;
    }

    const chave = normalizar(empresa.nome_empresa);
    if (!chave) continue;
    if (!porNome.has(chave)) porNome.set(chave, []);
    porNome.get(chave).push(empresa);
  }

  let duplicatas = 0;
  for (const grupo of porNome.values()) {
    if (grupo.length < 2) continue;
    for (const empresa of grupo) {
      const outros = grupo
        .filter((e) => e !== empresa)
        .map(
          (e) =>
            "{id_empresa: " +
            (preenchido(e.id_empresa) ? e.id_empresa : "null") +
            ", cnpj: " +
            (preenchido(e.cnpj) ? e.cnpj : "null") +
            ", funcionarios: " +
            (e.faixa_funcionarios || "?") +
            "}",
        )
        .join(", ");
      empresa._nome_duplicado =
        "A mesma empresa aparece " +
        grupo.length +
        "x nesta resposta, com dados divergentes: " +
        outros +
        ". Os registros podem discordar no porte e no id — escolha pelo que bate com a empresa real, nao pelo primeiro da lista.";
      duplicatas++;
    }
  }

  return { fundidos, duplicatas };
}

// null, undefined, string vazia e o literal "null" da API contam como ausente.
function preenchido(valor) {
  if (valor === null || valor === undefined) return false;
  const s = String(valor).trim();
  return s !== "" && s !== "null" && s !== "0";
}

// ---------------------------------------------------------------------------
// Bug 4: a busca nao expoe data de fim de vinculo, mas quando o campo 'cargo' cita
// outra empresa a pessoa ja saiu. Marcar isso e de graca e evita o gasto.
// ---------------------------------------------------------------------------
function marcarVinculoSuspeito(dados, nomesBuscados) {
  const lista = listaDeResultados(dados, "pessoas");
  if (!lista) return 0;

  const buscados = [].concat(nomesBuscados || []).map(normalizar).filter(Boolean);
  let marcados = 0;

  for (const pessoa of lista) {
    if (!pessoa || typeof pessoa !== "object") continue;
    const outra = empresaCitadaNoCargo(pessoa.cargo);
    if (!outra) continue;
    // So marca se a empresa citada nao for a que estamos buscando.
    const norm = normalizar(outra);
    if (buscados.some((b) => norm.indexOf(b) !== -1 || b.indexOf(norm) !== -1)) continue;
    pessoa._suspeita_saiu =
      "O cargo cita '" +
      outra +
      "', outra empresa: a pessoa provavelmente ja saiu. Nao enriqueca sem confirmar.";
    marcados++;
  }
  return marcados;
}

// Casa "Diretor @ Didi/99" e "Soc Manager At Pinterest". Fica so em '@' e ' at ' de
// proposito: 'na'/'em' aparecem demais em cargo comum e gerariam falso positivo.
function empresaCitadaNoCargo(cargo) {
  const m = String(cargo || "").match(/(?:@|\sat\s)\s*([^|,;]+)$/i);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Recorte de listar_filtros.
// ---------------------------------------------------------------------------
const APELIDOS_FILTRO = {
  cargos: ["cargos", "roles", "job_titles", "titles"],
  setores: ["setores", "sectors", "industries", "industry"],
  niveis_senioridade: ["niveis_senioridade", "seniority_levels", "seniorities"],
  departamentos: ["departamentos", "departments"],
  especialidades: ["especialidades", "specialties"],
  setores_cnae: ["setores_cnae", "cnae_sectors"],
  estados: ["estados", "states"],
  localizacoes: ["localizacoes", "locations"],
};

// Coleta os valores string de todas as chaves alvo, em qualquer nivel, sem repetir.
function coletarValores(no, alvos, acc, profundidade = 0) {
  const saida = acc || [];
  if (profundidade > 8 || no === null || typeof no !== "object") return saida;

  if (Array.isArray(no)) {
    for (const item of no) coletarValores(item, alvos, saida, profundidade + 1);
    return saida;
  }

  for (const k of Object.keys(no)) {
    if (alvos.indexOf(k) !== -1) {
      for (const v of [].concat(no[k])) {
        if (typeof v === "string" && v) {
          if (saida.indexOf(v) === -1) saida.push(v);
        } else if (v && typeof v === "object") {
          const rotulo = v.nome || v.name || v.label || v.valor || v.value;
          if (typeof rotulo === "string" && rotulo && saida.indexOf(rotulo) === -1) {
            saida.push(rotulo);
          }
        }
      }
    }
    coletarValores(no[k], alvos, saida, profundidade + 1);
  }
  return saida;
}

// Indice barato do que da para pedir, sem despejar os valores.
// A resposta real e uma LISTA de filtros salvos, entao a travessia precisa entrar
// em arrays tambem — parar nelas devolvia um indice vazio.
function listarChaves(no, prefixo = "", acc, profundidade = 0) {
  const saida = acc || [];
  if (profundidade > 5 || no === null || typeof no !== "object") return saida;

  if (Array.isArray(no)) {
    // Uma lista de objetos e um container: o rotulo util esta dentro dos itens.
    for (const item of no) listarChaves(item, prefixo, saida, profundidade + 1);
    return saida;
  }

  for (const k of Object.keys(no)) {
    const caminho = prefixo ? prefixo + "." + k : k;
    const v = no[k];
    if (Array.isArray(v) && v.some((x) => typeof x === "string" || (x && typeof x === "object"))) {
      if (!saida.some((s) => s.startsWith(caminho + " "))) {
        saida.push(caminho + " (" + v.length + " valores)");
      }
      // Entra assim mesmo: pode haver objetos com mais listas la dentro.
      listarChaves(v, caminho, saida, profundidade + 1);
    } else if (v && typeof v === "object") {
      listarChaves(v, caminho, saida, profundidade + 1);
    }
  }
  return saida;
}

// Comparacao sem acento e sem caixa: "operações" casa com "OPERACOES".
function normalizar(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
