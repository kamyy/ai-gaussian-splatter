# Worker image: COLMAP plus the Python deps for the gsplat training pipeline.
#
# Two final targets, each carrying only what its worker-job stage runs. There is no default, so every caller passes
# --target. A stage pays its image pull before its GPU does anything, and reconstruct runs on every upload while only
# some splats go on to train.
#
#   colmap                  upstream COLMAP binary
#   build                   the venv both targets share
#    ├─ build-train         + gsplat's CUDA kernels compiled in
#    └─ build-reconstruct   − torch, its CUDA libraries and gsplat
#
#   reconstruct  (final)    colmap + build-reconstruct
#   train        (final)    build-train
#
# Base images are registry-qualified because podman, unlike docker, does not assume Docker Hub for a bare `nvidia/cuda`.
# Under `short-name-mode = "enforcing"` a build with no TTY — CI, or any scripted build — fails rather than choosing.

# ---------------------------------------------------------------------------
# colmap
# ---------------------------------------------------------------------------
# Compiling COLMAP headless would trim part of the 1.01 GB apt layer in the reconstruct target below, since upstream
# enables the GUI and links MKL that this worker never calls. That layer is the ceiling: MKL is about 185 MB of it,
# the mesa/LLVM stack libgl1 and libglew2.2 drag in about 296 MB, and OpenImageIO's OpenVDB/GDAL/DCMTK tree another
# 100 MB or so, against roughly twenty minutes on any build that misses the cache. Upstream also tracks the dependency
# list across releases, which moves, and builds for all major CUDA architectures, so one binary runs on the
# g5.xlarge's A10G and on Ada-generation dev GPUs.
#
# Pinned by digest because upstream's CI names tags `$(date +%Y%m%d).$GITHUB_RUN_NUMBER`, a build number rather than a
# version. If the pin moves, check what it holds with `colmap --version` against COLMAP_VERSION on main: a `.dev0`
# suffix means a development build.
FROM docker.io/colmap/colmap@sha256:64768b92a3b6ce126bb4838b8bf4f2531e220a7d73cdfc44d969c22704f0d982 AS colmap

# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
# Only /app/.venv and the interpreter leave here, so this stage's own layer sizes reach neither final image.
#
# torch aborts a kernel build when its CUDA major version differs from the toolkit it finds, so worker/pyproject.toml
# pins torch to matching cu129 wheels. Move this version and move that one.
FROM docker.io/nvidia/cuda:12.9.1-devel-ubuntu24.04 AS build

ENV DEBIAN_FRONTEND=noninteractive

# The -devel base carries nvcc and the CUDA headers but no host C++ compiler, which nvcc drives when building gsplat.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

# torch looks here before falling back to a PATH search for nvcc. The base image sets no CUDA_HOME of its own.
ENV CUDA_HOME=/usr/local/cuda

# uv rather than pip: Ubuntu 24.04 marks its system Python externally managed (PEP 668), and uv fetches the
# interpreter worker/pyproject.toml asks for instead of needing one.
COPY --from=ghcr.io/astral-sh/uv:0.12.3 /uv /uvx /usr/local/bin/

WORKDIR /app
COPY pyproject.toml uv.lock ./

# torch's cu129 wheels bundle CUDA libraries the base image already installs through apt. Deleting the wheel copies
# works because libtorch_cuda.so finds them through a DT_RPATH of $ORIGIN/../../nvidia/*/lib, and a directory missing
# from an RPATH is skipped rather than fatal, so the lookup falls through to the base image's
# LD_LIBRARY_PATH=/usr/local/cuda/lib64. Both sides are CUDA 12.9. A torch built against a new CUDA major breaks this.
#
# What stays, and why it cannot go:
#   cudnn, cusparselt, nvshmem, cuda_cupti   NEEDED entries with no apt copy in this base image
#   nccl                                     apt's 2.27.3 predates the ncclCommResume this torch calls
# triton goes because nothing in worker/pipeline/ calls torch.compile.
#
# The loop makes each path required, since `rm -rf` on a path that moved would leave a full-size image behind a green
# build. `import torch` then proves the venv still works, and catches nccl's undefined-symbol case that a check for
# unresolved NEEDED entries would pass. CI never builds this image, so this RUN is the only place either surfaces.
RUN uv sync --no-dev --locked && \
    cd .venv/lib/python3.*/site-packages && \
    for d in \
        triton \
        nvidia/cublas \
        nvidia/cuda_nvrtc \
        nvidia/cuda_runtime \
        nvidia/cufft \
        nvidia/cufile \
        nvidia/curand \
        nvidia/cusolver \
        nvidia/cusparse \
        nvidia/nvjitlink; \
    do \
        if [ ! -d "$d" ]; then \
            echo "worker/Dockerfile: $d was queued for pruning but does not exist" >&2; \
            exit 1; \
        fi; \
        rm -rf "$d"; \
    done && \
    cd /app && \
    .venv/bin/python -c "import torch"

# ---------------------------------------------------------------------------
# build-train
# ---------------------------------------------------------------------------
# gsplat's PyPI wheel is pure Python and compiles its CUDA kernels on first use, costing about a minute at the start
# of every train stage and dying with the container. The sdist build produces a real gsplat/csrc.so, which
# gsplat/cuda/_backend.py tries before it checks for nvcc — that is what lets the final targets carry no CUDA toolkit.
# Kept off `build` itself so --target reconstruct never runs this compile only to delete what it produced.
#
# TORCH_CUDA_ARCH_LIST is required, not a tuning knob: unset, torch targets whatever device it sees, and a builder
# sees none. 8.6 is the g5.xlarge's A10G, 8.9 an Ada dev GPU for scripts/dev/worker-train.sh. The version comes from
# what uv resolved, so worker/uv.lock stays the single pin.
FROM build AS build-train

