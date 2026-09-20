"""Player-facing clue generation.

The deterministic template path is the default and the fallback. Every phrase is
a function of the location's percentile rank within the processed feature table,
so the clue can never state something the data does not support. An optional
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
    """Return (clue text, list of facts used) from percentile columns pct_*."""
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
            "cool summers",
            "mild summers",
            "warm summers",
            "hot summers",
            "very hot summers",
        ),
    )
    winter = use(
        "winter_mean_temp_f",
        band(
            p["winter_mean_temp_f"],
            "long, frigid winters",
            "cold winters",
            "cool winters",
            "mild winters",
            "winters that barely register",
        ),
    )
    humid = use(
        "summer_dewpoint_f",
        band(
            p["summer_dewpoint_f"],
            "summer air is bone dry",
            "summer air is fairly dry",
            "summer humidity is moderate",
            "summers are humid",
            "summers are oppressively humid",
        ),
    )
    precip = use(
        "annual_precip_in",
        band(
            p["annual_precip_in"],
            "it is one of the driest places in our table",
            "it is drier than most of the country",
            "it gets about average annual precipitation",
            "it is wetter than most of the country",
            "it is among the wettest places in our table",
        ),
    )
    snow = use(
        "frozen_precip_days_per_year",
        band(
            p["frozen_precip_days_per_year"],
            "frozen precipitation is essentially unknown",
            "frozen precipitation is rare",
            "some frozen-precipitation days each winter",
            "frequent frozen precipitation in winter",
            "frozen precipitation is a regular part of winter",
        ),
    )
    wind = use(
        "mean_wind_mph",
        band(
            p["mean_wind_mph"],
            "winds are calm",
            "winds are light",
            "winds are moderate",
            "it is breezy",
            "it is persistently windy",
        ),
    )
    diurnal = use(
        "diurnal_temp_range_f",
        band(
            p["diurnal_temp_range_f"],
            "almost no day-night temperature swing",
            "small day-night temperature swings",
            "typical day-night swings",
            "large day-night temperature swings",
            "huge day-night temperature swings",
        ),
    )
    seasonal = use(
        "summer_precip_fraction",
        band(
            p["summer_precip_fraction"],
            "summers are the dry season",
            "most rain falls outside summer",
            "rain is spread through the year",
            "summer is the wettest season",
            "rain is heavily concentrated in summer",
        ),
    )
    text = (
        f"This place has {summer} and {winter}; {humid}. "
        f"{precip[0].upper() + precip[1:]}, and {seasonal}. "
        f"{snow[0].upper() + snow[1:]}. {wind[0].upper() + wind[1:]}, with {diurnal}."
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
