"""Spoken commands the assistant handles itself, without asking the model."""

import re

# key -> (spoken label, phrases the transcriber might produce)
GAMES = {
    "simon": ("Simon", (
        "simon", "simon says", "simone", "cyman", "sigh man", "simon game",
    )),
    "difference": ("Difference", (
        "difference", "differences", "different", "spot the difference",
        "find the difference", "odd one out",
    )),
    "scramble": ("Scramble", (
        "scramble", "scrambles", "scrambled", "word scramble", "unscramble",
        # the transcriber reaches for the far more common real word
        "scrabble", "scrable",
    )),
    "multi": ("Multi", (
        "multi", "multie", "multy", "multiply", "multiplication", "times tables",
        "math", "maths", "multi game",
    )),
}

_PLAY = re.compile(
    r"^(?:i'?d like to |i want to |can we |let'?s |lets )?"
    r"(?:play|start|open|launch|begin)\s+(?:a |an |the )?(.+)$",
    re.I,
)
_TRAILING = re.compile(r"\s+(?:game|please|now|for me)$", re.I)


def match_game(text: str):
    """Return (key, label) if this asks to play a game, else None."""
    bare = re.sub(r"[^\w\s']", " ", text or "")
    bare = re.sub(r"\s+", " ", bare).strip()

    m = _PLAY.match(bare)
    if not m:
        return None

    rest = m.group(1).strip().lower()
    while True:
        trimmed = _TRAILING.sub("", rest).strip()
        if trimmed == rest:
            break
        rest = trimmed

    for key, (label, aliases) in GAMES.items():
        if rest in aliases:
            return key, label

    # Looser pass: the name appearing anywhere in what followed "play".
    for key, (label, aliases) in GAMES.items():
        for alias in aliases:
            if re.search(rf"\b{re.escape(alias)}\b", rest):
                return key, label

    return None


# The forecast is ours too - it's a lookup, not a question for the model.
_WEATHER = re.compile(
    r"\b(weather|forecast|temperature|how (?:hot|cold|warm) is it|"
    r"is it (?:going to |gonna )?(?:rain|snow)|will it (?:rain|snow))\b",
    re.I,
)
# "weather" turns up inside questions that are really about somewhere else, or
# some other day, and those belong to the model.
_ELSEWHERE = re.compile(
    r"\b(?:in|at|for)\s+"
    r"(?!(?:my|me|us|all|here|home|today|tonight|right now|"
    r"the (?:week|day|next|rest))\b)[a-z]|"
    r"\b(?:last|next|yesterday|tomorrow|weekend|month|year)\b",
    re.I,
)


def match_weather(text: str) -> bool:
    """True if this is a plain 'what's the weather' about here and now."""
    bare = re.sub(r"[^\w\s']", " ", text or "")
    bare = re.sub(r"\s+", " ", bare).strip()
    if not _WEATHER.search(bare):
        return False
    return not _ELSEWHERE.search(bare)


# Medora is the pill dispenser, and it has an app of its own. Asking for it
# by name, or for the next dose, is a lookup in the schedule - the model has
# tools for the rest.
_MEDORA_OPEN = re.compile(
    r"^(?:(?:please|hey|okay|ok)\s+)?"
    r"(?:(?:can|could|would) you\s+|i(?:'d| would) like to\s+|i want to\s+|"
    r"let'?s\s+|lets\s+)?"
    r"(?:open|show|bring up|pull up|launch|start|go to|check)\s+"
    r"(?:me\s+)?(?:my|the)?\s*"
    r"(?:medora|medicines?|medications?|pills?|pill\s?box|dispenser|"
    r"medicine app|medication list)\b",
    re.I,
)

# Only the plainly schedule-shaped questions. "Should I take ibuprofen for
# this?" is a question about medicine, not about the schedule, and it
# belongs to the model.
_MEDORA_DUE = re.compile(
    r"\bnext\s+(?:dose|pill|medicine|medication|tablet)\b|"
    r"\b(?:dose|pill|medicine|medication|tablet)s?\s+(?:is\s+|are\s+)?due\b|"
    r"\b(?:anything|something)\s+due\b|"
    r"\bdue\s+(?:now|yet)\b|"
    r"\bwhat\s+(?:do|should)\s+i\s+take\s+next\b",
    re.I,
)