RUN TORCH_CUDA_ARCH_LIST="8.6;8.9" uv pip install --no-build-isolation --no-deps --force-reinstall \
        --no-binary gsplat "gsplat==$(uv pip show gsplat | awk '/^Version:/{print $2}')" && \
    .venv/bin/python -c "from gsplat import csrc"

# ---------------------------------------------------------------------------
# build-reconstruct
# ---------------------------------------------------------------------------
# torch and its CUDA libraries are most of the train image and none of what COLMAP needs. worker/run_job.py imports
# worker/pipeline/train.py and worker/pipeline/export.py inside _run_train so that this removal is safe. gsplat goes
# too: this branch never reaches build-train, so what uv sync left is the pure-Python wheel, useless without torch.
# Fail-closed for the same reason the prune above is.
FROM build AS build-reconstruct

RUN cd .venv/lib/python3.*/site-packages && \
    for d in torch nvidia gsplat; do \
        if [ ! -d "$d" ]; then \
            echo "worker/Dockerfile: $d was queued for removal but does not exist" >&2; \
            exit 1; \
        fi; \
        rm -rf "$d"; \
    done && \
    cd /app && \
    .venv/bin/python -c "import boto3, numpy, plyfile, httpx, pydantic_settings"

# ---------------------------------------------------------------------------
# reconstruct (final target)
# ---------------------------------------------------------------------------
# Ubuntu and CUDA match COLMAP's own image so the binary copied out of it finds the ABI it was linked against: its
# runtime libraries are Ubuntu 24.04 `t64` builds with no 22.04 equivalent.
#
# -base, not the -runtime the train target uses. CUDA is needed at run time, because worker/pipeline/sfm.py passes
# --FeatureExtraction.use_gpu 1 and --FeatureMatching.use_gpu 1, but libcudart is the only CUDA library anywhere in
# the colmap binary's transitive link chain. -runtime would add 3.46 GB of cuBLAS, cuSPARSE, cuSOLVER, cuFFT, cuRAND
# and NPP that nothing here loads, extraction, matching and Ceres bundle adjustment included. The 300 MB
# cuda-compat-12-9 is in -base either way, so it is not part of that saving.
FROM docker.io/nvidia/cuda:12.9.1-base-ubuntu24.04 AS reconstruct

ENV DEBIAN_FRONTEND=noninteractive

# The shared libraries COLMAP's binary links, matching upstream's own runtime stage. Qt6 and MKL are in there because
# their build enables the GUI and uses MKL for BLAS; the CLI needs both present to load even though it never opens a
# window.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libboost-program-options1.83.0 \
        libc6 \
        libceres4t64 \
        libcurl4 \
        libgcc-s1 \
        libgl1 \
        libglew2.2 \
        libgoogle-glog0v6t64 \
        libmetis5 \
        libmkl-core \
        libmkl-intel-lp64 \
        libmkl-intel-thread \
        libmkl-locale \
        libomp5 \
        libopengl0 \
        libopenimageio2.4t64 \
        libqt6core6 \
        libqt6gui6 \
        libqt6openglwidgets6 \
        libqt6svg6 \
        libqt6widgets6 \
        libssl3t64 \
    && rm -rf /var/lib/apt/lists/*

# Only the binary, its data files, and the one shared library it links: copying the whole /usr/local prefix would
# add about 4 GB of upstream's own CUDA installation, which would not dedupe against this base image's.
# libonnxruntime goes to /usr/local/lib because that is where the binary's RPATH looks.
COPY --from=colmap /usr/local/bin/colmap /usr/local/bin/colmap
COPY --from=colmap /usr/local/share/colmap /usr/local/share/colmap
COPY --from=colmap /usr/local/lib/libonnxruntime.so* /usr/local/lib/

WORKDIR /app

# /app/.venv/bin/python is an absolute symlink to an interpreter uv keeps outside the venv, so both paths travel.
COPY --from=build-reconstruct /root/.local/share/uv/python /root/.local/share/uv/python
COPY --from=build-reconstruct /app/.venv /app/.venv

COPY pipeline/ ./pipeline/
COPY run_job.py ./

ENV PATH="/app/.venv/bin:${PATH}"

# No torch here, so this asserts worker/run_job.py still defers its torch-reaching imports into _run_train. The train
# target needs no equivalent, carrying everything either path imports.
RUN python -c "import run_job"

CMD ["python3", "run_job.py"]

# ---------------------------------------------------------------------------
# train (final target)
# ---------------------------------------------------------------------------
# Same base as reconstruct, without its COLMAP payload: the train stage reads COLMAP's output through
# worker/pipeline/colmap_model.py, a struct parser that needs neither the binary nor pycolmap. Nothing here runs apt,
# so there is no DEBIAN_FRONTEND either.
FROM docker.io/nvidia/cuda:12.9.1-runtime-ubuntu24.04 AS train

# worker/pipeline/train.py's densify_and_prune reallocates all five Gaussian-model tensors every call, fragmenting
# PyTorch's caching allocator into blocks too small for a later allocation even when their sum is enough.
# expandable_segments grows one segment instead, as PyTorch's own CUDA OOM message recommends.
ENV PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

WORKDIR /app

# /app/.venv/bin/python is an absolute symlink to an interpreter uv keeps outside the venv, so both paths travel.
COPY --from=build-train /root/.local/share/uv/python /root/.local/share/uv/python
COPY --from=build-train /app/.venv /app/.venv

COPY pipeline/ ./pipeline/
COPY run_job.py ./

ENV PATH="/app/.venv/bin:${PATH}"
CMD ["python3", "run_job.py"]
