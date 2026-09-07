# just
# 列出所有可用 recipe.
[private]
default:
    @just --list

# pnpm install
# 安装依赖.
install *args:
    pnpm install {{args}}

# node --test
# 运行测试.
test *args:
    node --test {{args}}
