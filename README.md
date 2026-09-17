# DSH Agent Preset: Mobile Use

[English](#english) | [中文说明](#中文说明)

---

<a name="中文说明"></a>
## 中文说明

`dsh-preset-mobile-use` 是专为 **DeepSeek Harness (DSH)** 深度定制的移动端自动化 Agent 预设（Preset）。

该预设使 DSH 具备原生的 **Android Mobile Use** 自主行动能力，直接通过大语言模型自主规划、视觉推理与无障碍树感知，在后台静默完成 Android 系统的各项自动化任务。

---

### 重要前置条件与硬性依赖（必读）

**本预设专门设计用于在已获得 Root 权限的 Android 手机上本地执行，不能脱离手机环境单独运行！**

1. **强依赖 KSU 底座模块**：
   - 本预设必须配合底层驱动模块 **[agent-mobile-use](https://github.com/AcidGr/agent-mobile-use)** 一起使用；
   - 必须先在手机上通过 **KernelSU / APatch / Magisk** 刷入 `agent-mobile-use-ksu-v3.5.zip`，并保持后台 `vd_server` 网关服务运行（默认监听 `http://127.0.0.1:3070`）。
2. **手机环境要求**：
   - **操作系统**：Android 15 / Android 16（实测实验环境基于 ColorOS 16，Linux 6.12 内核）；
   - **Root 与 Xposed**：手机必须拥有完整的 Root 特权，并建议启用 **LSPosed** 挂载模块内的隐形补丁以实现跨屏焦点隔离与免软键盘弹窗。

---

### 核心特性

- **完全后台静默 (Headless Execution)**：
  自动化应用在系统内存中的独立虚拟副屏（Display > 0）上渲染与操作，手机物理主屏不跳前台、不抢焦点、可以正常日常使用或息屏。
- **双模感知 (Dual Perception)**：
  提供结构化无障碍树解析（`mobile_dump_ui`）与实时副屏高分辨率快照（`mobile_screenshot`）。
- **智能滑动窗口图像上下文压缩 (Sliding-Window Image Offload)**：
  在多步操作过程中，预设会自动将历史轮次的截图替换为轻量占位符（`[Image offloaded]`），始终仅将最新的副屏快照送入多模态模型视觉编码，彻底消除多模态会话中 80k+ Token 累积导致的 40 秒以上推理延迟，同时确保 System Prompt 100% 命中 KV Cache。
- **免软键盘文字灌入 (Silent Text Injection)**：
  通过系统的无障碍剪贴板与原生文本注入，中英文长难句与符号一键送达，完全不在主屏弹出软键盘。

---

### 包含的 Agent 工具集

预设在 DSH 会话中注入了以下标准原子工具：

| 工具名称 | 功能描述 |
| :--- | :--- |
| `mobile_status` | 查询当前副屏运行状态、Display ID、宽度、高度与 DPI 参数 |
| `mobile_screenshot` | 截取副屏高精度 PNG 图像并自动执行滑动窗口上下文压缩 |
| `mobile_dump_ui` | 获取当前副屏结构化控件树与可点击节点中心绝对坐标 |
| `mobile_click` | 向指定 `(x, y)` 发送物理触控点击事件 |
| `mobile_swipe` | 模拟平滑滑动手势或长按操作 |
| `mobile_type` | 静默将文本灌入当前焦点输入框（0 键盘弹窗） |
| `mobile_press_key` | 向副屏发送物理按键（BACK, HOME, ENTER 等） |
| `mobile_launch_app` | 在副屏定向拉起目标应用或 Activity |
| `mobile_shell` | 在手机宿主环境中执行特权 Shell 命令 |
| `mobile_notify` | 向主屏发送通知栏提示或气泡提醒 |

---

### 安装与使用方法

1. **下载预设包**：
   从本仓库的 `release/` 目录或 GitHub Releases 页面下载 `dsh-preset-mobile-use.zip`（仅约 9 KB）。
2. **解压安装**：
   将压缩包内的 `mobile-use` 文件夹解压至手机中 DSH 的预设存放目录：
   ```sh
   mkdir -p ${DSH_HOME:-$HOME/.dsh}/.agent-presets/
   unzip dsh-preset-mobile-use.zip -d ${DSH_HOME:-$HOME/.dsh}/.agent-presets/
   ```
3. **启动会话**：
   刷新或重新打开 DSH Web 界面（`http://127.0.0.1:3080`），在右上角预设选择器中切换为 **`mobile-use`**，即可直接开始指挥手机执行自动化任务！

---

<a name="english"></a>
## English Description

`dsh-preset-mobile-use` is a specialized autonomous Mobile Use Agent Preset authored for **DeepSeek Harness (DSH)**.

It empowers the DSH Agent with native, background-headless **Android Mobile Use** capabilities, enabling vision-based planning, UI hierarchy parsing, and silent multi-step execution.

---

### Mandatory Prerequisites & Hard Dependency

**This preset is specifically engineered to run directly on a rooted Android device. It cannot be used on a bare desktop/server without the underlying Android system!**

1. **Underlying KSU Module Dependency**:
   - Requires the companion low-level driver module: **[agent-mobile-use](https://github.com/AcidGr/agent-mobile-use)**.
   - You must first flash `agent-mobile-use-ksu-v3.5.zip` via **KernelSU / APatch / Magisk** on your Android device and ensure the background `vd_server` gateway is active (default: `http://127.0.0.1:3070`).
2. **Target Device Environment**:
   - **OS**: Android 15 / 16 (Verified on ColorOS 16, Linux Kernel 6.12);
   - **Root & LSPosed**: Full Root privileges required; LSPosed recommended for window manager focus isolation and soft keyboard suppression.

---

### Key Features

- **100% Background Headless Execution**:
  Apps run and render entirely on an independent secondary Virtual Display (Display > 0). The physical display 0 remains completely undisturbed.
- **Dual Perception Engine**:
  Combines rapid accessibility node hierarchy dumps (`mobile_dump_ui`) with real-time visual screenshots (`mobile_screenshot`).
- **Sliding-Window Image Offload**:
  Automatically offloads older screenshot images into lean placeholders (`[Image offloaded]`), preserving KV cache hits for the static system prompt while avoiding the 40s+ multimodality inference lag caused by accumulating 80k+ image tokens.
- **Silent Text Injection**:
  Injects Chinese, numbers, symbols, and long paragraphs directly into the input target without popping up the on-screen soft keyboard.

---

### Preset Installation

1. Download `dsh-preset-mobile-use.zip` from `release/` or GitHub Releases.
2. Extract the `mobile-use` folder into your DSH presets directory:
   ```sh
   mkdir -p ${DSH_HOME:-$HOME/.dsh}/.agent-presets/
   unzip dsh-preset-mobile-use.zip -d ${DSH_HOME:-$HOME/.dsh}/.agent-presets/
   ```
3. Open the DSH Web UI (`http://127.0.0.1:3080`), select **`mobile-use`** from the preset dropdown in the top right, and start prompting!

---

## License

Released under the [MIT License](LICENSE).
