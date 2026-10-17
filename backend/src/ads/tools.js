const s = (description) => ({ type: 'string', description });
const n = (description) => ({ type: 'number', description });
const why = {
  title: s('Título corto de la recomendación, en lenguaje simple (ej. "Pausar el anuncio de lámparas colgantes")'),
  reason: s('Por qué, con los números que lo justifican (ventas reales, ROAS real, gasto)'),
  expected_impact: s('Qué esperás que pase y cuándo se va a poder medir'),
};
const whyReq = ['title', 'reason', 'expected_impact'];

// Las acciones sobre Meta (pausar, activar, presupuesto, conjuntos, anuncios) quedan como recomendaciones
// pendientes de aprobación en el panel, salvo que el modo autónomo esté prendido: ahí pausar un anuncio se ejecuta solo.
export const TOOL_DEFINITIONS = [
  {
    name: 'pause_ad',
    description: 'Pausar un anuncio. Usalo con anuncios que gastaron de verdad sin generar ventas reales, o con fatiga clara. Nunca dejes un conjunto activo sin anuncios.',
    input_schema: { type: 'object', properties: { ad_id: s('ID del anuncio'), ad_name: s('Nombre del anuncio'), ...why }, required: ['ad_id', ...whyReq] },
  },
  {
    name: 'set_status',
    description: 'Proponer pausar o activar una campaña, un conjunto o un anuncio. Activar algo empieza a gastar plata: siempre queda pendiente de aprobación.',
    input_schema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['campaign', 'adset', 'ad'] },
        object_id: s('ID del objeto'), object_name: s('Nombre del objeto'),
        status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] },
        ...why,
      },
      required: ['level', 'object_id', 'status', ...whyReq],
    },
  },
  {
    name: 'propose_budget_change',
    description: 'Proponer cambiar el presupuesto diario de una campaña (CBO) o de un conjunto. En PESOS. Cambios de hasta ±20% por vez y respetando el tope mensual.',
    input_schema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['campaign', 'adset'] }, object_id: s('ID'), object_name: s('Nombre'),
        current_budget_ars: n('Presupuesto diario actual en pesos'), proposed_budget_ars: n('Presupuesto diario propuesto en pesos'),
        ...why,
      },
      required: ['level', 'object_id', 'current_budget_ars', 'proposed_budget_ars', ...whyReq],
    },
  },
  {
    name: 'propose_adset',
    description: 'Proponer un conjunto nuevo dentro de una campaña de ventas existente (por ejemplo para probar otro público). Buscá antes los intereses reales con search_interest — nunca inventes IDs. El conjunto se crea PAUSADO y optimiza igual que los otros conjuntos de esa campaña (compras en la web); sin presupuesto propio si la campaña es CBO.',
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: s('ID de la campaña'),
        name: s('Nombre del conjunto, en MAYÚSCULAS con guiones bajos (ej. INT_DECO_HOGAR_AMBA)'),
        targeting: { type: 'object', description: 'Targeting de Graph API: geo_locations, age_min, age_max, flexible_spec con intereses, targeting_automation.advantage_audience (0 o 1)' },
        daily_budget_ars: n('Solo si la campaña NO es CBO: presupuesto diario del conjunto en pesos'),
        creative_id: s('Opcional: id de una pieza sin usar para crear el anuncio en el mismo paso'),
        ...why,
      },
      required: ['campaign_id', 'name', 'targeting', ...whyReq],
    },
  },
  {
    name: 'create_ad',
    description: 'Proponer publicar una pieza subida al panel (de la lista unusedCreatives) como anuncio en un conjunto, con botón "Comprar" al link de la pieza. El anuncio nace ACTIVO dentro del conjunto (si el conjunto está pausado no gasta).',
    input_schema: { type: 'object', properties: { creative_id: s('id de la pieza en el panel'), adset_id: s('ID del conjunto destino'), adset_name: s('Nombre del conjunto'), ...why }, required: ['creative_id', 'adset_id', ...whyReq] },
  },
  {
    name: 'promote_ig_post',
    description: 'Proponer promocionar un post o reel que ya está publicado en el Instagram de Altorancho (lista igPosts) como anuncio en un conjunto, con botón "Comprar". Usa el post original: suma sus likes y comentarios, y el texto es el del post (no se edita). Si el post muestra un producto puntual, pasá el link de ese producto. No lo propongas si ya está en promotedIn para ese conjunto.',
    input_schema: {
      type: 'object',
      properties: {
        ig_media_id: s('id del post (de igPosts)'), adset_id: s('ID del conjunto destino'), adset_name: s('Nombre del conjunto'),
        permalink: s('Link del post (de igPosts)'),
        link: s('Opcional: link de la tienda al que lleva el botón (ej. https://altorancho.com/productos/...). Si falta, va a la home.'),
        ...why,
      },
      required: ['ig_media_id', 'adset_id', ...whyReq],
    },
  },
  {
    name: 'search_interest',
    description: 'Buscar intereses reales de Meta (con tamaño de público) para armar segmentaciones. Solo lectura.',
    input_schema: { type: 'object', properties: { query: s('Término, ej. "decoración de interiores", "iluminación"') }, required: ['query'] },
  },
  {
    name: 'request_creative',
    description: 'Pedirle al equipo una pieza nueva cuando hace falta (no hay piezas sin usar, fatiga, producto o ángulo sin probar). Sé concreto: formato, producto, qué se ve, qué dice, a qué link lleva, por qué.',
    input_schema: {
      type: 'object',
      properties: { concept: s('Idea de la pieza en una línea'), style_notes: s('Formato (feed 4:5 y/o historia 9:16, imagen o video), producto, qué mostrar, texto, tono, link'), reason: s('Por qué hace falta ahora') },
      required: ['concept', 'style_notes', 'reason'],
    },
  },
  {
    name: 'save_learning',
    description: 'Guardar o actualizar un aprendizaje con evidencia repetida (mínimo 2-3 observaciones consistentes, nunca de una sola muestra). Pasá learning_id para actualizar o marcarlo obsolete.',
    input_schema: { type: 'object', properties: { learning_id: s('ID existente (omitir para crear)'), text: s('El aprendizaje, corto y accionable'), evidence: s('Evidencia con fechas y números'), status: { type: 'string', enum: ['active', 'obsolete'] } }, required: ['text', 'evidence'] },
  },
  {
    name: 'record_outcome',
    description: 'Registrar qué pasó realmente después de una decisión ejecutada (lista decisionsToEvaluate), con números de ventas reales.',
    input_schema: { type: 'object', properties: { decision_id: s('ID de la decisión'), outcome: s('Resultado medido') }, required: ['decision_id', 'outcome'] },
  },
  {
    name: 'ask_team',
    description: 'Hacerle una pregunta al equipo cuando te falta un dato que solo ellos tienen (stock, márgenes, promos, lanzamientos, productos a empujar, tope de inversión). La ven en el panel y la contestan; la respuesta te llega en answeredQuestions en una próxima corrida. Una pregunta por llamada, concreta y que se pueda contestar en una o dos líneas. No repitas preguntas que sigan en openQuestions.',
    input_schema: {
      type: 'object',
      properties: {
        question: s('La pregunta, concreta (ej. "¿Hay stock suficiente de la lámpara Nórdica para subirle el presupuesto 20%?")'),
        why: s('Qué decisión destraba la respuesta'),
        quick_answers: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Opcional: hasta 4 respuestas típicas cortas para contestar con un toque (ej. "Sí", "No")' },
      },
      required: ['question', 'why'],
    },
  },
];

export const READ_ONLY_TOOLS = new Set(['search_interest']);
export const META_ACTIONS = new Set(['pause_ad', 'set_status', 'propose_budget_change', 'propose_adset', 'create_ad', 'promote_ig_post']);
