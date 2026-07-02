import { RandomForestClassifier } from "ml-random-forest";

/* ================================================================== */
/*  RANDOM FOREST — a second, independent model trained directly on    */
/*  this model's own graded history (backfilled 2025 + 2026 results).  */
/*  Features per game: [ratingDiff, homeAdvUsed] — the same two        */
/*  numbers the Elo/Poisson model itself used going in. The forest      */
/*  learns, from real outcomes, how much those numbers actually        */
/*  mattered — which can catch systematic bias the hand-tuned Poisson   */
/*  formula doesn't (e.g. "rating edges under 20 points barely matter   */
/*  in practice"). Kept as a SEPARATE signal shown alongside the        */
/*  Poisson number, not silently blended into it, so it stays honest    */
/*  and inspectable rather than a black box overriding the main model.  */
/* ================================================================== */
const MIN_TRAINING_ROWS = 60; // don't bother training on too little data

export function trainForest(predictions) {
  const rows = Object.values(predictions || {}).filter(
    (p) => p.resolved && typeof p.ratingDiff === "number" && typeof p.homeAdvUsed === "number"
  );
  if (rows.length < MIN_TRAINING_ROWS) {
    return { modelJSON: null, trainedOn: rows.length, trainAccuracy: null, ready: false };
  }

  const X = rows.map((p) => [p.ratingDiff, p.homeAdvUsed]);
  const y = rows.map((p) => (p.actual === "A" ? 1 : 0)); // 1 = home team won

  const rf = new RandomForestClassifier({ nEstimators: 80, seed: 42, replacement: true });
  rf.train(X, y);

  // self-check: how often the trained forest would've called its own
  // training games correctly (an optimistic number, not held-out
  // validation, but useful as a sanity gauge shown in the UI)
  const preds = rf.predict(X);
  const correct = preds.filter((p, i) => p === y[i]).length;

  return {
    modelJSON: rf.toJSON(),
    trainedOn: rows.length,
    trainAccuracy: correct / rows.length,
    ready: true,
  };
}

export function forestHomeWinProb(modelJSON, ratingDiff, homeAdvUsed) {
  if (!modelJSON) return null;
  try {
    const rf = RandomForestClassifier.load(modelJSON);
    const [prob] = rf.predictProbability([[ratingDiff, homeAdvUsed]], 1);
    return prob;
  } catch {
    return null;
  }
}
