# Kay-cftunnle 面板 · Docker 多阶段构建
# 基于 Python 3.13 slim：项目只用标准库，零 pip 依赖
#
# 基础镜像可替换（国内网络拉不动 Docker Hub 时用）：
#   docker build \
#     --build-arg PY_BASE_IMAGE=docker.m.daocloud.io/library/python:3.13-slim \
#     --build-arg CF_IMAGE=docker.m.daocloud.io/cloudflare/cloudflared:latest \
#     -t kaycftunnle:latest .
#
# 注意：ARG 必须声明在第一个 FROM 之前，才能在后续所有 FROM 中使用。

ARG PY_BASE_IMAGE=python:3.13-slim
ARG CF_IMAGE=cloudflare/cloudflared:latest

# ---------------------------------------------------------------- 运行基础层
FROM ${PY_BASE_IMAGE} AS runtime

ENV TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# 替换 Debian apt 源为国内镜像，避免从 deb.debian.org 慢速拉取
RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources; \
    fi; \
    if [ -f /etc/apt/sources.list ]; then \
        sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends tzdata ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---------------------------------------------------------------- cloudflared 二进制
# 从官方镜像复制，不依赖 GitHub 网络，构建更稳定，且天然多架构
FROM ${CF_IMAGE} AS cloudflared

# ---------------------------------------------------------------- 最终镜像
FROM runtime AS final

COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
RUN set -eux; \
    chmod +x /usr/local/bin/cloudflared; \
    cloudflared --version

# 应用代码：必须与项目根目录同源，且逐个显式 COPY
# 注意：COPY 位于 FROM final 之后，才会作用在最终镜像上；
#       若把 COPY 写在中间阶段，最终镜像里将缺少这些文件。
COPY server.py cf.py /app/
COPY static/ /app/static/

# 构建期断言：确认关键文件确实进了镜像，避免"构建成功但运行缺文件"
RUN set -eux; \
    test -f /app/server.py || (echo "缺少 /app/server.py" >&2; exit 1); \
    test -f /app/cf.py     || (echo "缺少 /app/cf.py" >&2; exit 1); \
    test -f /app/static/index.html || (echo "缺少 /app/static/index.html" >&2; exit 1); \
    test -f /app/static/app.js     || (echo "缺少 /app/static/app.js" >&2; exit 1); \
    python -c "import ast,sys; ast.parse(open('/app/server.py',encoding='utf-8').read())" || \
      (echo "server.py 语法错误" >&2; exit 1); \
    python -c "import ast,sys; ast.parse(open('/app/cf.py',encoding='utf-8').read())" || \
      (echo "cf.py 语法错误" >&2; exit 1); \
    echo "代码自检通过"

# data/、runtime/ 由运行时 volume 挂载提供，不打进镜像
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1

CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "8000"]
