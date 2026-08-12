# Worker image: COLMAP (taken from upstream's published image) + Python deps
# for the gsplat training pipeline.
#
# Not yet run end to end on real hardware — per plan §6/M5, build and run this
# before trusting it.
#
# Per plan §6: this stock-base-image approach is the "simplest to get right
# first" path; a Packer-baked AMI with these layers pre-installed is the
# documented M10 fast-follow to cut per-job boot latency.
#
# Base images are registry-qualified because podman, unlike docker, does not
# assume Docker Hub for a bare `nvidia/cuda`. With several unqualified-search
# registries configured it asks which to use, and under `short-name-mode =
# "enforcing"` a build with no TTY — CI, or any scripted build — fails outright
# rather than choosing.

# COLMAP is copied from upstream's published image rather than compiled here.
# Compiling it saves about 4 GB of image (22.8 GB against 18.7 GB, measured
# like for like) — their build enables the GUI and links MKL, neither of which
# a headless worker calls — but costs roughly twenty minutes on any build that
# misses the cache, which is every CI run. Image size is paid per job on a cold
# pull and build time only on release, so this is a deliberate trade rather
# than a free win. Upstream also maintains the dependency list across releases,
# which moves: 4.0 swapped FreeImage for OpenImageIO and Qt5 for Qt6 and added
# SuiteSparse and OpenSSL. Their build covers all major CUDA architectures, so
# the same binary runs on the g5.xlarge's A10G and on Ada-generation dev GPUs.
#
# Pinned by digest rather than tag, since upstream's CI names tags
# `$(date +%Y%m%d).$GITHUB_RUN_NUMBER` — a build number, not a version.
#
# The binary here reports COLMAP 4.1.1, and that does identify the source: main
# was incremented to 4.2.0.dev0 on 2026-06-26, three weeks before 4.1.1
# shipped, and the workflow builds main, release/* branches and release events
# alike. A plain 4.1.1 therefore cannot have come off main. Re-derive this the
# same way if the pin is ever moved — `colmap --version` in the candidate
# image, checked against COLMAP_VERSION on main — because a `.dev0` suffix
# means the image is a development build. Note their build reports "Commit
# Unknown"; compiling from source is what embeds the actual revision, if that
# ever matters more than the build time.
FROM docker.io/colmap/colmap@sha256:64768b92a3b6ce126bb4838b8bf4f2531e220a7d73cdfc44d969c22704f0d982 AS colmap

# Matches the Ubuntu and CUDA versions COLMAP's image is built on, so the
# binary copied out of it finds the ABI it was linked against — its runtime
# libraries are Ubuntu 24.04's 64-bit-time_t (`t64`) builds, which have no
# equivalent on 22.04.
#
# -devel rather than -runtime, despite being several GB larger: gsplat ships no
# compiled extension (its PyPI wheel is pure Python, and it depends on ninja
# for exactly this reason), so it builds its CUDA kernels on first use through
# torch.utils.cpp_extension — which needs nvcc and a host C++ compiler present
# at run time, not just at build time. On -runtime the image builds fine and
# then the first rasterization() call fails. That build happens once per
# container, so each job pays it before training starts.
#
# The CUDA version here is load-bearing beyond COLMAP: torch aborts the kernel
# build when its own CUDA major version differs from the toolkit it finds, so
# pyproject.toml pins torch to the matching cu129 wheels. Move one and move both.
FROM docker.io/nvidia/cuda:12.9.1-devel-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive

# The shared libraries COLMAP's binary links, matching the list upstream's own
# runtime stage installs. Qt6 and MKL are in there because their build enables
# the GUI and uses MKL for BLAS; the CLI still needs both present to load, even
# though this worker never opens a window. build-essential is ours, for the
# gsplat kernel build described above.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libboost-program-options1.83.0 libc6 libomp5 libopengl0 libmetis5 \
    libceres4t64 libopenimageio2.4t64 libgcc-s1 libgl1 libglew2.2 \
    libgoogle-glog0v6t64 \
    libqt6core6 libqt6gui6 libqt6widgets6 libqt6openglwidgets6 libqt6svg6 \
    libcurl4 libssl3t64 \
    libmkl-locale libmkl-intel-lp64 libmkl-intel-thread libmkl-core \
    && rm -rf /var/lib/apt/lists/*

# Only the binary, its data files, and the one shared library it links.
# Copying the whole /usr/local prefix instead costs about 4 GB: upstream's
# image carries its own 3.2 GB CUDA installation there, which a COPY would
# duplicate into a new layer rather than dedupe against the identical files
# this base image already has — and would overlay a runtime CUDA tree onto a
# devel one. libcudart and libOpenCL resolve from the base image's
# /usr/local/cuda either way. The static .a archives beside libonnxruntime are
# already linked into the binary, and the 357 MB CUDA execution provider is
# only consulted when running an ONNX model, which this SIFT-based pipeline
# does not.
#
# libonnxruntime lands in /usr/local/lib because that is where the binary's
# RPATH looks ($ORIGIN/../lib); no ldconfig needed.
COPY --from=colmap /usr/local/bin/colmap /usr/local/bin/colmap
COPY --from=colmap /usr/local/share/colmap /usr/local/share/colmap
COPY --from=colmap /usr/local/lib/libonnxruntime.so* /usr/local/lib/

# torch locates nvcc through CUDA_HOME first, falling back to a PATH search.
# The base image puts nvcc on PATH but sets no CUDA_HOME, so this makes the
# lookup explicit rather than dependent on that fallback.
ENV CUDA_HOME=/usr/local/cuda

# uv comes from its own published image rather than pip: Ubuntu 24.04 marks the
# system Python as externally managed (PEP 668), so `pip install` into it fails
# without --break-system-packages. No system Python is needed at all this way —
# uv fetches the interpreter pyproject.toml asks for.
COPY --from=ghcr.io/astral-sh/uv:0.12.3 /uv /uvx /usr/local/bin/

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --no-dev --locked

COPY pipeline/ ./pipeline/
COPY run_job.py ./

ENV PATH="/app/.venv/bin:${PATH}"
CMD ["python3", "run_job.py"]
