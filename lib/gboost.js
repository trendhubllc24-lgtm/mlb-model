/* ================================================================== */
/*  GRADIENT BOOSTED TREES — the same family of algorithm XGBoost is.   */
/*  Sequentially fits shallow decision trees to the PREVIOUS model's    */
/*  errors (residuals), using the same Newton-step leaf-value math      */
/*  XGBoost uses internally, instead of one random forest vote.         */
/*                                                                       */
/*  Written by hand rather than depending on a package: the one real    */
/*  JS XGBoost build on npm (ml-xgboost) ships as WebAssembly, and it   */
/*  failed to even load its own .wasm file in a plain Node test before  */
/*  Vercel's bundler was even involved — too fragile to depend on for   */
/*  a production route. This has no dependencies and is fully ours to   */
/*  verify. It skips XGBoost's large-scale optimizations (histogram     */
/*  binning, column subsampling, L1/L2 regularization) since none of    */
/*  those matter at this data size (a few thousand rows, 2 features).   */
/* ================================================================== */

const MAX_DEPTH = 3;
const N_ROUNDS = 60;
const LEARNING_RATE = 0.15;
const MIN_LEAF = 6;
export const MIN_TRAINING_ROWS = 80;

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

function sseFromSums(sum, sumSq, n) {
  if (n === 0) return 0;
  return sumSq - (sum * sum) / n;
}

function leafValue(idx, residuals, weights) {
  let sumR = 0, sumW = 0;
  for (const i of idx) { sumR += residuals[i]; sumW += weights[i]; }
  return { value: sumR / (sumW || 1e-6) };
}

// Finds the best (feature, threshold) split for this subset of indices in
// O(n log n) — sorts once per feature, then sweeps left-to-right updating
// running sums instead of recomputing SSE from scratch for every candidate
// threshold. (An earlier version tested every unique value with a full
// O(n) rescan each time — O(n^2) per node — which was fast on toy data but
// hung for multiple minutes on a realistic ~7,500-game dataset. This is
// the fix.)
function findBestSplit(X, residuals, weights, idxAll) {
  const nFeatures = X[0].length;
  const totalSum = idxAll.reduce((s, i) => s + residuals[i], 0);
  const totalSumSq = idxAll.reduce((s, i) => s + residuals[i] * residuals[i], 0);
  const n = idxAll.length;

  let best = null;
  for (let f = 0; f < nFeatures; f++) {
    const sorted = [...idxAll].sort((a, b) => X[a][f] - X[b][f]);
    let leftSum = 0, leftSumSq = 0;
    for (let k = 0; k < sorted.length - 1; k++) {
      const i = sorted[k];
      leftSum += residuals[i];
      leftSumSq += residuals[i] * residuals[i];
      const leftN = k + 1, rightN = n - leftN;
      if (leftN < MIN_LEAF || rightN < MIN_LEAF) continue;
      // skip non-boundary thresholds (identical adjacent values can't split)
      if (X[sorted[k]][f] === X[sorted[k + 1]][f]) continue;
      const rightSum = totalSum - leftSum, rightSumSq = totalSumSq - leftSumSq;
      const sse = sseFromSums(leftSum, leftSumSq, leftN) + sseFromSums(rightSum, rightSumSq, rightN);
      if (!best || sse < best.sse) {
        const threshold = (X[sorted[k]][f] + X[sorted[k + 1]][f]) / 2;
        best = { f, threshold, sse, leftIdx: sorted.slice(0, leftN), rightIdx: sorted.slice(leftN) };
      }
    }
  }
  return best;
}

function buildTree(X, residuals, weights, idxAll, depth) {
  if (depth >= MAX_DEPTH || idxAll.length < MIN_LEAF * 2) {
    return leafValue(idxAll, residuals, weights);
  }
  const best = findBestSplit(X, residuals, weights, idxAll);
  if (!best) return leafValue(idxAll, residuals, weights);
  return {
    f: best.f, threshold: best.threshold,
    left: buildTree(X, residuals, weights, best.leftIdx, depth + 1),
    right: buildTree(X, residuals, weights, best.rightIdx, depth + 1),
  };
}

function treePredict(tree, x) {
  if (tree.value !== undefined) return tree.value;
  return x[tree.f] <= tree.threshold ? treePredict(tree.left, x) : treePredict(tree.right, x);
}

// X: array of feature rows (numbers), y: array of 0/1 labels (1 = home team won)
export function trainGBoost(X, y) {
  const n = X.length;
  const posRate = Math.max(0.02, Math.min(0.98, y.reduce((a, b) => a + b, 0) / n));
  const F0 = Math.log(posRate / (1 - posRate));
  const F = Array(n).fill(F0);
  const trees = [];
  const allIdx = X.map((_, i) => i);

  for (let round = 0; round < N_ROUNDS; round++) {
    const p = F.map(sigmoid);
    const residuals = y.map((yi, i) => yi - p[i]);            // negative gradient of log-loss
    const weights = p.map((pi) => pi * (1 - pi) + 1e-6);       // Newton-step Hessian weight
    const tree = buildTree(X, residuals, weights, allIdx, 0);
    trees.push(tree);
    for (let i = 0; i < n; i++) F[i] += LEARNING_RATE * treePredict(tree, X[i]);
  }

  // self-check accuracy on the training data (optimistic, not held-out —
  // same caveat as before, shown as a sanity gauge not a guarantee)
  const finalP = F.map(sigmoid);
  const correct = finalP.filter((p, i) => (p >= 0.5 ? 1 : 0) === y[i]).length;

  return { model: { F0, trees, learningRate: LEARNING_RATE }, trainAccuracy: correct / n };
}

export function predictGBoost(model, x) {
  if (!model) return null;
  let F = model.F0;
  for (const tree of model.trees) F += model.learningRate * treePredict(tree, x);
  return sigmoid(F);
}
