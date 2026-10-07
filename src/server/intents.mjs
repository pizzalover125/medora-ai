const bareOf = (text) => (text || '').replace(/[^\w\s']/g, ' ').replace(/\s+/g, ' ').trim();
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const GAMES = {
  simon: ['Simon', ['simon', 'simon says', 'simone', 'cyman', 'sigh man', 'simon game']],
  difference: ['Difference', ['difference', 'differences', 'different', 'spot the difference',
                              'find the difference', 'odd one out']],
  scramble: ['Scramble', ['scramble', 'scrambles', 'scrambled', 'word scramble', 'unscramble',
                          'scrabble', 'scrable']],
  multi: ['Multi', ['multi', 'multie', 'multy', 'multiply', 'multiplication', 'times tables',
                    'math', 'maths', 'multi game']],
};

const PLAY = /^(?:i'?d like to |i want to |can we |let'?s |lets )?(?:play|start|open|launch|begin)\s+(?:a |an |the )?(.+)$/i;
const TRAILING = /\s+(?:game|please|now|for me)$/i;

export function matchGame(text) {
  const m = PLAY.exec(bareOf(text));
  if (!m) return null;
  let rest = m[1].trim().toLowerCase();
  for (;;) {
    const trimmed = rest.replace(TRAILING, '').trim();
    if (trimmed === rest) break;
    rest = trimmed;
  }
  for (const [key, [label, aliases]] of Object.entries(GAMES)) {
    if (aliases.includes(rest)) return [key, label];
  }
  for (const [key, [label, aliases]] of Object.entries(GAMES)) {
    if (aliases.some((alias) => new RegExp(`\\b${escape(alias)}\\b`).test(rest))) return [key, label];
  }
  return null;
}

const WEATHER = /\b(weather|forecast|temperature|how (?:hot|cold|warm) is it|is it (?:going to |gonna )?(?:rain|snow)|will it (?:rain|snow))\b/i;
const ELSEWHERE = /\b(?:in|at|for)\s+(?!(?:my|me|us|all|here|home|today|tonight|right now|the (?:week|day|next|rest))\b)[a-z]|\b(?:last|next|yesterday|tomorrow|weekend|month|year)\b/i;

export function matchWeather(text) {
  const bare = bareOf(text);
  return WEATHER.test(bare) && !ELSEWHERE.test(bare);
}

const MEDORA_OPEN = new RegExp(String.raw`^(?:(?:please|hey|okay|ok)\s+)?` +
  String.raw`(?:(?:can|could|would) you\s+|i(?:'d| would) like to\s+|i want to\s+|let'?s\s+|lets\s+)?` +
  String.raw`(?:open|show|bring up|pull up|launch|start|go to|check)\s+` +
  String.raw`(?:me\s+)?(?:my|the)?\s*` +
  String.raw`(?:medora|medicines?|medications?|pills?|pill\s?box|dispenser|medicine app|medication list)\b`, 'i');

const MEDORA_DUE = new RegExp(String.raw`\bnext\s+(?:dose|pill|medicine|medication|tablet)\b|` +
  String.raw`\b(?:dose|pill|medicine|medication|tablet)s?\s+(?:is\s+|are\s+)?due\b|` +
  String.raw`\b(?:anything|something)\s+due\b|` +
  String.raw`\bdue\s+(?:now|yet)\b|` +
  String.raw`\bwhat\s+(?:do|should)\s+i\s+take\s+next\b`, 'i');

const MEDORA_TEST = new RegExp(String.raw`^(?:(?:please|hey|okay|ok)\s+)?` +
  String.raw`(?:(?:can|could|would) you\s+|i want to\s+|let'?s\s+|lets\s+)?` +
  String.raw`(?:run\s+a\s+)?(?:self\s+)?test\s+` +
  String.raw`(?:out\s+)?(?:on\s+|of\s+)?(?:my\s+|the\s+)?` +
  String.raw`(?:medora|dispenser|pill\s?box|pill dispenser|device)\b`, 'i');

const MEDORA_LIST = new RegExp(String.raw`\b(?:read|list|tell me|say|go through|run through|` +
  String.raw`what are|what'?s|what is)\s+` +
  String.raw`(?:me\s+|out\s+)?(?:my|the)\s+` +
  String.raw`(?:upcoming|next|remaining|scheduled|today'?s)?\s*` +
  String.raw`(?:doses|dose schedule|schedule|medicines|medications)\b`, 'i');

export function matchMedora(text) {
  const bare = bareOf(text);
  if (!bare) return null;
  if (MEDORA_TEST.test(bare)) return 'test';
  if (MEDORA_OPEN.test(bare)) return 'open';
  if (MEDORA_LIST.test(bare)) return 'list';
  if (MEDORA_DUE.test(bare)) return 'next';
  return null;
}

const NEWS = String.raw`(?:news|headlines?|stories|story)`;

const NEWS_CATEGORIES = {
  world: ['world', 'international', 'global', 'overseas', 'abroad', 'foreign'],
  nation: ['national', 'nation', 'america', 'american', 'domestic', 'the country', 'here at home'],
  business: ['business', 'money', 'economy', 'economic', 'market', 'markets', 'finance',
             'financial', 'stocks', 'wall street'],
  health: ['health', 'medical', 'healthcare', 'health care'],
  science: ['science', 'scientific', 'space', 'technology', 'tech', 'climate'],
  sports: ['sports', 'sport', 'baseball', 'football', 'basketball', 'hockey', 'golf', 'tennis'],
  arts: ['arts', 'art', 'entertainment', 'culture', 'movies', 'film', 'films', 'music', 'books',
         'television', 'tv', 'celebrity', 'celebrities'],
};

const r = (source) => new RegExp(source, 'i');

const NEWS_SETTINGS = r(String.raw`\b${NEWS}\s+(?:settings|options|preferences)\b|` +
  String.raw`\b(?:change|edit|pick|choose|set|update|adjust|fix)\s+(?:my\s+|the\s+)?` +
  String.raw`(?:${NEWS}\s+)?(?:settings|topics|categories|sections|interests|preferences)\b|` +
  String.raw`\b(?:change|pick|choose)\s+(?:what|which)\s+${NEWS}\b`);

const NEWS_FOLLOWING = r(String.raw`\b(?:what|which)\s+(?:kinds? of\s+|sorts? of\s+)?(?:${NEWS}\s+)?` +
  String.raw`(?:topics|categories|sections|subjects)?\s*(?:am i|do i)\s+` +
  String.raw`(?:following|getting|subscribed to|set up for|reading)\b|` +
  String.raw`\bwhat\s+${NEWS}\s+am i\b|` +
  String.raw`\bwhat\s+(?:am i|do i)\s+(?:following|getting)\b`);

const NEWS_OPEN = r(String.raw`^(?:(?:please|hey|okay|ok)\s+)?` +
  String.raw`(?:(?:can|could|would) you\s+|i want to\s+|let'?s\s+|lets\s+)?` +
  String.raw`(?:open|show|bring up|pull up|launch|go to)\s+` +
  String.raw`(?:me\s+)?(?:the\s+|my\s+)?${NEWS}\b`);

const NEWS_REFRESH = r(String.raw`\b(?:refresh|reload|update|fetch|check for|look for)\s+` +
  String.raw`(?:the\s+|my\s+)?(?:latest\s+|newest\s+)?${NEWS}\b|` +
  String.raw`\b(?:get|bring)\s+(?:me\s+)?(?:the\s+)?(?:latest|newest|fresh)\s+${NEWS}\b|` +
  String.raw`\bany\s+(?:newer|fresh|new)\s+${NEWS}\b`);

const NEWS_REPEAT = r(String.raw`\b(?:say|read|tell me)\s+(?:that|it|those|them|the ${NEWS})\s+again\b|` +
  String.raw`\brepeat\s+(?:that|the ${NEWS}|the last one)\b|` +
  String.raw`\b(?:what|who)\s+(?:was|were)\s+that\s+again\b`);

const NEWS_NEXT = r(String.raw`\b(?:next|another)\s+(?:${NEWS}|one|headline|article)\b|` +
  String.raw`\bwhat'?s\s+next\b|\bmove on\b|\bskip (?:it|that|this one)\b|` +
  String.raw`\bgo on to the next\b`);

const NEWS_MORE = r(String.raw`\btell me more\b|\bmore (?:about|on) (?:that|this|it|the story)\b|` +
  String.raw`\b(?:read|tell) me (?:the )?(?:rest|whole|full|more)\b|` +
  String.raw`\bwhat else (?:does it|do they) say\b|\bgo on\b|` +
  String.raw`\bread (?:me )?(?:that|it) (?:to me|in full)\b`);

const NEWS_HEADLINES = r(String.raw`\b(?:what'?s|what is)\s+(?:in\s+)?(?:the\s+|today'?s\s+)?${NEWS}\b|` +
  String.raw`\b(?:any|the latest|latest|today'?s)\s+${NEWS}\b|` +
  String.raw`\b(?:tell|read|give|catch)\s+(?:me\s+)?(?:up on\s+)?(?:the\s+|some\s+|today'?s\s+)?${NEWS}\b|` +
  String.raw`\bwhat'?s\s+(?:going on|happening)\s+in the world\b|` +
  String.raw`\bwhat happened\s+(?:today|in the world)\b|` +
  String.raw`\bcatch me up\b`);

const NEWS_ABOUT = r(String.raw`${NEWS}\s+(?:about|on|regarding|concerning)\s+(.+)$`);

function newsCategory(text) {
  for (const [key, aliases] of Object.entries(NEWS_CATEGORIES)) {
    if (aliases.some((alias) => new RegExp(`\\b${escape(alias)}\\b`, 'i').test(text))) return key;
  }
  return null;
}

export function matchNews(text) {
  const bare = bareOf(text);
  if (!bare) return null;
  if (NEWS_SETTINGS.test(bare)) return ['settings', null];
  if (NEWS_FOLLOWING.test(bare)) return ['following', null];
  if (NEWS_OPEN.test(bare)) return ['open', null];
  if (NEWS_REFRESH.test(bare)) return ['refresh', null];
  if (NEWS_REPEAT.test(bare)) return ['repeat', null];
  if (NEWS_NEXT.test(bare)) return ['next', null];
  if (NEWS_MORE.test(bare)) return ['more', null];

  const about = NEWS_ABOUT.exec(bare);
  if (about) {
    const category = newsCategory(about[1]);
    return category ? ['category', category] : null;
  }
  if (new RegExp(`\\b${NEWS}\\b`, 'i').test(bare) || NEWS_HEADLINES.test(bare)) {
    const category = newsCategory(bare);
    if (category) return ['category', category];
  }
  if (NEWS_HEADLINES.test(bare)) return ['headlines', null];
  return null;
}
