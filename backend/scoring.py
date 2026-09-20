"""Scoring: great-circle distance -> 0..5000.

score = MAX_SCORE * exp(-distance_mi / SCALE_MI)

SCALE_MI = 1250 gives ~4200 points at 214 mi, ~2200 at 1000 mi and ~500 at
2900 mi (coast to coast), which felt right in play-testing. Rounded to int.
"""

from __future__ import annotations

import math

MAX_SCORE = 5000
SCALE_MI = 1250.0
PERFECT_RADIUS_MI = 15.0  # inside this you get the full score


def score_for_distance(distance_mi: float) -> int:
    if distance_mi <= PERFECT_RADIUS_MI:
        return MAX_SCORE
    return int(round(MAX_SCORE * math.exp(-(distance_mi - PERFECT_RADIUS_MI) / SCALE_MI)))
