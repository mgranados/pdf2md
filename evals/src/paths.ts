import path from 'node:path';

// evals/src -> evals -> repo root
export const SRC_DIR = import.meta.dirname;
export const EVALS_DIR = path.resolve(SRC_DIR, '..');
export const REPO_DIR = path.resolve(EVALS_DIR, '..');

export const CORPUS_OUT = path.join(EVALS_DIR, 'corpus', '_out');
export const CACHE_DIR = path.join(EVALS_DIR, '.cache', 'judge');
export const RESULTS_DIR = path.join(EVALS_DIR, 'results');