# "test medora" runs the hardware: the lights, the buzzer, the screen. Only
# the word "test" does it - "check medora" is too easy to say by accident for
# something that beeps and flashes in the room.
_MEDORA_TEST = re.compile(
    r"^(?:(?:please|hey|okay|ok)\s+)?"
    r"(?:(?:can|could|would) you\s+|i want to\s+|let'?s\s+|lets\s+)?"
    r"(?:run\s+a\s+)?(?:self\s+)?test\s+"
    r"(?:out\s+)?(?:on\s+|of\s+)?(?:my\s+|the\s+)?"
    r"(?:medora|dispenser|pill\s?box|pill dispenser|device)\b",
    re.I,
)

# Reading the whole list out. The qualifier is required, so "what is the best
# time to take medications?" stays a question for the model.
_MEDORA_LIST = re.compile(
    r"\b(?:read|list|tell me|say|go through|run through|"
    r"what are|what'?s|what is)\s+"
    r"(?:me\s+|out\s+)?(?:my|the)\s+"
    r"(?:upcoming|next|remaining|scheduled|today'?s)?\s*"
    r"(?:doses|dose schedule|schedule|medicines|medications)\b",
    re.I,
)


def match_medora(text: str):
    """Which Medora command this is, or None.

    'test' runs the dispenser's hardware, 'list' reads the doses coming up,
    'next' answers what is due, and 'open' just brings the app up."""
    bare = re.sub(r"[^\w\s']", " ", text or "")
    bare = re.sub(r"\s+", " ", bare).strip()
    if not bare:
        return None

    if _MEDORA_TEST.match(bare):
        return "test"
    if _MEDORA_OPEN.match(bare):
        return "open"
    if _MEDORA_LIST.search(bare):
        return "list"
    if _MEDORA_DUE.search(bare):
        return "next"
    return None


# ============================================================
# News
#
# Nine commands, because a senior listening to headlines needs to be able to
# say the obvious next thing: more about that one, the next one, say it
# again. "more" and "next" are only ours while something is actually being
# read - app.py checks that - since on their own they follow any answer.
# ============================================================

_NEWS = r"(?:news|headlines?|stories|story)"

# Spoken ways of asking for each section we carry.
NEWS_CATEGORIES = {
    "world": ("world", "international", "global", "overseas", "abroad", "foreign"),
    "nation": ("national", "nation", "america", "american", "domestic",
               "the country", "here at home"),
    "business": ("business", "money", "economy", "economic", "market", "markets",
                 "finance", "financial", "stocks", "wall street"),
    "health": ("health", "medical", "healthcare", "health care"),
    "science": ("science", "scientific", "space", "technology", "tech", "climate"),
    "sports": ("sports", "sport", "baseball", "football", "basketball", "hockey",
               "golf", "tennis"),
    "arts": ("arts", "art", "entertainment", "culture", "movies", "film", "films",
             "music", "books", "television", "tv", "celebrity", "celebrities"),
}

_NEWS_SETTINGS = re.compile(
    rf"\b{_NEWS}\s+(?:settings|options|preferences)\b|"
    rf"\b(?:change|edit|pick|choose|set|update|adjust|fix)\s+(?:my\s+|the\s+)?"
    rf"(?:{_NEWS}\s+)?(?:settings|topics|categories|sections|interests|preferences)\b|"
    rf"\b(?:change|pick|choose)\s+(?:what|which)\s+{_NEWS}\b",
    re.I,
)

_NEWS_FOLLOWING = re.compile(
    rf"\b(?:what|which)\s+(?:kinds? of\s+|sorts? of\s+)?(?:{_NEWS}\s+)?"
    rf"(?:topics|categories|sections|subjects)?\s*(?:am i|do i)\s+"
    rf"(?:following|getting|subscribed to|set up for|reading)\b|"
    rf"\bwhat\s+{_NEWS}\s+am i\b|"
    rf"\bwhat\s+(?:am i|do i)\s+(?:following|getting)\b",
    re.I,
)

_NEWS_OPEN = re.compile(
    rf"^(?:(?:please|hey|okay|ok)\s+)?"
    rf"(?:(?:can|could|would) you\s+|i want to\s+|let'?s\s+|lets\s+)?"
    rf"(?:open|show|bring up|pull up|launch|go to)\s+"
    rf"(?:me\s+)?(?:the\s+|my\s+)?{_NEWS}\b",
    re.I,
)

