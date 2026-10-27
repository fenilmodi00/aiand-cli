# Forecast v2 — the calibrated Gamma-process Monte Carlo

`aiand forecast --model v2` and `aiand forecast bench` (ticket #77). The
normative spec is claumon's `internal/forecast/MODEL.tex` v2.2 (2026-07-30),
adapted to aiand's budget-utilization series: where claumon fits utilization
snapshots of a quota window, we fit **spend** rows from the local store
against a **monthly budget**. The math is otherwise the same, point by point.

## The model

1. **Rate estimate.** Cumulative spend is sampled on a 5-minute grid over the
   trailing 30 minutes; an OLS slope against time gives the instantaneous
   rate ($/h) with a standard error from the residuals. A flat window is a
   genuine rate≈0 observation (a plateau), with two floors on its claimed
   certainty: half a sample-step of phase error (`|rate| × step/2 / window`)
   and an absolute one-cent-per-day measurement resolution — a plateau is
   "rate ≈ 0 with width", never a degenerate certainty.

2. **Prior.** A normal-normal conjugate prior from past **completed UTC-day
   windows**: each day's attributed spend is one observation of the daily
   rate. The across-window sample variance is *corrected for within-window
   path noise* — a day's own increment stochasticity (≈ rate²/active-5-min-
   buckets) is subtracted before the prior variance is fixed, floored at
   half that correction so the prior never claims more certainty than one
   window's own noise. No completed windows → a flat prior: the OLS
   observation alone decides (the thin-history fallback). Nothing at all →
   `insufficient-data`; a rate is never fabricated.

3. **Posterior.** Standard normal-normal conjugate update of the prior with
   the OLS observation.

4. **Path model.** Gamma-process increments: each simulated 5-minute step
   draws `Gamma(shape = rate·step, scale = 1)` — non-negative by
   construction, so paths are monotone non-decreasing usage bounded below by
   current cumulative spend. Increment variance = mean (unit
   over-dispersion).

5. **Rate draw — the v2.2 fix.** Each of the K paths draws its rate from the
   posterior Gaussian **rectified at zero**. Negative draws become
   exact-zero-rate paths (stalls/plateaus). This is the change that lifted
   claumon's LOSO 80% coverage 55%→89%: without it (the `--variant`-style
   plain-Gaussian behavior, reproducible with `rectify: false` in the bench
   API), small negative rates leak positive spend instead of stalling and
   the interval loses its lower tail exactly when usage is plateauing.

6. **Monte Carlo.** K = 500 seeded paths, 5-minute steps to the horizon (for
   `forecast`, the end of the current UTC month). Reported: the **median**
   point forecast and the **80% credible interval** (10th–90th percentile of
   the path endpoints). Values are **uncapped** — projected spend above the
   budget is projected demand; projected utilization renders above 100%.

7. **ETA-to-budget.** Per path, the first step where cumulative spend
   crosses `budget − current`. Reported as median + 80% CI over the reaching
   paths; **nil when P(never reaching) ≥ 0.5** — an ETA that probably never
   happens is not reported. Already-over-budget → no threshold left → nil.

8. **Determinism.** mulberry32 seeded by FNV-1a of the window id (the UTC
   month) or an explicit `--seed` (number or string). Identical store rows +
   seed → byte-identical output, including `--json` (golden-fixture tested).
   The seed makes the Monte Carlo reproducible, not the window: the trailing
   30-minute OLS window follows the current time, so unpinned back-to-back
   runs can differ. Pin `--until` (and `--since`) for byte-identical output
   across runs.
   The PRNG, normal (Box-Muller), and Gamma (Marsaglia-Tsang with the
   shape<1 boost) samplers are hand-rolled — the CLI has zero runtime
   dependencies.

## Reading `aiand forecast`

```
aiand forecast --model v2 --seed 42
```

- **current spend** — `gateway-billed` (a sum of gateway-computed cost rows).
- **posterior rate** — `heuristic(forecast v2 rate (OLS 30-min + conjugate prior))`.
- **projected month-end (median)** and the **80% credible interval** —
  `estimated(calibrated Monte Carlo v2 (Gamma process, rectified-Gaussian rate))`.
  The interval is uncapped above the budget; overshoot is demand.
- **projected utilization** — median / budget, rendered unclamped above 100%
  (annotated `overshoot — uncapped`).
- **ETA to budget** — median + 80% CI in hours, or `nil (P(never) = N%)`.
- **verdict** — on-pace / exceeding by the median vs the budget.
- The footer prints the seed and path count: rerun with the same seed to
  reproduce the numbers exactly.

`--model v1` (the default) keeps the OBS-P2-2 burn-rate extrapolation for
comparison.

## Reading `aiand forecast bench`

```
aiand forecast bench --model v2 --windows 10 --horizon-hours 24
```

The bench replays past **daily windows** (noon UTC anchors, one per `--windows`
days, LOSO-style: each forecast sees only rows before its anchor and is
scored against the actual spend of `(anchor, anchor + horizon]`). Offline
from the local store; deterministic given the same store + seed.

- **CRPS** — continuous ranked probability score of the empirical path
  distribution (`mean|x−y| − ½·mean|x−x'|`). Lower is better; the single
  number to compare models on.
- **pinball q10/q50/q90** — quantile (pinball) loss at the quantiles the
  forecast publishes. Lower is better; asymmetric rise on one side names the
  direction of the misses.
- **80% coverage** — fraction of windows whose actual landed inside the
  published 80% interval. The calibration headline: persistently below 80%
  means the intervals are too narrow.
- **bias** — mean signed error (forecast − actual). Positive = systematic
  over-forecast.
- **calibration regression** — least squares of the squared error `e²` on
  `[δ, δ²]` (`δ` = forecast − actual), per MODEL.tex. Verdicts:
  - a positive δ² coefficient → *squared errors grow faster than the spread*
    → intervals too narrow;
  - a large signed δ coefficient → systematic under-/over-forecasting;
  - otherwise: *no systematic miscalibration detected*.

Provenance of the bench numbers: `heuristic(forecast bench replay scoring
(CRPS/pinball/coverage/bias))` — replay windows are a scoring heuristic over
gateway-billed rows.

## Detecting calibration drift

`aiand forecast bench` is the CI-visible proof: point it at the same store
with `--model v2` and at a deliberately miscalibrated variant (the
non-rectified Gaussian, via the `rectify: false` bench option) — the
variant's coverage drops measurably on plateau-heavy data while the
rectified model keeps the lower tail at zero. That gap is the same effect
claumon measured (session-gauge 80% coverage 55%→89% between v2.1 and v2.2).

## Out of scope (per ticket #77)

Per-model/per-harness forecasts (aggregate spend only), priors from other
users' data, server-side enforcement, and notification delivery.
