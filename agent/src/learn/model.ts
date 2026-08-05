// The learned model, kept deliberately small and honest. A logistic regressor
// (a one-layer network) trained by SGD on standardized features. Small because
// the data is small: a deep net on dozens of samples is theater that overfits
// and trades worse than the rules it replaces. This is the right model for the
// current data regime and the clean upgrade path to a bigger net is the same
// train/predict interface once the flow recorder has weeks of depth.
//
// Nothing here touches money. The harness runs it in SHADOW: it predicts, we
// score the predictions against reality, and it earns trust before a single
// knob follows it.

export interface LearnedModel {
  w: number[];
  b: number;
  mean: number[];
  std: number[];
  dim: number;
  trainedOn: number;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const dot = (a: number[], c: number[]) => a.reduce((s, v, i) => s + v * c[i], 0);

/** Deterministic LCG shuffle so training and tests are reproducible. */
function shuffled(n: number, seed = 1): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  let s = seed >>> 0;
  for (let i = n - 1; i > 0; i--) {
    s = (1103515245 * s + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

export function standardizer(X: number[][]): { mean: number[]; std: number[] } {
  const dim = X[0].length;
  const mean = new Array(dim).fill(0);
  const std = new Array(dim).fill(0);
  for (const row of X) for (let j = 0; j < dim; j++) mean[j] += row[j];
  for (let j = 0; j < dim; j++) mean[j] /= X.length;
  for (const row of X) for (let j = 0; j < dim; j++) std[j] += (row[j] - mean[j]) ** 2;
  for (let j = 0; j < dim; j++) std[j] = Math.sqrt(std[j] / X.length) || 1; // constant feature -> std 1
  return { mean, std };
}

const applyStd = (x: number[], mean: number[], std: number[]) => x.map((v, j) => (v - mean[j]) / std[j]);

export function trainModel(
  X: number[][],
  y: number[],
  opts: { lr?: number; epochs?: number; l2?: number; seed?: number } = {},
): LearnedModel {
  if (X.length === 0) throw new Error("no training data");
  const dim = X[0].length;
  const { mean, std } = standardizer(X);
  const Xs = X.map((x) => applyStd(x, mean, std));
  const lr = opts.lr ?? 0.1;
  const epochs = opts.epochs ?? 400;
  const l2 = opts.l2 ?? 1e-3;
  const w = new Array(dim).fill(0);
  let b = 0;
  for (let e = 0; e < epochs; e++) {
    for (const i of shuffled(Xs.length, (opts.seed ?? 1) + e)) {
      const p = sigmoid(dot(w, Xs[i]) + b);
      const g = p - y[i];
      for (let j = 0; j < dim; j++) w[j] -= lr * (g * Xs[i][j] + l2 * w[j]);
      b -= lr * g;
    }
  }
  return { w, b, mean, std, dim, trainedOn: X.length };
}

export function predict(m: LearnedModel, x: number[]): number {
  return sigmoid(dot(m.w, applyStd(x, m.mean, m.std)) + m.b);
}

/** Accuracy at a 0.5 threshold, for the honest scoreboard. */
export function accuracy(m: LearnedModel, X: number[][], y: number[]): number {
  if (X.length === 0) return 0;
  let ok = 0;
  for (let i = 0; i < X.length; i++) if ((predict(m, X[i]) >= 0.5 ? 1 : 0) === y[i]) ok++;
  return ok / X.length;
}
