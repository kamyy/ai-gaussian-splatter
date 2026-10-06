"""Per-phase timings and CPU/GPU samples for one worker-job stage, written as log lines.

Each phase logs `timing phase=<name> ms=<n>` when it ends, and a background thread logs a `sample` line with CPU and
GPU use every few seconds. Both go to the stage's CloudWatch log stream, next to the lines that the user-data in
web/lib/server/workerLauncher.ts writes for the boot and image pull. scripts/prod/logs-timings.sh reads them back, to
show where a stage's wall clock goes and whether each phase is waiting on the CPU, the GPU or the disk.
"""

import logging
import subprocess
import threading
import time
from collections.abc import Generator
from contextlib import contextmanager

logger = logging.getLogger(__name__)

SAMPLE_INTERVAL_SECONDS = 5.0

# The phase running now, so each sample says which phase its numbers belong to.
_current_phase = "none"


def log_line(kind: str, **fields: object) -> None:
    """Logs `<kind> key=value ...`, the one shape scripts/prod/logs-timings.sh parses."""
    logger.info("%s %s", kind, " ".join(f"{key}={value}" for key, value in fields.items()))


@contextmanager
def timed(phase: str, **fields: object) -> Generator[dict[str, object]]:
    """Logs how long the block took as `timing phase=<phase> ms=<n>`, followed by fields. The block can add to the dict
    it is handed, for values it only knows at the end. A block that raises still logs, with ok=false added.
    """
    global _current_phase

    previous = _current_phase
    _current_phase = phase
    started = time.monotonic()
    ok = True
    try:
        yield fields
    except BaseException:
        ok = False
        raise
    finally:
        _current_phase = previous
        outcome = {} if ok else {"ok": "false"}
        log_line("timing", phase=phase, ms=round((time.monotonic() - started) * 1000), **fields, **outcome)


def _read_cpu_times() -> tuple[int, int, int] | None:
    """(idle, iowait, total) jiffies summed over every CPU, or None off Linux."""
    try:
        with open("/proc/stat") as stat:
            values = [int(v) for v in stat.readline().split()[1:]]
    except OSError, ValueError:
        return None

    return values[3], values[4], sum(values)


def _read_gpu() -> dict[str, object]:
    """Utilization % and memory used of the first GPU, or nothing where nvidia-smi is missing or fails."""
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        )
        utilization, memory = result.stdout.splitlines()[0].split(",")
        return {"gpu": int(utilization), "gpu_mem_mb": int(memory)}
    except OSError, subprocess.SubprocessError, ValueError, IndexError:
        return {}


class ResourceSampler:
    """Logs a `sample` line every interval while the `with` block runs.

    cpu and wa are percentages of all vCPUs together, so on a 4-vCPU instance a single saturated core reads as cpu=25.
    wa is time spent waiting on the disk. gpu is the GPU's utilization %, and gpu_mem_mb its memory in use.
    """

    def __init__(self, interval: float = SAMPLE_INTERVAL_SECONDS) -> None:
        self._interval = interval
        self._stop = threading.Event()
        # A daemon, so a sampler that is never stopped can't keep the process alive.
        self._thread = threading.Thread(target=self._run, name="resource-sampler", daemon=True)

    def __enter__(self) -> ResourceSampler:
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._stop.set()
        self._thread.join()

    def _run(self) -> None:
        previous = _read_cpu_times()
        while not self._stop.wait(self._interval):
            fields: dict[str, object] = {"phase": _current_phase}

            current = _read_cpu_times()
            if previous is not None and current is not None and current[2] > previous[2]:
                total = current[2] - previous[2]
                idle = current[0] - previous[0]
                iowait = current[1] - previous[1]
                fields["cpu"] = round(100 * (total - idle - iowait) / total)
                fields["wa"] = round(100 * iowait / total)
            previous = current

            fields.update(_read_gpu())
            log_line("sample", **fields)
