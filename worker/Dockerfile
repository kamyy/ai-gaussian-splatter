# Worker image: COLMAP (taken from upstream's published image) + Python deps for the gsplat training pipeline.
#
# Two stages. The build stage compiles gsplat's CUDA kernels against a -devel base; the runtime stage carries the
# result on a -runtime base, which has no nvcc, no CUDA headers and no nsight-compute. A worker-job stage pays the
# image pull before its GPU does anything, and a worker job is two stages on two spot instances, so that difference is
# paid twice.
#
# Base images are registry-qualified because podman, unlike docker, does not assume Docker Hub for a bare `nvidia/cuda`.
# With several unqualified-search registries configured it asks which to use, and under `short-name-mode = "enforcing"`
# a build with no TTY — CI, or any scripted build — fails outright rather than choosing.

# COLMAP is copied from upstream's published image rather than compiled here. Compiling it saves about 4 GB of image —
# their build enables the GUI and links MKL, neither of which a headless worker calls — but costs roughly twenty minutes
# on any build that misses the cache, which is every CI run. Image size is paid per worker instance on a cold pull and
# build time only on release, so this is a deliberate trade rather than a free win. Upstream also maintains the
# dependency list across releases, which moves: 4.0 swapped FreeImage for OpenImageIO and Qt5 for Qt6 and added
# SuiteSparse and OpenSSL. Their build covers all major CUDA architectures, so the same binary runs on the g5.xlarge's
# A10G and on Ada-generation dev GPUs.
#
# Pinned by digest rather than tag, since upstream's CI names tags `$(date +%Y%m%d).$GITHUB_RUN_NUMBER` — a build
# number, not a version.
#
# The binary here reports COLMAP 4.1.1, and that does identify the source: main was incremented to 4.2.0.dev0 on
# 2026-06-26, three weeks before 4.1.1 shipped, and the workflow builds main, release/* branches and release events
# alike. A plain 4.1.1 therefore cannot have come off main. Re-derive this the same way if the pin is ever moved —
# `colmap --version` in the candidate image, checked against COLMAP_VERSION on main — because a `.dev0` suffix means the
# image is a development build. Note their build reports "Commit Unknown"; compiling from source is what embeds the
# actual revision, if that ever matters more than the build time.
FROM docker.io/colmap/colmap@sha256:64768b92a3b6ce126bb4838b8bf4f2531e220a7d73cdfc44d969c22704f0d982 AS colmap

# The build stage exists to produce /app/.venv and nothing else. Its own layers are discarded, so size here is free
# and only what the runtime stage COPYs counts.
#
# The CUDA version is load-bearing beyond COLMAP: torch aborts a kernel build when its own CUDA major version differs
# from the toolkit it finds, so worker/pyproject.toml pins torch to the matching cu129 wheels. Move one and move both.
FROM docker.io/nvidia/cuda:12.9.1-devel-ubuntu24.04 AS build

ENV DEBIAN_FRONTEND=noninteractive

# build-essential supplies the host C++ compiler nvcc drives when compiling gsplat below. The -devel base carries nvcc
# and the CUDA headers but not a host toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# torch locates nvcc through CUDA_HOME first, falling back to a PATH search. The base image puts nvcc on PATH but sets
# no CUDA_HOME, so this makes the lookup explicit rather than dependent on that fallback.
ENV CUDA_HOME=/usr/local/cuda

# uv comes from its own published image rather than pip: Ubuntu 24.04 marks the system Python as externally managed (PEP
# 668), so `pip install` into it fails without --break-system-packages. No system Python is needed at all this way — uv
# fetches the interpreter pyproject.toml asks for.
COPY --from=ghcr.io/astral-sh/uv:0.12.3 /uv /uvx /usr/local/bin/

