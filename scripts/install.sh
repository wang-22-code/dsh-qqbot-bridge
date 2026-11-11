#!/bin/sh
# dsh-qqbot-bridge 一键安装
#
# 走 dsh CLI 的 profile 插件机制：`add` 自动初始化 profile（首层
# dsh-base），pnpm 安装后按 dsh.bundle.patch 元数据把本包追加为 bundle 层。
# 无需 DSH 源码，无需 workspace 链接。
#
# 用法：
#   sh scripts/install.sh                                            # 安装默认包最新版本
#   sh scripts/install.sh --version 0.2.0                            # 指定版本
#   sh scripts/install.sh --pkg @myorg/my-plugin                     # 指定包名
#   sh scripts/install.sh --pkg @myorg/my-plugin --version 1.0.0     # 指定包名+版本
#   sh scripts/install.sh --registry https://registry.npmmirror.com  # 指定 npm registry
set -eu

# ── 默认值 ──
PACKAGE="dsh-qqbot-bridge"
VERSION=""
REGISTRY=""
PROFILE="qqbot"

# ── 参数解析 ──
while [ $# -gt 0 ]; do
  case "$1" in
    --pkg)
      shift; PACKAGE="$1" ;;
    --pkg=*)
      PACKAGE="${1#--pkg=}" ;;
    --version)
      shift; VERSION="$1" ;;
    --version=*)
      VERSION="${1#--version=}" ;;
    --registry)
      shift; REGISTRY="$1" ;;
    --registry=*)
      REGISTRY="${1#--registry=}" ;;
    --profile)
      shift; PROFILE="$1" ;;
    --profile=*)
      PROFILE="${1#--profile=}" ;;
    -h|--help)
      echo "用法: sh scripts/install.sh [选项]"
      echo
      echo "选项:"
      echo "  --pkg <name>        指定 npm 包名 (默认: dsh-qqbot-bridge)"
      echo "  --version <ver>     指定包版本 (默认: latest)"
      echo "  --registry <url>    指定 npm registry"
      echo "  --profile <name>    指定 dsh profile 名 (默认: qqbot)"
      echo "  -h, --help          显示帮助"
      exit 0
      ;;
    *)
      echo "未知参数: $1 (使用 --help 查看用法)" >&2
      exit 1
      ;;
  esac
  shift
done

# ── 预检 ──
if ! command -v dsh >/dev/null 2>&1; then
  echo "未检测到 dsh CLI。先安装：" >&2
  echo "  npm install -g @deepseek-ai/dsh" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "未检测到 pnpm。dsh plugin 依赖 pnpm，请先安装：" >&2
  echo "  npm install -g pnpm" >&2
  exit 1
fi

# ── 构造安装标识 ──
INSTALL_SPEC="$PACKAGE"
if [ -n "$VERSION" ]; then
  INSTALL_SPEC="${PACKAGE}@${VERSION}"
fi

REGISTRY_ARG=""
if [ -n "$REGISTRY" ]; then
  REGISTRY_ARG="--registry ${REGISTRY}"
fi

# ── 安装 ──
echo "=================================================="
echo "  安装 QQ Bot 插件到 dsh"
echo "=================================================="
echo
echo "  包名:     ${INSTALL_SPEC}"
echo "  Profile:  ${PROFILE}"
[ -n "$REGISTRY" ] && echo "  Registry: ${REGISTRY}"
echo

dsh plugin --profile "$PROFILE" add "$INSTALL_SPEC" $REGISTRY_ARG

echo
echo "=================================================="
echo "  安装完成"
echo "=================================================="
echo
echo "确保 DSH 的用户 .env 已配置模型 API Key。"
echo "QQ 凭据无需写入仓库：首次启动会显示腾讯官方绑定二维码，"
echo "扫码后 AppID、Secret 和扫码用户 OpenID 会自动写入 \$DSH_HOME/.env。"
echo
echo "启动："
echo "  dsh --profile ${PROFILE}"
echo
