"""Web search through Exa, exposed to the model as a tool it may choose to call."""

import concurrent.futures
import logging
import os

import requests

log = logging.getLogger(__name__)

API_URL = "https://ai.hackclub.com/proxy/v1/exa/search"
RESULTS = int(os.getenv("EXA_RESULTS", "4"))
SNIPPET = int(os.getenv("EXA_SNIPPET", "800"))
TIMEOUT = 25

TOOL = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": (
            "Search the web for current or specific information. Use it for "
            "anything that changes or that you cannot be sure of: news, "
            "weather, sport, prices, opening hours, schedules, people's "
            "current roles, or any fact from after your training. Do not use "
            "it for general knowledge, arithmetic, definitions, recipes, or "
            "anything you already know reliably - answering directly is "
            "faster, and the person is waiting in silence."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query, as you would type it into a search engine.",
                }
            },
            "required": ["query"],
        },
    },
}

def _one(query: str) -> str:
    """Run a single search and render it as plain text for the model."""
    api_key = os.getenv("HACKCLUB_API_KEY")
    try:
        resp = requests.post(
            API_URL,
            headers={"Authorization": f"Bearer {api_key}",
                     "Content-Type": "application/json"},
            json={
                "query": query,
                "numResults": RESULTS,
                "contents": {"text": {"maxCharacters": SNIPPET}},
            },
            timeout=TIMEOUT,
        )
    except requests.RequestException as exc:
        log.warning("exa request failed for %r: %s", query, exc)
        return "The search could not be completed."

    if not resp.ok:
        log.warning("exa %s for %r: %s", resp.status_code, query, resp.text[:200])
        return "The search could not be completed."

    try:
        results = resp.json().get("results") or []
    except ValueError:
        return "The search could not be completed."

    if not results:
        return f"No results for {query!r}."

    lines = []
    for r in results:
        text = " ".join((r.get("text") or "").split())
        published = (r.get("publishedDate") or "")[:10]
        lines.append(
            f"[{r.get('title') or 'Untitled'}]"
            f"{' (' + published + ')' if published else ''}\n"
            f"{text[:SNIPPET]}"
        )
    log.info("exa %r -> %d result(s)", query, len(results))
    return "\n\n".join(lines)

def run(queries):
    """Run several searches at once. Returns a list of rendered results."""
    if len(queries) == 1:
        return [_one(queries[0])]
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(queries)) as pool:
        return list(pool.map(_one, queries))