_NEWS_REFRESH = re.compile(
    rf"\b(?:refresh|reload|update|fetch|check for|look for)\s+"
    rf"(?:the\s+|my\s+)?(?:latest\s+|newest\s+)?{_NEWS}\b|"
    rf"\b(?:get|bring)\s+(?:me\s+)?(?:the\s+)?(?:latest|newest|fresh)\s+{_NEWS}\b|"
    rf"\bany\s+(?:newer|fresh|new)\s+{_NEWS}\b",
    re.I,
)

_NEWS_REPEAT = re.compile(
    rf"\b(?:say|read|tell me)\s+(?:that|it|those|them|the {_NEWS})\s+again\b|"
    rf"\brepeat\s+(?:that|the {_NEWS}|the last one)\b|"
    rf"\b(?:what|who)\s+(?:was|were)\s+that\s+again\b",
    re.I,
)

_NEWS_NEXT = re.compile(
    rf"\b(?:next|another)\s+(?:{_NEWS}|one|headline|article)\b|"
    rf"\bwhat'?s\s+next\b|\bmove on\b|\bskip (?:it|that|this one)\b|"
    rf"\bgo on to the next\b",
    re.I,
)

_NEWS_MORE = re.compile(
    r"\btell me more\b|\bmore (?:about|on) (?:that|this|it|the story)\b|"
    r"\b(?:read|tell) me (?:the )?(?:rest|whole|full|more)\b|"
    r"\bwhat else (?:does it|do they) say\b|\bgo on\b|"
    r"\bread (?:me )?(?:that|it) (?:to me|in full)\b",
    re.I,
)

_NEWS_HEADLINES = re.compile(
    rf"\b(?:what'?s|what is)\s+(?:in\s+)?(?:the\s+|today'?s\s+)?{_NEWS}\b|"
    rf"\b(?:any|the latest|latest|today'?s)\s+{_NEWS}\b|"
    rf"\b(?:tell|read|give|catch)\s+(?:me\s+)?(?:up on\s+)?(?:the\s+|some\s+|today'?s\s+)?{_NEWS}\b|"
    rf"\bwhat'?s\s+(?:going on|happening)\s+in the world\b|"
    rf"\bwhat happened\s+(?:today|in the world)\b|"
    rf"\bcatch me up\b",
    re.I,
)

# "Is there any news about the election?" is a question for the model, which
# can search for it. Only a section we actually carry is ours.
_NEWS_ABOUT = re.compile(rf"{_NEWS}\s+(?:about|on|regarding|concerning)\s+(.+)$", re.I)


def _news_category(text):
    for key, aliases in NEWS_CATEGORIES.items():
        for alias in aliases:
            if re.search(rf"\b{re.escape(alias)}\b", text, re.I):
                return key
    return None


def match_news(text: str):
    """Which news command this is - (kind, category) - or None.

    Kinds: settings, following, open, refresh, repeat, next, more,
    category, headlines."""
    bare = re.sub(r"[^\w\s']", " ", text or "")
    bare = re.sub(r"\s+", " ", bare).strip()
    if not bare:
        return None

    if _NEWS_SETTINGS.search(bare):
        return ("settings", None)
    if _NEWS_FOLLOWING.search(bare):
        return ("following", None)
    if _NEWS_OPEN.match(bare):
        return ("open", None)
    if _NEWS_REFRESH.search(bare):
        return ("refresh", None)
    if _NEWS_REPEAT.search(bare):
        return ("repeat", None)
    if _NEWS_NEXT.search(bare):
        return ("next", None)
    if _NEWS_MORE.search(bare):
        return ("more", None)

    about = _NEWS_ABOUT.search(bare)
    if about:
        # "news about health" is a section; "news about the election" is not.
        category = _news_category(about.group(1))
        return ("category", category) if category else None

    if re.search(rf"\b{_NEWS}\b", bare) or _NEWS_HEADLINES.search(bare):
        category = _news_category(bare)
        if category:
            return ("category", category)

    if _NEWS_HEADLINES.search(bare):
        return ("headlines", None)
    return None
