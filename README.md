# omp-magpie-remote

让 [oh-my-pi（omp）](https://github.com/oh-my-pi/oh-my-pi) 使用另一台机器上运行的 [Magpie](https://github.com/yetone/magpie) 网关：通过 `/login` 填入网关地址和 gateway key，Magpie 上的模型就会出现在 `/model` 中，底部状态栏还会显示当前模型对应供应商的额度。

- **远程模型**：注册 `magpie-remote` 供应商，按模型原生接口选择 Responses / Messages / Chat Completions，并支持 OpenAI 推理强度。
- **自动刷新**：登录时保存模型列表快照，omp 刷新 OAuth 凭据时更新目录；远端不可达时保留已有快照。
- **额度显示**：状态栏显示当前模型对应供应商的额度；`/usage` 查看所有已登录供应商的额度。
- **零运行时依赖**：只有类型导入，运行时没有额外依赖。

Pi 用户请使用 [pi-magpie-remote](https://github.com/LiangNiang/pi-magpie-remote)。

## 安装

```sh
omp install github:LiangNiang/omp-magpie-remote
```

本地试用：

```sh
omp -e ./omp-magpie-remote
```

## 配置 Magpie

在运行 Magpie 的机器上：

1. 开启 **设置 → 局域网共享（Share on local network）**。
2. 运行 `magpie gateway-key add` 创建一个 gateway key。

记下从 omp 所在机器能访问到的地址（例如 `http://192.168.1.20:3425`）和刚创建的 key。

## 使用

在 omp 中运行 `/login`，选择 **Magpie (remote)**，依次输入网关地址和 gateway key。地址带不带 `/v1` 都可以。登录成功后，连接信息和模型列表快照保存在 omp 的本地凭据库中。

使用 `/model` 选择一个模型。模型会按 Magpie 提供的原生接口使用 Responses、Messages 或 Chat Completions；Anthropic 模型的 thinking 能力由 omp 按模型目录推断。

选中 Magpie 模型后，底部状态栏显示当前模型所属供应商在 Magpie 上的额度：

- 订阅 / 套餐显示各窗口已用百分比，例如 `codex 5h 32% · 7d 71%`；
- 按量付费的 key 显示余额，例如 `deepseek ¥23.40`；
- 同一供应商有多个账号时，优先显示最近一次经网关服务的账号，`+N` 表示还有 N 个账号。

状态会在会话开始、回复结束时刷新（最多每分钟拉取一次）。`/usage` 展示 Magpie 和其他已登录供应商的额度。

如果登录失败，请检查地址、网络连通性、局域网共享开关以及 gateway key 是否有效。模型列表为空时登录仍会成功；远端添加模型后，重新登录以更新本地模型快照。

## 开发

```sh
bun install
bun run check   # 类型检查
bun test        # 单元测试
```

对正在使用的 Magpie 做只读冒烟测试（拉取模型列表和额度，并使用空请求体检查认证，不发送对话）：

```sh
MAGPIE_URL=http://192.168.1.20:3425 MAGPIE_GATEWAY_KEY=sk-magpie-... bun run smoke
```

未设置 `MAGPIE_URL` 时冒烟测试会跳过。
