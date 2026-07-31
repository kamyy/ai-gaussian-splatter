# Worker image: CUDA + COLMAP (built from source, for GPU-accelerated SIFT
# extraction/matching — apt's colmap package is typically CPU-only) + Python
# deps for the gsplat training pipeline.
#
# NOT YET BUILT/VALIDATED in this session (no Docker available in the dev
# sandbox this was written in) — per plan §6/M5, build and run this for real
# before trusting it; COLMAP's build dependency list below follows their
# documented source-build requirements but should be verified against
# https://colmap.github.io/install.html for the CUDA/Ubuntu version actually
# deployed.
#
# Per plan §6: this stock-base-image approach is the "simplest to get right
# first" path; a Packer-baked AMI with these layers pre-installed is the
# documented M10 fast-follow to cut per-job boot latency.

FROM nvidia/cuda:12.4.1-devel-ubuntu22.04 AS colmap-build

RUN apt-get update && apt-get install -y --no-install-recommends \
    git cmake ninja-build build-essential \
    libboost-program-options-dev libboost-graph-dev libboost-system-dev \
    libeigen3-dev libflann-dev libfreeimage-dev libmetis-dev \
    libgoogle-glog-dev libgtest-dev libsqlite3-dev libglew-dev \
    qtbase5-dev libqt5opengl5-dev libcgal-dev libceres-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch main https://github.com/colmap/colmap.git /opt/colmap-src \
    && cmake -S /opt/colmap-src -B /opt/colmap-src/build -GNinja \
        -DCMAKE_CUDA_ARCHITECTURES=native \
    && cmake --build /opt/colmap-src/build --target install -- -j$(nproc)

FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 python3.11-venv python3-pip \
    libboost-program-options1.74.0 libboost-graph1.74.0 libboost-system1.74.0 \
    libfreeimage3 libmetis5 libgoogle-glog0v5 libsqlite3-0 libglew2.2 \
    libqt5opengl5 libqt5core5a libqt5gui5 libqt5widgets5 libcgal13 libceres2 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=colmap-build /usr/local/bin/colmap /usr/local/bin/colmap
COPY --from=colmap-build /usr/local/share/colmap /usr/local/share/colmap

RUN pip3 install --no-cache-dir uv

WORKDIR /app
COPY pyproject.toml ./
RUN uv sync --no-dev

COPY pipeline/ ./pipeline/
COPY run_job.py ./

ENV PATH="/app/.venv/bin:${PATH}"
CMD ["python3", "run_job.py"]
