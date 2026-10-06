import logging
import time

import pytest

from pipeline import timing


@pytest.fixture
def lines(caplog):
    caplog.set_level(logging.INFO, logger="pipeline.timing")
    return lambda kind: [r.getMessage() for r in caplog.records if r.getMessage().startswith(f"{kind} ")]


def test_timed_logs_the_phase_its_duration_and_fields_added_inside_the_block(lines):
    with timing.timed("train_loop", iterations=10) as fields:
        fields["gaussians"] = 42

    [line] = lines("timing")
    assert line.startswith("timing phase=train_loop ms=")
    assert line.endswith(" iterations=10 gaussians=42")


def test_timed_still_logs_a_phase_that_raises_and_marks_it_failed(lines):
    with pytest.raises(RuntimeError), timing.timed("colmap_mapper"):
        raise RuntimeError("mapper exited 1")

    [line] = lines("timing")
    assert line.startswith("timing phase=colmap_mapper ms=")
    assert line.endswith(" ok=false")


def test_sampler_attributes_each_sample_to_the_running_phase_and_stops_on_exit(mocker, lines):
    mocker.patch.object(timing, "_read_gpu", return_value={"gpu": 97, "gpu_mem_mb": 2048})

    with timing.ResourceSampler(interval=0.01) as sampler, timing.timed("train_loop"):
        time.sleep(0.05)

    assert not sampler._thread.is_alive()
    samples = lines("sample")
    assert samples
    assert "sample phase=train_loop " in samples[0]
    assert samples[0].endswith(" gpu=97 gpu_mem_mb=2048")


def test_gpu_fields_are_left_out_where_nvidia_smi_is_missing(mocker):
    mocker.patch.object(timing.subprocess, "run", side_effect=FileNotFoundError("nvidia-smi"))

    assert timing._read_gpu() == {}
