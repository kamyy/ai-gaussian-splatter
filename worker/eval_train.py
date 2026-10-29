"""Scores the training code on finished reconstructions, so a change to worker/pipeline/train.py can be judged.

A local run leaves a COLMAP model and the photos in worker/jobdir/<jobId>/. This script trains on each directory it is
given several times, holding every 8th photo back, and prints the mean and spread of PSNR and SSIM on those photos.
It reuses the reconstruction, so a run costs only the train stage and uploads nothing.

Each run uses a different seed, which changes the random view order. Run the same seeds on the code before and after a
change and compare the per-seed lines. A difference smaller than the spread between seeds is noise. Start it with
scripts/dev/worker-eval.sh, which runs it in the train image.
"""

import argparse
import logging
import statistics
import sys
from pathlib import Path

import torch

from pipeline.config import Settings
from pipeline.train import EvalScores, train


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("jobdirs", nargs="+", type=Path, help="Directories holding colmap_sparse/ and photos/")
    parser.add_argument("--runs", type=int, default=3, help="Seeds 0 to runs-1 (default: 3)")
    parser.add_argument("--iterations", type=int, default=None, help="Training iterations (default: the worker's)")
    return parser.parse_args(argv)


def _settings(seed: int, iterations: int | None, workdir: Path) -> Settings:
    # The worker job fields are placeholders. app_origin refuses connections at once, so train()'s progress callbacks
    # (worker/pipeline/status.py) fail fast and are swallowed.
    overrides = {} if iterations is None else {"training_iterations": iterations}
    return Settings(
        job_id="eval",
        splat_id="eval",
        callback_token="eval",
        app_origin="http://127.0.0.1:1",
        uploads_bucket="eval",
        splats_bucket="eval",
        eval_holdout=True,
        eval_seed=seed,
        local_workdir=str(workdir),
        **overrides,
    )


def _score_once(jobdir: Path, seed: int, iterations: int | None, workdir: Path) -> EvalScores:
    scene = train(jobdir / "colmap_sparse", jobdir / "photos", _settings(seed, iterations, workdir))
    assert scene.eval_scores is not None  # eval_holdout is always set here
    scores = scene.eval_scores

    # The next run loads its own copy of the photos, and two copies on one GPU can run out of memory.
    del scene
    torch.cuda.empty_cache()
    return scores


def _spread(values: list[float]) -> float:
    return statistics.stdev(values) if len(values) > 1 else 0.0


def main(argv: list[str]) -> int:
    args = _parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("pipeline.status").setLevel(logging.ERROR)

    all_psnr: list[float] = []
    all_ssim: list[float] = []
    for jobdir in args.jobdirs:
        psnrs: list[float] = []
        ssims: list[float] = []
        for seed in range(args.runs):
            scores = _score_once(jobdir, seed, args.iterations, Path("/tmp/eval") / jobdir.name)
            psnrs.append(scores.psnr)
            ssims.append(scores.ssim)
            print(f"{jobdir.name} seed={seed} PSNR={scores.psnr:.2f} SSIM={scores.ssim:.4f}", flush=True)
        print(
            f"{jobdir.name} mean PSNR={statistics.mean(psnrs):.2f}±{_spread(psnrs):.2f} dB "
            f"SSIM={statistics.mean(ssims):.4f}±{_spread(ssims):.4f}",
            flush=True,
        )
        all_psnr.append(statistics.mean(psnrs))
        all_ssim.append(statistics.mean(ssims))

    print(f"all {len(all_psnr)} captures: PSNR={statistics.mean(all_psnr):.2f} dB SSIM={statistics.mean(all_ssim):.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
