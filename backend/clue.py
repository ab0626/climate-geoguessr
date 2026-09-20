"""Player-facing clue generation.

The deterministic template path is the default and the fallback. Every phrase is
a function of measured features and their ranks within the processed table.
An optional
LLM path (OPENAI_API_KEY set) rewrites the template clue for variety but is
constrained to the same facts and verified with `verify_clue` before use.
"""

from __future__ import annotations

import os
import re

from features.build import FEATURE_DEFS


def band(pct: float, low: str, mid_low: str, mid: str, mid_high: str, high: str) -> str:
    if pct < 15:
        return low
    if pct < 35:
        return mid_low
    if pct < 65:
        return mid
    if pct < 85:
        return mid_high
    return high


def template_clue(loc: dict) -> tuple[str, list[dict]]:
    """Return a climate description and the measured facts used to build it."""
    p = {k[4:]: v for k, v in loc.items() if k.startswith("pct_")}
    facts: list[dict] = []

    def use(feature: str, phrase: str) -> str:
        facts.append(
            {
                "feature": feature,
                "label": FEATURE_DEFS[feature]["label"],
                "value": loc[feature],
                "unit": FEATURE_DEFS[feature]["unit"],
                "percentile": round(p[feature], 1),
                "phrase": phrase,
            }
        )
        return phrase

    summer = use(
        "summer_mean_temp_f",
        band(
            p["summer_mean_temp_f"],
            "summer keeps the heat on a short leash",
            "summer warmth stays gentle",
            "summer brings a warm glow",
            "summer turns up the heat",
            "summer heat takes centre stage",
        ),
    )
    winter = use(
        "winter_mean_temp_f",
        band(
            p["winter_mean_temp_f"],
            "winter brings a deep chill",
            "winter has a sharp bite",
            "winter keeps a cool edge",
            "winter takes a gentler turn",
            "winter is among the mildest in this station network",
        ),
    )
    humid = use(
        "summer_dewpoint_f",
        band(
            p["summer_dewpoint_f"],
            "the summer air feels crisp and dry",
            "the summer air leans dry",
            "the summer air sits between dry and muggy",
            "the summer air carries a humid weight",
            "the summer air feels thick with moisture",
        ),
    )
    precip = use(
        "annual_precip_in",
        band(
            p["annual_precip_in"],
            "Precipitation is a small budget here, among the lowest in our station network",
            "The annual water budget is leaner than at most stations",
            "The annual water budget sits near the middle of our station network",
            "The annual water budget is more generous than at most stations",
            "This is one of the wettest spots in our station network",
        ),
    )
    accents = {
        "frozen_precip_days_per_year": band(
            p["frozen_precip_days_per_year"],
            "Cold and wet rarely meet here compared with other stations",
            "Cold, wet days are less common here than at most stations",
            "Cold, wet days occur at a fairly typical rate",
            "Cold and wet meet more often here than at most stations",
            "Cold, wet days are a defining clue, among the most common in our network",
        ),
        "mean_wind_mph": band(
            p["mean_wind_mph"],
            "The wind is a quieter presence than at most stations",
            "Winds tend toward the lighter side",
            "The wind sits near the middle of the pack",
            "A stronger-than-usual breeze adds to the feel of this place",
            "Wind is a signature here, with some of the strongest averages in our network",
        ),
        "diurnal_temp_range_f": band(
            p["diurnal_temp_range_f"],
            "Daytime warmth gives way to only a small temperature drop",
            "The temperature takes a modest step down after daytime warmth",
            "The day-to-night temperature swing is near the middle of the pack",
            "Daytime warmth gives way to a pronounced temperature drop",
            "The leap from daytime warmth to the coolest hours is unusually large",
        ),
    }
    accent_feature = max(accents, key=lambda feature: abs(p[feature] - 50))
    accent = use(accent_feature, accents[accent_feature])
    share = loc["summer_precip_fraction"]
    if share < 0.15:
        season_phrase = "summer receives only a small slice of the year's precipitation"
    elif share < 0.35:
        season_phrase = "summer takes a modest share of the year's precipitation"
    elif share <= 0.5:
        season_phrase = "a sizeable share of the year's precipitation arrives in summer"
    else:
        season_phrase = "more than half the year's precipitation arrives in summer"
    seasonal = use(
        "summer_precip_fraction",
        season_phrase,
    )
    text = (
        f"Picture a place where {summer}, while {winter}. "
        f"{humid[0].upper() + humid[1:]}. "
        f"{precip}; {seasonal}. {accent}."
    )
    return text, facts


NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")


def verify_clue(text: str, loc: dict, facts: list[dict]) -> tuple[bool, list[str]]:
    """Reject clues that leak identity or state numbers not in the profile."""
    problems = []
    lowered = text.lower()
    for token in (loc.get("name") or "", loc.get("state") or "", loc.get("icao") or ""):
        token = token.strip().lower()
        if len(token) >= 3 and token in lowered:
            problems.append(f"mentions identifying token '{token}'")
    allowed = {round(f["value"], 0) for f in facts} | {round(f["value"], 1) for f in facts}
    for n in NUMBER_RE.findall(text):
        val = float(n)
        if val not in allowed and round(val) not in allowed:
            problems.append(f"number {n} not in structured profile")
    return not problems, problems


def llm_clue(template: str, facts: list[dict]) -> str | None:
    """Optional rewrite via OpenAI. Returns None when unavailable or unverifiable."""
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        return None
    try:
        import httpx

        fact_lines = "\n".join(
            f"- {f['label']}: {f['phrase']} ({f['percentile']:.0f}th percentile)" for f in facts
        )
        prompt = (
            "Rewrite the following climate clue for a geography guessing game in two vivid sentences. "
            "Use ONLY the facts listed. Do not add numbers, place names, states, landmarks, or any fact not listed.\n\n"
            f"Facts:\n{fact_lines}\n\nClue: {template}"
        )
        r = httpx.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json={
                "model": os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.7,
            },
            timeout=15,
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"].strip()
    except Exception:
        return None


def make_clue(loc: dict) -> dict:
    template, facts = template_clue(loc)
    text, source = template, "template"
    rewritten = llm_clue(template, facts)
    if rewritten:
        ok, _ = verify_clue(rewritten, loc, facts)
        if ok:
            text, source = rewritten, "llm_verified"
    return {"text": text, "source": source, "facts": facts}