WORKDIR /app
COPY pyproject.toml uv.lock ./
# The second `rm -rf` deletes CUDA libraries that this image would otherwise carry twice. torch's cu129 wheels bundle
# their own copies of libraries the nvidia/cuda base image already installs through apt. Deleting them in the same RUN
# that created them is what shrinks the image; a later RUN would add a whiteout layer on top of bytes already pulled,
# making it bigger.
#
# torch finds these through a DT_RPATH of $ORIGIN/../../nvidia/*/lib on libtorch_cuda.so, which the loader searches
# ahead of LD_LIBRARY_PATH. A directory missing from an RPATH is skipped rather than fatal, so the lookup falls through
# to the LD_LIBRARY_PATH=/usr/local/cuda/lib64 the base image sets and resolves against the apt copy. Both sides are
# CUDA 12.9, so the sonames match. Moving torch to a wheel built against a new CUDA major breaks that, and the symptom
# is `import torch` failing with the library named in the error.
#
# cudnn, cusparselt and nvshmem are NEEDED entries of libtorch_cuda.so with no apt copy here, because cuDNN ships only
# in the -cudnn- image variants. cuda_cupti has one only in the devel layer. nccl does have one, at
# /lib/x86_64-linux-gnu/libnccl.so.2 by way of ld.so.cache rather than LD_LIBRARY_PATH, but apt's 2.27.3 predates the
# ncclCommResume that this torch build calls. Deleting that wheel therefore fails at `import torch` with an
# undefined-symbol error instead of a missing-file one. All five stay. triton goes because it is torch.compile's
# backend and worker/pipeline/ never calls torch.compile.
#
# Only /app/.venv is carried into the runtime stage, so deleting from it is what keeps those bytes out of the final
# image. uv also hardlinks the same files into /root/.cache/uv, but that cache stays behind in this discarded stage.
#
# The loop makes every path required. `rm -rf` on a path that is already gone succeeds, so a wheel layout that moved
# these directories would leave the image silently back at its full size with the build still green. torch already
# depends on cuda-toolkit and cuda-pathfinder, whose job is locating CUDA libraries across more than one layout, so
# that move is a matter of when. The worker job in .github/workflows/ci.yml never builds this image, which leaves this
# RUN as the only place such a mistake can surface.
#
# The closing `import torch` asserts the prune left a working venv. It catches strictly more than a check for
# unresolved NEEDED entries would: deleting nvidia/nccl resolves libnccl.so.2 against the apt copy and then fails on a
# missing ncclCommResume symbol, which ldd reports as a perfectly resolved library.
RUN uv sync --no-dev --locked && \
    cd .venv/lib/python3.*/site-packages && \
    for d in triton \
        nvidia/cublas nvidia/cusolver nvidia/cusparse nvidia/cufft \
        nvidia/cuda_nvrtc nvidia/curand nvidia/nvjitlink nvidia/cuda_runtime nvidia/cufile; do \
        [ -d "$d" ] || { echo "worker/Dockerfile: $d was queued for pruning but does not exist" >&2; exit 1; }; \
        rm -rf "$d"; \
    done && \
    cd /app && \
    .venv/bin/python -c "import torch"

# gsplat's PyPI wheel is pure Python and compiles its CUDA kernels on first use through torch.utils.cpp_extension,
# which costs about a minute at the start of every train stage and is thrown away with the container. Building from
# the sdist here instead produces a real gsplat/csrc.so, and gsplat/cuda/_backend.py tries `from gsplat import csrc`
# before it checks for nvcc at all. That is what lets the runtime stage below carry no CUDA toolkit.
#
# TORCH_CUDA_ARCH_LIST is required, not an optimization. Unset, torch targets whichever device it can see, and a
# builder sees none. 8.6 is the g5.xlarge's A10G that worker jobs run on; 8.9 covers an Ada-generation dev GPU for a
# local run through scripts/dev/worker-train.sh.
#
# The version comes from what uv already resolved, so worker/uv.lock stays the single pin. --no-deps keeps this from
# reinstalling anything the prune above removed.
RUN TORCH_CUDA_ARCH_LIST="8.6;8.9" uv pip install --no-build-isolation --no-deps --force-reinstall \
        --no-binary gsplat "gsplat==$(uv pip show gsplat | awk '/^Version:/{print $2}')" && \
    .venv/bin/python -c "from gsplat import csrc"

