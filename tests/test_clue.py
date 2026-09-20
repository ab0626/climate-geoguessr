import pytest

from backend.clue import template_clue
from features.build import FEATURE_DEFS


def profile(percentile=50.0, summer_share=0.25):
    return {
        **dict.fromkeys(FEATURE_DEFS, 10.0),
        **{f"pct_{feature}": percentile for feature in FEATURE_DEFS},
        "summer_precip_fraction": summer_share,
        "name": "SECRET STATION",
        "state": "XX",
    }


@pytest.mark.parametrize("percentile", [0, 14.9, 15, 34.9, 35, 64.9, 65, 84.9, 85, 100])
def test_clues_keep_facts_traceable_and_identity_hidden(percentile):
    loc = profile(percentile)
    text, facts = template_clue(loc)
    assert template_clue(loc) == (text, facts)
    assert len(facts) == len({fact["feature"] for fact in facts}) == 6
    assert len(text.split()) < 115
    assert "SECRET STATION" not in text and "XX" not in text
    for fact in facts:
        assert fact["value"] == loc[fact["feature"]]
        assert fact["percentile"] == round(loc[f"pct_{fact['feature']}"], 1)
        assert fact["phrase"].lower() in text.lower()


@pytest.mark.parametrize(
    "share,phrase",
    [
        (0.0, "only a small slice"),
        (0.149, "only a small slice"),
        (0.15, "a modest share"),
        (0.349, "a modest share"),
        (0.35, "a sizeable share"),
        (0.5, "a sizeable share"),
        (0.501, "more than half"),
        (1.0, "more than half"),
    ],
)
def test_precipitation_seasonality_uses_actual_share(share, phrase):
    loc = profile(summer_share=share)
    loc["pct_summer_precip_fraction"] = 100 if share < 0.5 else 0
    text, _ = template_clue(loc)
    assert phrase in text


@pytest.mark.parametrize(
    "feature",
    [
        "frozen_precip_days_per_year",
        "mean_wind_mph",
        "diurnal_temp_range_f",
    ],
)
def test_clue_picks_the_most_distinctive_finishing_detail(feature):
    loc = profile()
    loc[f"pct_{feature}"] = 99
    text, facts = template_clue(loc)
    assert facts[4]["feature"] == feature
    assert text.endswith(f"{facts[4]['phrase']}.")
    if feature == "frozen_precip_days_per_year":
        assert "snow" not in text.lower()
        assert "winter" not in facts[4]["phrase"].lower()