# Matches the Ubuntu and CUDA versions COLMAP's image is built on, so the binary copied out of it finds the ABI it was
# linked against — its runtime libraries are Ubuntu 24.04's 64-bit-time_t (`t64`) builds, which have no equivalent on
# 22.04.
#
# -runtime rather than -devel, which is the larger half of this image's size: nothing here compiles. gsplat arrives as
# a compiled csrc.so from the build stage, and the deleted nvidia wheels resolve against this base's own apt copies of
# cuBLAS, cuSOLVER, cuSPARSE, cuFFT, nvRTC, cuRAND, nvJitLink, cudart and cuFile, all of which -runtime carries.
FROM docker.io/nvidia/cuda:12.9.1-runtime-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive

# The shared libraries COLMAP's binary links, matching the list upstream's own runtime stage installs. Qt6 and MKL are
# in there because their build enables the GUI and uses MKL for BLAS; the CLI still needs both present to load, even
# though this worker never opens a window.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libboost-program-options1.83.0 libc6 libomp5 libopengl0 libmetis5 \
    libceres4t64 libopenimageio2.4t64 libgcc-s1 libgl1 libglew2.2 \
    libgoogle-glog0v6t64 \
    libqt6core6 libqt6gui6 libqt6widgets6 libqt6openglwidgets6 libqt6svg6 \
    libcurl4 libssl3t64 \
    libmkl-locale libmkl-intel-lp64 libmkl-intel-thread libmkl-core \
    && rm -rf /var/lib/apt/lists/*

# Only the binary, its data files, and the one shared library it links. Copying the whole /usr/local prefix instead
# costs about 4 GB: upstream's image carries its own 3.2 GB CUDA installation there, which a COPY would duplicate into a
# new layer rather than dedupe against the identical files this base image already has — and would overlay a runtime
# CUDA tree onto a devel one. libcudart and libOpenCL resolve from the base image's /usr/local/cuda either way. The
# static .a archives beside libonnxruntime are already linked into the binary, and the 357 MB CUDA execution provider is
# only consulted when running an ONNX model, which this SIFT-based pipeline does not.
#
# libonnxruntime lands in /usr/local/lib because that is where the binary's RPATH looks ($ORIGIN/../lib); no ldconfig
# needed.
COPY --from=colmap /usr/local/bin/colmap /usr/local/bin/colmap
COPY --from=colmap /usr/local/share/colmap /usr/local/share/colmap
COPY --from=colmap /usr/local/lib/libonnxruntime.so* /usr/local/lib/

# worker/pipeline/train.py's densify_and_prune reallocates all five Gaussian-model tensors at a new size on every
# call, so their old blocks return to PyTorch's caching allocator at a size nothing new needs. Over several
# densification rounds within one training run, that fragments the cache into pieces too small individually to
# satisfy a later allocation even when their sum is enough. expandable_segments lets the allocator grow one segment
# instead of hunting for a contiguous block, which is what PyTorch's own CUDA OOM message recommends when "reserved
# but unallocated" memory is large.
ENV PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

WORKDIR /app

# uv puts the interpreter outside the venv and points /app/.venv/bin/python at it by absolute path, so copying only
# .venv leaves a dangling symlink and no working Python. Both directories have to travel, at the same paths.
COPY --from=build /root/.local/share/uv/python /root/.local/share/uv/python
COPY --from=build /app/.venv /app/.venv

COPY pipeline/ ./pipeline/
COPY run_job.py ./

ENV PATH="/app/.venv/bin:${PATH}"
CMD ["python3", "run_job.py"]
